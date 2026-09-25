/** Optional bounded detail enrichment AFTER cross-portal deduplication. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, BACKUP_DIR, DATA_DIR, JsonSourceStore, SOURCES_DIR } from "./lib/dataStore";
import { JsonListingRepository } from "./lib/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import type { DetailEnrichmentPlanner, ScrapeIngestion } from "../src/data-layer/ingestion/contracts";
import { withFileLock } from "./lib/jsonFile";
import { captureKey } from "./lib/captureStore";
import { parseDetail } from "./lib/detailEnrichment";
import { detailCaptureBatch, validateDetailCapture, type DetailCapture } from "./lib/suumoDetailIngestion";
import { positiveInteger } from "./lib/refreshPlan";

interface QueueItem { url: string; queuedAt: string; checkedAt?: string; retryAfter?: string; error?: string }
export interface DetailEnrichmentDependencies {
  dataDir: string;
  client: ScrapeIngestion & DetailEnrichmentPlanner;
  fetch: typeof fetch;
  now(): Date;
  sleep(ms: number): Promise<void>;
}
async function optional<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}

/** Inject paths, clock, network, and the public data-layer client for offline replay tests. */
export async function runDetailEnrichment(args: readonly string[], dependencies: DetailEnrichmentDependencies) {
  return withFileLock(join(dependencies.dataDir, "detail-enrichment"), () => enrichDetailsLocked(args, dependencies));
}

async function enrichDetailsLocked(args: readonly string[], dependencies: DetailEnrichmentDependencies) {
  if (args.includes("--all-missing")) throw new Error("--all-missing is retired; use bounded --limit with explicit --max-rent/--min-size gates");
  const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const limit = positiveInteger(arg("--limit"), 10, 0);
  const maxRent = positiveInteger(arg("--max-rent"), 150000);
  const minSize = positiveInteger(arg("--min-size"), 40);
  const force = args.includes("--force");
  const replay = args.includes("--replay");
  const queuePath = join(dependencies.dataDir, "detail-queue.json");
  const urls = await dependencies.client.planDetailEnrichment({ maxRent, minSize, force });
  const queue = await optional<QueueItem[]>(queuePath, []);
  const queued = new Set(queue.map((q) => q.url));
  const activeUrls = new Set(urls);
  for (const url of activeUrls) {
    if (!queued.has(url)) { queue.push({ url, queuedAt: dependencies.now().toISOString() }); queued.add(url); }
  }
  await atomicWriteJson(queuePath, queue); // deferred URLs survive later scrapes
  let requests = 0, reused = 0, failed = 0;
  const details = new Map<string, DetailCapture>();
  for (const item of queue) {
    if (!activeUrls.has(item.url)) continue;
    const path = join(dependencies.dataDir, ".captures", "details", captureKey("suumo", item.url) + ".json");
    let capture = await optional<DetailCapture | null>(path, null);
    if (capture) validateDetailCapture(capture, item.url);
    if (!capture || (!replay && (force || dependencies.now().getTime() - Date.parse(capture.capturedAt) > 7 * 86400000))) {
      if (replay || requests >= limit || (!force && item.retryAfter && Date.parse(item.retryAfter) > dependencies.now().getTime())) continue;
      // Restrict queued network work to the public source; never arbitrary URLs.
      const url = new URL(item.url);
      if (url.protocol !== "https:" || url.hostname !== "suumo.jp" || url.username || url.password) throw new Error("Invalid detail origin");
      try {
        requests++;
        const response = await dependencies.fetch(item.url, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        capture = { url: item.url, capturedAt: dependencies.now().toISOString(), html };
        validateDetailCapture(capture, item.url);
        parseDetail(html); // invalid/verification pages cannot become successful captures
        await atomicWriteJson(path, capture);
      } catch (e) {
        item.error = (e as Error).message; item.retryAfter = new Date(dependencies.now().getTime() + 3600000).toISOString(); failed++;
        await atomicWriteJson(queuePath, queue);
        // One source circuit breaker: no repeated challenge/throttle requests.
        if (/403|405|429|Unrecognized/.test(item.error)) break;
        continue;
      }
      await dependencies.sleep(2000);
    } else reused++;
    parseDetail(capture.html);
    details.set(item.url, capture);
    item.checkedAt = capture.capturedAt; delete item.error; delete item.retryAfter;
    await atomicWriteJson(queuePath, queue);
  }
  let applied = 0;
  if (details.size) {
    const batch = await detailCaptureBatch([...details.values()], { maxRent, minSize });
    const receipt = await dependencies.client.ingestScrape(batch);
    applied = receipt.updated;
  }
  return { requests, limit, reused, applied, failed, queued: queue.length };
}

/** Existing CLI and parking alias keep their names, defaults, output, and exit codes. */
export async function enrichDetails(): Promise<void> {
  const result = await runDetailEnrichment(process.argv.slice(2), {
    dataDir: DATA_DIR,
    client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
    fetch, now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  console.log(`Details: ${result.requests}/${result.limit} requests; ${result.reused} cache replays; ${result.applied} applied; ${result.failed} failures; queue retained (${result.queued} URLs).`);
  if (result.failed) process.exitCode = 2;
}
if (process.argv[1]?.endsWith("enrich-details.ts")) enrichDetails().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
