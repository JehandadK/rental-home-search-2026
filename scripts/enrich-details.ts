/** Optional bounded detail enrichment AFTER cross-portal deduplication. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, DATA_DIR, listSources, writeSource } from "./lib/dataStore";
import { captureKey } from "./lib/captureStore";
import { parseDetail, applyDetail } from "./lib/detailEnrichment";
import { deduplicateListings } from "../src/domain/listingDedup";
import { positiveInteger } from "./lib/refreshPlan";
import type { RawListing } from "../src/types";

interface DetailCapture { url: string; capturedAt: string; html: string }
interface QueueItem { url: string; queuedAt: string; checkedAt?: string; retryAfter?: string; error?: string }
const QUEUE = join(DATA_DIR, "detail-queue.json");
async function optional<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
export async function enrichDetails(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--all-missing")) throw new Error("--all-missing is retired; use bounded --limit with explicit --max-rent/--min-size gates");
  const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const limit = positiveInteger(arg("--limit"), 10, 0);
  const maxRent = positiveInteger(arg("--max-rent"), 150000);
  const minSize = positiveInteger(arg("--min-size"), 40);
  const force = args.includes("--force");
  const replay = args.includes("--replay");
  const sources = await listSources();
  const source = sources.find((s) => s.source === "suumo");
  if (!source) throw new Error("SUUMO source missing");
  const queue = await optional<QueueItem[]>(QUEUE, []);
  const queued = new Set(queue.map((q) => q.url));
  const unique = deduplicateListings(sources.flatMap((s) => s.listings));
  const eligible = unique.filter((l) => l.status !== "sold" && l.rent <= maxRent && (l.sizeM2 ?? 0) >= minSize && Number(l.layout?.match(/^\d+/)?.[0]) >= 2)
    .sort((a, b) => a.rent / a.sizeM2! - b.rent / b.sizeM2! || (a.url ?? "").localeCompare(b.url ?? ""));
  const activeUrls = new Set<string>();
  for (const l of eligible) {
    // Cross-source dedup has already combined captured amenities/costs. Need no
    // extra page merely to repeat equivalent parking/lease/feature information.
    const complete = l.parking && l.tenancy?.leaseType && l.building?.features?.length;
    const url = l.source === "suumo" ? l.url : l.sourceListings?.find((r) => r.source === "suumo")?.url;
    if (!url || (!force && complete)) continue;
    activeUrls.add(url);
    if (!queued.has(url)) { queue.push({ url, queuedAt: new Date().toISOString() }); queued.add(url); }
  }
  await atomicWriteJson(QUEUE, queue); // deferred URLs survive later scrapes
  let requests = 0, reused = 0, failed = 0;
  const details = new Map<string, Partial<RawListing>>();
  for (const item of queue) {
    if (!activeUrls.has(item.url)) continue;
    const path = join(DATA_DIR, ".captures", "details", captureKey("suumo", item.url) + ".json");
    let capture = await optional<DetailCapture | null>(path, null);
    if (!capture || (!replay && (force || Date.now() - Date.parse(capture.capturedAt) > 7 * 86400000))) {
      if (replay || requests >= limit || (!force && item.retryAfter && Date.parse(item.retryAfter) > Date.now())) continue;
      // Restrict queued network work to the public source; never arbitrary URLs.
      if (new URL(item.url).hostname !== "suumo.jp") throw new Error("Invalid detail origin");
      try {
        requests++;
        const response = await fetch(item.url, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        parseDetail(html); // invalid/verification pages cannot become successful captures
        capture = { url: item.url, capturedAt: new Date().toISOString(), html };
        await atomicWriteJson(path, capture);
      } catch (e) {
        item.error = (e as Error).message; item.retryAfter = new Date(Date.now() + 3600000).toISOString(); failed++;
        await atomicWriteJson(QUEUE, queue);
        // One source circuit breaker: no repeated challenge/throttle requests.
        if (/403|405|429|Unrecognized/.test(item.error)) break;
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
    } else reused++;
    if (capture.url !== item.url) throw new Error("Detail capture identity mismatch");
    details.set(item.url, parseDetail(capture.html));
    item.checkedAt = capture.capturedAt; delete item.error; delete item.retryAfter;
    await atomicWriteJson(QUEUE, queue);
  }
  if (details.size) {
    await writeSource(
      { ...source, listings: source.listings.map((l) => l.url && details.has(l.url) ? applyDetail(l, details.get(l.url)!) : l) },
      { expectedRevision: source.revision ?? null },
    );
  }
  console.log(`Details: ${requests}/${limit} requests; ${reused} cache replays; ${details.size} applied; ${failed} failures; queue retained (${queue.length} URLs).`);
  if (failed) process.exitCode = 2;
}
if (process.argv[1]?.endsWith("enrich-details.ts")) enrichDetails().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
