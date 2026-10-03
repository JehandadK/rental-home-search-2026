/**
 * Resumable, audited refresh of every portal and every derived data artifact.
 *
 *   npm run refresh                    incremental run from saved source state
 *   npm run refresh -- --deep          wider newest-first discovery
 *   npm run refresh -- --resume        continue the latest incomplete run
 *   npm run refresh -- --verbose       stream full collector output
 *   npm run refresh -- --concurrency N cap parallel sources (1 = sequential)
 *
 * Every stage is checkpointed in data/refresh-runs.json. Source collectors
 * remain independently atomic, so a failed portal retains its last successful
 * snapshot. A partial run still rebuilds from the valid snapshots, but exits 2
 * and can be resumed without rerunning already-successful earlier stages.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, MANIFEST_PATH, type BuildManifest } from "../src/storage/json/dataStore";
import { REPO_ROOT } from "../src/node/dataPaths";
import {
  acquireRefreshLock,
  latestResumableRun,
  markInterrupted,
  parseDiscovered,
  readRefreshLedger,
  saveRefreshRun,
  type RefreshRunRecord,
  type RefreshStageRecord,
} from "../src/refresh/refreshLedger";
import type { EnrichedListing } from "../src/domain/types";
import { NETWORK_STAGES, PARALLEL_COLLECTOR_STAGES, collectorGroup, planRefresh, runLimited, stageEnv } from "../src/refresh/refreshPlan";
import { DEFAULT_INCREMENTAL_PAGE_CEILING, positiveInteger } from "../src/collectors/shared/pageBudget";

const ROOT = REPO_ROOT;
const argv = process.argv.slice(2);
const requestedDeep = argv.includes("--deep");
const requestedSkipNifty = argv.includes("--skip-nifty");
const requestedSkipRoomspot = argv.includes("--skip-roomspot");
const resume = argv.includes("--resume");
const verbose = argv.includes("--verbose");
const planOnly = argv.includes("--plan");
const prepareOnly = argv.includes("--prepare");
const localOnly = argv.includes("--local-only");
const flag = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const onlyStage = flag("--only");
let pageBudget = positiveInteger(flag("--max-pages"), requestedDeep ? 100 : DEFAULT_INCREMENTAL_PAGE_CEILING);
let detailBudget = positiveInteger(flag("--detail-limit"), 0, 0);
// Collectors run concurrently by default; `--concurrency 1` restores one-at-a-time order.
const concurrency = positiveInteger(flag("--concurrency"), 4);

interface StageDefinition {
  id: string;
  label: string;
  args: string[];
  /** Portal failure is recoverable because its last atomic snapshot remains valid. */
  recoverable?: boolean;
  skipped?: boolean;
  env?: Record<string, string>;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function definitions(deep: boolean, skipNifty: boolean, skipRoomspot = false): StageDefinition[] {
  const crawlArgs = (city?: string) => [
    "run", "crawl:nifty", "--",
    ...(city ? ["--city", city] : []),
    "--pages", String(pageBudget), "--merge",
    ...(deep ? ["--deep"] : []),
  ];
  return [
    { id: "suumo", label: "SUUMO", args: ["run", "scrape", "--", "--max-pages", String(pageBudget), ...(deep ? ["--deep"] : [])], recoverable: true },
    // Retained only for compatibility with old checkpoints. Detail enrichment
    // now runs after all list collectors and selects cross-source unique units.
    { id: "suumo-parking", label: "Legacy parking pass", args: [], skipped: true },
    { id: "athome", label: "AtHome", args: ["run", "scrape:athome", "--", "--max-pages", String(pageBudget), ...(deep ? ["--deep"] : [])], recoverable: true },
    { id: "roomspot", label: "RoomSpot", args: ["run", "scrape:roomspot", "--", "--max-pages", String(pageBudget), ...(deep ? ["--deep"] : [])], recoverable: true, skipped: skipRoomspot },
    { id: "nifty-soka", label: "Nifty Soka", args: crawlArgs(), recoverable: true, skipped: skipNifty, env: { NIFTY_BATCH_SIZE: "10" } },
    { id: "nifty-koshigaya", label: "Nifty Koshigaya", args: crawlArgs("koshigayashi_ct"), recoverable: true, skipped: skipNifty, env: { NIFTY_BATCH_SIZE: "10" } },
    { id: "nifty-kawaguchi", label: "Nifty Kawaguchi", args: crawlArgs("kawaguchishi_ct"), recoverable: true, skipped: skipNifty, env: { NIFTY_BATCH_SIZE: "10" } },
    { id: "nifty-import", label: "Nifty import", args: ["run", "import:nifty"], recoverable: true, skipped: skipNifty },
    { id: "detail-enrich", label: "Optional details", args: ["run", "detail:enrich", "--", "--limit", String(detailBudget)], recoverable: true, skipped: detailBudget === 0 },
    { id: "data-build", label: "Merge/deduplicate", args: ["run", "data:build"] },
    { id: "enrich", label: "Geocode/enrich", args: ["run", "enrich"] },
    { id: "web-data", label: "Web payload", args: ["run", "data:web"] },
  ];
}

