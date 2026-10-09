import { existsSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../storage/json/dataStore";
import { updateJsonFile } from "../node/jsonFile";

export const REFRESH_LEDGER_PATH = join(DATA_DIR, "refresh-runs.json");
export const REFRESH_LOCK_PATH = join(DATA_DIR, ".refresh.lock");
const MAX_RUNS = 100;

export type RefreshRunStatus = "running" | "success" | "partial" | "failed" | "interrupted";
export type RefreshStageStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface RefreshAttempt {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  status: "success" | "failed";
  discovered?: number;
  detail?: string;
}

export interface RefreshStageRecord {
  id: string;
  label: string;
  status: RefreshStageStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  discovered?: number;
  detail?: string;
  attempts: RefreshAttempt[];
}

export interface RefreshRunRecord {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: RefreshRunStatus;
  mode: "incremental" | "deep";
  skipNifty: boolean;
  /** Skip collection only; preserve the existing RoomSpot source in builds. */
  skipRoomspot?: boolean;
  limits?: { pagesPerCity: number; detailRequests: number };
  invocations: Array<{ startedAt: string; resume: boolean }>;
  beforeTotal: number;
  afterTotal?: number;
  netUniqueAdded?: number;
  duplicatesDropped?: number;
  lifecycle?: { continued: number; added: number; sold: number; reactivated: number };
  recent24h?: { total: number; bySource: Record<string, number> };
  stages: RefreshStageRecord[];
}

export interface RefreshLedger {
  schemaVersion: 1;
  runs: RefreshRunRecord[];
}

export async function readRefreshLedger(): Promise<RefreshLedger> {
  if (!existsSync(REFRESH_LEDGER_PATH)) return { schemaVersion: 1, runs: [] };
  try {
    const parsed = JSON.parse(await readFile(REFRESH_LEDGER_PATH, "utf8")) as RefreshLedger;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.runs)) throw new Error("unsupported schema");
    return parsed;
  } catch (error) {
    throw new Error(`Cannot read ${REFRESH_LEDGER_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveRefreshRun(run: RefreshRunRecord): Promise<void> {
  await updateJsonFile<RefreshLedger>(
    REFRESH_LEDGER_PATH,
    () => ({ schemaVersion: 1, runs: [] }),
    (ledger) => {
      const index = ledger.runs.findIndex((item) => item.id === run.id);
      if (index >= 0) ledger.runs[index] = run;
      else ledger.runs.push(run);
      ledger.runs = ledger.runs.slice(-MAX_RUNS);
      return ledger;
    },
  );
}

export function latestResumableRun(ledger: RefreshLedger): RefreshRunRecord | undefined {
  const latest = ledger.runs.at(-1);
  return latest && latest.status !== "success" ? latest : undefined;
}

/** Convert a process left running by a crash/interrupt into an explicit checkpoint. */
export function markInterrupted(run: RefreshRunRecord, now = new Date().toISOString()): RefreshRunRecord {
  if (run.status !== "running" && !run.stages.some((stage) => stage.status === "running")) return run;
  for (const stage of run.stages) {
    if (stage.status !== "running") continue;
    stage.status = "failed";
    stage.completedAt = now;
    stage.detail = "Interrupted before the stage reported completion";
    const attempt = stage.attempts.at(-1);
    if (attempt && !attempt.completedAt) {
      attempt.completedAt = now;
      attempt.durationMs = Date.parse(now) - Date.parse(attempt.startedAt);
      attempt.exitCode = null;
      attempt.status = "failed";
      attempt.detail = stage.detail;
    }
  }
  run.status = "interrupted";
  run.completedAt = now;
  run.updatedAt = now;
  return run;
}

export function parseDiscovered(output: string): number | undefined {
  const patterns = [
    /Discovered (\d+) new/i,
    /fetching (\d+) new/i,
    /Lifecycle[^\n]*?, (\d+) NEW/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export async function acquireRefreshLock(): Promise<() => Promise<void>> {
  try {
    // `wx` is the concurrency boundary: unlike exists-then-create, this cannot
    // allow two refresh processes through a check/write race.
    const handle = await open(REFRESH_LOCK_PATH, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    await handle.close();
    return async () => unlink(REFRESH_LOCK_PATH).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let lock: { pid?: number; startedAt?: string };
  try {
    lock = JSON.parse(await readFile(REFRESH_LOCK_PATH, "utf8")) as typeof lock;
  } catch {
    throw new Error(`Refresh lock ${REFRESH_LOCK_PATH} exists but is unreadable; verify no refresh is running before removing it.`);
  }
  if (!lock.pid) {
    throw new Error(`Refresh lock ${REFRESH_LOCK_PATH} has no PID; verify no refresh is running before removing it.`);
  }
  try {
    process.kill(lock.pid, 0);
    throw new Error(`Refresh already running as PID ${lock.pid} since ${lock.startedAt ?? "an unknown time"}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || code === "EPERM") throw error; // live process, or our deliberate error above
    if (code !== "ESRCH") throw error;
  }

  // The owner no longer exists. Remove its stale lock and retry the atomic
  // acquisition; another contender may still win, which is handled normally.
  await unlink(REFRESH_LOCK_PATH);
  return acquireRefreshLock();
}
