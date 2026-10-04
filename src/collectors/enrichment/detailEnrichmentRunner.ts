/** Bounded SUUMO detail loading (headed browser): queue, request budget, backoff and capture cache. The data layer picks URLs and merges details. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DetailEnrichmentPlanner, ScrapeIngestion } from "../../data-layer/ingestion/contracts";
import { withFileLock, writeJsonAtomically } from "../../node/jsonFile";
import { createBrowserFetch } from "../shared/browserFetch";
import { captureKey } from "../shared/captureStore";
import { positiveInteger } from "../shared/pageBudget";
import { parseDetail } from "./detailEnrichment";
import { detailCaptureBatch, validateDetailCapture, type DetailCapture } from "./suumoDetailIngestion";

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
  await writeJsonAtomically(queuePath, queue); // deferred URLs survive later scrapes
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
        await writeJsonAtomically(path, capture);
      } catch (e) {
        item.error = (e as Error).message; item.retryAfter = new Date(dependencies.now().getTime() + 3600000).toISOString(); failed++;
        await writeJsonAtomically(queuePath, queue);
        // One source circuit breaker: no repeated challenge/throttle requests.
        if (/403|405|429|Unrecognized/.test(item.error)) break;
        continue;
      }
      await dependencies.sleep(2000);
    } else reused++;
    parseDetail(capture.html);
    details.set(item.url, capture);
    item.checkedAt = capture.capturedAt; delete item.error; delete item.retryAfter;
    await writeJsonAtomically(queuePath, queue);
  }
  let applied = 0;
  if (details.size) {
    const batch = await detailCaptureBatch([...details.values()], { maxRent, minSize });
    const receipt = await dependencies.client.ingestScrape(batch);
    applied = receipt.updated;
  }
  return { requests, limit, reused, applied, failed, queued: queue.length };
}

/**
 * Shared by `detail:enrich` and its `backfill:parking` alias: pages load in the
 * headed browser (never a plain HTTP client), with the real clock.
 */
export async function enrichDetailsCli(
  args: readonly string[],
  dependencies: Pick<DetailEnrichmentDependencies, "dataDir" | "client">,
): Promise<void> {
  const browser = createBrowserFetch("suumo-detail");
  const result = await runDetailEnrichment(args, {
    ...dependencies,
    fetch: browser.fetch, now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).finally(() => browser.close());
  console.log(`Details: ${result.requests}/${result.limit} requests; ${result.reused} cache replays; ${result.applied} applied; ${result.failed} failures; queue retained (${result.queued} URLs).`);
  if (result.failed) process.exitCode = 2;
}