async function currentTotal(): Promise<number> {
  try {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as BuildManifest;
    return manifest.total;
  } catch {
    return 0;
  }
}

function freshRun(defs: StageDefinition[], beforeTotal: number): RefreshRunRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `${now.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    startedAt: now,
    updatedAt: now,
    status: "running",
    mode: requestedDeep ? "deep" : "incremental",
    skipNifty: requestedSkipNifty,
    skipRoomspot: requestedSkipRoomspot,
    limits: { pagesPerCity: pageBudget, detailRequests: detailBudget },
    invocations: [{ startedAt: now, resume: false }],
    beforeTotal,
    stages: defs.map((stage) => ({
      id: stage.id,
      label: stage.label,
      status: stage.skipped ? "skipped" : "pending",
      detail: stage.skipped ? "Disabled by refresh policy/options" : undefined,
      attempts: [],
    })),
  };
}

function detailFrom(output: string): string {
  return output.trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
}

async function executeStage(
  definition: StageDefinition,
  stage: RefreshStageRecord,
  run: RefreshRunRecord,
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  stage.status = "running";
  stage.startedAt = startedAt;
  stage.completedAt = undefined;
  stage.durationMs = undefined;
  stage.detail = undefined;
  stage.attempts.push({ startedAt, completedAt: "", durationMs: 0, exitCode: null, status: "failed" });
  run.status = "running";
  run.completedAt = undefined;
  run.updatedAt = startedAt;
  await saveRefreshRun(run);

  const child = spawn(npm, definition.args, {
    cwd: ROOT,
    // Only AtHome launches the persistent Playwright profile, so parallel collectors never contend for it.
    env: stageEnv(definition.id, { ...process.env, ...definition.env }),
  });
  let stdout = "", stderr = "";
  // Prefix streamed lines so concurrent collectors stay attributable.
  const stream = (target: NodeJS.WriteStream, chunk: Buffer | string) =>
    target.write(String(chunk).replace(/\n$/, "").split("\n").map((line) => `[${definition.id}] ${line}\n`).join(""));
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (verbose) stream(process.stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (verbose) stream(process.stderr, chunk);
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      stderr += `Unable to start command: ${error.message}`;
      resolve(null);
    });
    child.once("close", resolve);
  });
  const completedAt = new Date().toISOString();
  const output = `${stdout}\n${stderr}`;
  const discovered = parseDiscovered(output);
  const detail = exitCode === 0 ? undefined : detailFrom(stderr || stdout);
  const attempt = stage.attempts.at(-1)!;
  Object.assign(attempt, {
    completedAt,
    durationMs: Date.now() - startedMs,
    exitCode,
    status: exitCode === 0 ? "success" : "failed",
    discovered,
    detail,
  });
  Object.assign(stage, {
    status: exitCode === 0 ? "success" : "failed",
    completedAt,
    durationMs: attempt.durationMs,
    exitCode,
    discovered,
    detail,
  });
  run.updatedAt = completedAt;
  await saveRefreshRun(run);

  if (exitCode === 0) {
    console.log(`${definition.label.padEnd(20)} ${discovered == null ? "OK" : `${discovered} new`}`);
    return true;
  }
  console.log(`${definition.label.padEnd(20)} ${definition.recoverable ? "FAILED (saved snapshot retained)" : "FAILED"}${detail ? ` — ${detail.slice(0, 140)}` : ""}`);
  return false;
}

async function finalize(run: RefreshRunRecord): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as BuildManifest;
  const listings = JSON.parse(await readFile(join(DATA_DIR, "listings.json"), "utf8")) as EnrichedListing[];
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = listings.filter((listing) =>
    listing.status !== "sold" && listing.firstSeenAt != null && Date.parse(listing.firstSeenAt) >= oneDayAgo,
  );
  const bySource: Record<string, number> = {};
  for (const listing of recent) bySource[listing.source] = (bySource[listing.source] ?? 0) + 1;

  const failed = run.stages.filter((stage) => stage.status !== "success" && stage.status !== "skipped");
  run.afterTotal = manifest.total;
  run.netUniqueAdded = run.stages.find((stage) => stage.id === "data-build")?.attempts
    .filter((attempt) => attempt.status === "success").reduce((sum, attempt) => sum + (attempt.discovered ?? 0), 0)
    ?? Math.max(0, manifest.total - run.beforeTotal);
  run.duplicatesDropped = manifest.duplicatesDropped;
  run.lifecycle = manifest.lifecycle;
  run.recent24h = { total: recent.length, bySource };
  run.completedAt = new Date().toISOString();
  run.updatedAt = run.completedAt;
  run.status = failed.length ? "partial" : "success";
  await saveRefreshRun(run);

  const duration = Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000);
  console.log(
    `\n${run.status === "success" ? "Done" : "Partial"}: ${manifest.total} total · ` +
      `${run.netUniqueAdded} unique added after dedup · ${manifest.duplicatesDropped} source duplicates merged · ` +
      `${recent.length} first seen in past 24h · ${duration}s · run ${run.id}`,
  );
  if (failed.length) {
    console.log(`Resume needed: ${failed.map((stage) => stage.label).join(", ")} — run \`npm run refresh -- --resume\``);
    process.exitCode = 2;
  }
}

