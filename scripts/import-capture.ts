/**
 * Import native-browser public captures; no browser control or network in this script.
 * Each validated page is parsed and submitted to the public ingestion boundary, which
 * owns source reads, freshness, matching, merges and the atomic source/journal commit.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { saveCapture, type PageCapture, CAPTURE_DIR } from "../src/collectors/shared/captureStore";
import { BACKUP_DIR, JsonSourceStore, atomicWriteJson, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import type { CaptureRunSummary, NativeCaptureIngestion } from "../src/data-layer/ingestion/contracts";
import { listCaptureBatch } from "../src/collectors/shared/listCaptureBatch";
import { acquireRefreshLock, latestResumableRun, readRefreshLedger, saveRefreshRun, type RefreshLedger, type RefreshRunRecord } from "../src/refresh/refreshLedger";
import { DEFAULT_INCREMENTAL_PAGE_CEILING, DEPENDENCIES, positiveInteger } from "../src/refresh/refreshPlan";

interface Progress { imported: string[]; cities: Record<string, { pages: number; knownPages: number; added: number; updatedAt: string; done: boolean }> }
type NativeCapture = PageCapture & { sortedNewest?: boolean };
const SOURCES = ["athome", "roomspot", "nifty", "suumo"] as const;

export interface CaptureImportDependencies {
  ingestion: NativeCaptureIngestion;
  captureDir: string;
  saveCapture(capture: PageCapture): Promise<unknown>;
  acquireLock(): Promise<() => Promise<void>>;
  readLedger(): Promise<RefreshLedger>;
  saveRun(run: RefreshRunRecord): Promise<void>;
  writeProgress(path: string, progress: Progress): Promise<void>;
  log(message: string): void;
  error(message: string): void;
}

/** Returns the process exit code: 2 when the export itself reported failed captures. */
export async function runCaptureImport(args: readonly string[], dependencies: CaptureImportDependencies): Promise<number> {
  const input = args[args.indexOf("--file") + 1];
  if (!args.includes("--file") || !input) throw new Error("Usage: npm run capture:import -- --file <native-browser-export.json> [--max-pages N]");
  const maxPages = positiveInteger(
    args.includes("--max-pages") ? args[args.indexOf("--max-pages") + 1] : undefined,
    DEFAULT_INCREMENTAL_PAGE_CEILING,
  );
  const envelope = JSON.parse(await readFile(input, "utf8")) as { captures: NativeCapture[]; errors?: string[] };
  if (!Array.isArray(envelope.captures)) throw new Error("Expected captures array");
  const release = await dependencies.acquireLock();
  try {
    const ledger = await dependencies.readLedger();
    const requestedRun = args.includes("--run-id") ? args[args.indexOf("--run-id") + 1] : undefined;
    const run = requestedRun ? ledger.runs.find((r) => r.id === requestedRun) : latestResumableRun(ledger);
    if (requestedRun && !run) throw new Error("Unknown run ID");
    const progressId = run?.id ?? new Date().toISOString().slice(0, 10);
    const progressPath = join(dependencies.captureDir, `progress-${progressId}.json`);
    let progress: Progress = { imported: [], cities: {} };
    try { progress = JSON.parse(await readFile(progressPath, "utf8")) as Progress; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    for (const c of envelope.captures) {
      if (!(SOURCES as readonly string[]).includes(c.source)) throw new Error("Unsupported list source");
      if (!["Soka", "Koshigaya", "Kawaguchi"].includes(c.city)) throw new Error("Unknown city");
      await dependencies.saveCapture(c);
      const receipt = createHash("sha256").update(c.url + c.capturedAt + c.html).digest("hex");
      if (progress.imported.includes(receipt)) { dependencies.log(`${c.source}/${c.city} p${c.page}: already imported`); continue; }
      const key = `${c.source}/${c.city}`;
      const prior = progress.cities[key];
      if (c.page !== (prior?.pages ?? 0) + 1) throw new Error(`${key}: expected page ${(prior?.pages ?? 0) + 1}, got ${c.page}; replay missing pages before completing a city`);
      // The receipt doubles as the batch ID. If a source commit succeeded but the
      // progress write did not, the retry replays the journaled original effects.
      const result = await dependencies.ingestion.ingestScrape(await listCaptureBatch(c, { runId: progressId, receipt }));
      if (!result.effect) throw new Error(`${key} p${c.page}: ingestion receipt has no recorded effects; cannot checkpoint progress`);
      const { added, updated, novel, observedCount } = result.effect;
      const knownPages = c.sortedNewest && observedCount > 0 && novel === 0 ? (prior?.knownPages ?? 0) + 1 : 0;
      progress.cities[key] = { pages: (prior?.pages ?? 0) + 1, knownPages, added: (prior?.added ?? 0) + added, updatedAt: c.capturedAt, done: knownPages >= 2 || c.page >= maxPages };
      progress.imported.push(receipt);
      await dependencies.writeProgress(progressPath, progress); // every validated page survives later failures
      dependencies.log(`${key} p${c.page}: ${observedCount} family rows; ${added} added; ${updated} refreshed; ${progress.cities[key].done ? "STOP (overlap/budget; not complete market)" : "continue"}`);
    }
    // Source metadata describes this capture run, not the previous day's crawl.
    for (const source of SOURCES) {
      const cities = Object.entries(progress.cities).filter(([key]) => key.startsWith(source + "/"));
      if (!cities.length) continue;
      const summary: CaptureRunSummary = { schemaVersion: 1, source, ...(run ? { captureRunId: run.id } : {}),
        cities: cities.map(([key, city]) => ({ city: key.split("/")[1], pages: city.pages, added: city.added })) };
      await dependencies.ingestion.annotateCaptureRun(summary);
    }
    if (run) {
      const groups: Array<[string, string[]]> = [["suumo", ["suumo/Soka", "suumo/Koshigaya", "suumo/Kawaguchi"]], ["athome", ["athome/Soka", "athome/Koshigaya", "athome/Kawaguchi"]], ["roomspot", ["roomspot/Soka", "roomspot/Koshigaya", "roomspot/Kawaguchi"]], ...["Soka", "Koshigaya", "Kawaguchi"].map((c): [string, string[]] => [`nifty-${c.toLowerCase()}`, [`nifty/${c}`]])];
      for (const [source, cityKeys] of groups) {
        const cities = cityKeys.map((key) => progress.cities[key]);
        if (!cities.every((city) => city?.done)) continue;
        const stage = run.stages.find((s) => s.id === source);
        if (!stage || stage.status === "success") continue;
        const now = new Date().toISOString();
        const startedAt = cities.map((c) => c.updatedAt).sort()[0];
        const discovered = cities.reduce((n, c) => n + c.added, 0);
        Object.assign(stage, { status: "success", completedAt: now, startedAt, discovered, exitCode: 0, detail: "Validated native-browser captures; bounded discovery, no removal claims" });
        stage.attempts.push({ startedAt, completedAt: now, durationMs: Date.parse(now) - Date.parse(startedAt), exitCode: 0, status: "success", discovered });
        const dirty = new Set([source]);
        for (const s of run.stages) if ((DEPENDENCIES[s.id] ?? []).some((d) => dirty.has(d)) && s.status !== "skipped") { s.status = "pending"; dirty.add(s.id); }
      }
      run.updatedAt = new Date().toISOString();
      await dependencies.saveRun(run);
    }
    for (const error of envelope.errors ?? []) dependencies.error(`Capture failed: ${error}`);
    return envelope.errors?.length ? 2 : 0;
  } finally { await release(); }
}

async function main(): Promise<void> {
  process.exitCode = await runCaptureImport(process.argv.slice(2), {
    ingestion: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
    captureDir: CAPTURE_DIR, saveCapture, acquireLock: acquireRefreshLock, readLedger: readRefreshLedger, saveRun: saveRefreshRun,
    writeProgress: atomicWriteJson, log: console.log, error: console.error,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