// Read-only planning never acquires a lock, edits a checkpoint, or loads a page.
if (planOnly) {
  const checkpoint = resume ? latestResumableRun(await readRefreshLedger()) : undefined;
  if (resume && !checkpoint) throw new Error("There is no incomplete refresh run to resume.");
  if (checkpoint?.limits && !flag("--max-pages")) pageBudget = checkpoint.limits.pagesPerCity;
  if (checkpoint?.limits && !flag("--detail-limit")) detailBudget = checkpoint.limits.detailRequests;
  const defs = definitions(checkpoint?.mode === "deep" || requestedDeep, checkpoint?.skipNifty ?? requestedSkipNifty, checkpoint ? checkpoint.skipRoomspot ?? false : requestedSkipRoomspot);
  const stages = defs.map((d) => checkpoint?.stages.find((s) => s.id === d.id) ?? {
    id: d.id, label: d.label, status: d.skipped ? "skipped" as const : "pending" as const, attempts: [],
  });
  const planned = planRefresh(stages, resume);
  console.log(`Offline plan · newest-first until 2 all-known pages (emergency ceiling ${pageBudget}/city/source) · <=${detailBudget} optional SUUMO details`);
  for (const stage of stages) console.log(`${stage.id.padEnd(20)} ${planned.has(stage.id) ? localOnly && NETWORK_STAGES.has(stage.id) ? "WAIT (native browser / network collector)" : "RUN" : "REUSE / DISABLED"}`);
  process.exit(0);
}

let releaseLock: (() => Promise<void>) | undefined;
try {
  releaseLock = await acquireRefreshLock();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
let activeRun: RefreshRunRecord | undefined;
let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  if (activeRun) {
    markInterrupted(activeRun);
    await saveRefreshRun(activeRun).catch(() => undefined);
  }
  await releaseLock?.();
  console.error(`\nRefresh interrupted by ${signal}; checkpoint saved. Resume with \`npm run refresh -- --resume\`.`);
  process.exit(130);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  const ledger = await readRefreshLedger();
  for (const oldRun of ledger.runs.filter((item) => item.status === "running")) {
    markInterrupted(oldRun);
    await saveRefreshRun(oldRun);
  }

  if (resume) {
    const checkpoint = latestResumableRun(await readRefreshLedger());
    if (!checkpoint) throw new Error("There is no incomplete refresh run to resume.");
    activeRun = checkpoint;
    if (checkpoint.limits && !flag("--max-pages")) pageBudget = checkpoint.limits.pagesPerCity;
    if (checkpoint.limits && !flag("--detail-limit")) detailBudget = checkpoint.limits.detailRequests;
    const now = new Date().toISOString();
    activeRun.invocations.push({ startedAt: now, resume: true });
    activeRun.updatedAt = now;
    activeRun.status = "running";
    activeRun.completedAt = undefined;
    console.log(`Resuming run ${activeRun.id} (${activeRun.mode})`);
  } else {
    const defs = definitions(requestedDeep, requestedSkipNifty, requestedSkipRoomspot);
    activeRun = freshRun(defs, await currentTotal());
    console.log(`Starting run ${activeRun.id} (${activeRun.mode})`);
  }
  await saveRefreshRun(activeRun);

  if (prepareOnly) {
    activeRun.status = "partial";
    await saveRefreshRun(activeRun);
    console.log("Checkpoint prepared for native-browser captures; no collectors or builds executed.");
  } else {
  const defs = definitions(activeRun.mode === "deep", activeRun.skipNifty, activeRun.skipRoomspot);
  if (onlyStage && !defs.some((d) => d.id === onlyStage)) throw new Error(`Unknown stage: ${onlyStage}`);
  // Match by stable ID: newly added optional stages do not invalidate old runs.
  activeRun.stages = defs.map((d) => activeRun!.stages.find((s) => s.id === d.id) ?? {
    id: d.id, label: d.label, status: d.skipped ? "skipped" : "pending", attempts: [],
  });
  const planned = planRefresh(activeRun.stages, resume);
  let mandatoryFailure = false;
  const queue: Array<{ definition: StageDefinition; stage: RefreshRunRecord["stages"][number] }> = [];
  for (let i = 0; i < defs.length; i++) {
    const definition = defs[i];
    const stage = activeRun.stages[i];
    if (definition.skipped || !planned.has(stage.id) || (onlyStage && stage.id !== onlyStage)) continue;
    if (localOnly && NETWORK_STAGES.has(stage.id)) {
      console.log(`${definition.label.padEnd(20)} deferred (portal collection disabled)`);
      continue;
    }
    queue.push({ definition, stage });
  }
  // Independent portal collectors first. Sources run concurrently; stages that share a
  // source file (Nifty cities) run in order inside their group. Failures are recoverable.
  const groups = new Map<string, typeof queue>();
  for (const item of queue.filter(({ stage }) => PARALLEL_COLLECTOR_STAGES.has(stage.id))) {
    const key = collectorGroup(item.stage.id);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  if (groups.size > 1 && concurrency > 1) {
    console.log(`Running ${groups.size} sources in parallel (max ${concurrency}): ${[...groups.keys()].join(", ")}`);
  }
  await runLimited([...groups.values()], concurrency, async (items) => {
    for (const { definition, stage } of items) await executeStage(definition, stage, activeRun!);
  });
  for (const { definition, stage } of queue) {
    if (PARALLEL_COLLECTOR_STAGES.has(stage.id)) continue;
    const ok = await executeStage(definition, stage, activeRun);
    if (!ok && !definition.recoverable) {
      mandatoryFailure = true;
      break;
    }
  }

  if (mandatoryFailure) {
    activeRun.status = "failed";
    activeRun.completedAt = new Date().toISOString();
    activeRun.updatedAt = activeRun.completedAt;
    await saveRefreshRun(activeRun);
    console.error(`Refresh stopped; resume from the failed stage with \`npm run refresh -- --resume\`.`);
    process.exitCode = 1;
  } else {
    await finalize(activeRun);
  }
  }
} catch (error) {
  if (activeRun && activeRun.status === "running") {
    activeRun.status = "failed";
    activeRun.completedAt = new Date().toISOString();
    activeRun.updatedAt = activeRun.completedAt;
    await saveRefreshRun(activeRun).catch(() => undefined);
  }
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await releaseLock?.();
}
