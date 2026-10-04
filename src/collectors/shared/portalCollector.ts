/** Offline-testable AtHome/RoomSpot collector loop. Source reads, overlap state and merges live behind the client. */
import { portalPageUrl, type PortalDiscoveryClient } from "../../data-layer/ingestion/contracts";
import type { PageCapture } from "./captureStore";
import { listCaptureBatch } from "./listCaptureBatch";
import { DEFAULT_INCREMENTAL_PAGE_CEILING } from "./pageBudget";
import { selectCities } from "./targetCities";

export interface PortalCollectorConfig {
  source: "athome" | "roomspot";
  label: string;
  cities: readonly { city: string; url: string; heading: string }[];
  delayMs: number;
  roomNoun: string;
  stopMessage: string;
  emptyMessage: string;
  nextStep?: string;
}

export interface PortalCollectorDependencies {
  client: PortalDiscoveryClient;
  page(meta: Pick<PageCapture, "source" | "city" | "url" | "page">): Promise<PageCapture>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /** Called before commit, after all pages are staged or a failure occurs. */
  close?(): Promise<void>;
}

export function portalPageBudget(args: readonly string[]): number {
  const flag = args.indexOf("--max-pages");
  return flag >= 0 ? Math.max(1, Number(args[flag + 1]) || 1) : DEFAULT_INCREMENTAL_PAGE_CEILING;
}

export async function runPortalScrape(config: PortalCollectorConfig, args: readonly string[], dependencies: PortalCollectorDependencies) {
  if (args.includes("--full")) {
    await dependencies.close?.();
    throw new Error("--full requires verified per-city exhaustion. Use --deep; capped discovery never authorizes SOLD detection.");
  }
  const maxPages = portalPageBudget(args);
  const cities = selectCities(args, config.cities, (city) => city.city);
  let pagesFetched = 0;
  let session;
  try {
    session = await dependencies.client.beginPortalDiscovery({ source: config.source, deep: args.includes("--deep"), maxPages,
      cities: cities.map((city) => ({ label: city.city, url: city.url })) });
    if (session.bootstrap) dependencies.log(`No ${config.label} snapshot yet; automatically bootstrapping a deep discovery crawl.`);
    dependencies.log(session.deep ? `${config.label} deep newest-first bootstrap` : `${config.label} incremental newest-first discovery`);
    for (const city of cities) {
      dependencies.log(`\n=== ${city.heading} ===`);
      for (let page = 1; page <= maxPages; page++) {
        const meta = { source: config.source, city: city.city, url: portalPageUrl(config.source, city.url, page), page };
        const capture = await dependencies.page(meta);
        if (capture.source !== meta.source || capture.url !== meta.url || capture.city !== meta.city || capture.page !== page) {
          throw new Error(`${config.label} capture identity mismatch`);
        }
        const result = session.stagePage(await listCaptureBatch(capture));
        pagesFetched++;
        // A page of small units is not exhaustion and does not count as all-known.
        if (result.parsedCount === 0) { if (result.stopReason) break; continue; }
        dependencies.log(`  page ${page}: ${result.parsedCount} ${config.roomNoun} (${result.novel} new, ${result.overlap} known, ${result.duplicate} duplicate)`);
        if (result.stopReason === "overlap") { dependencies.log(config.stopMessage); break; }
        await dependencies.sleep(config.delayMs);
        if (result.stopReason) break;
      }
    }
  } finally {
    await dependencies.close?.();
  }
  let result;
  try { result = await session.commit({ allowShrink: args.includes("--force") }); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Crawl returned no usable family rooms")) throw new Error(config.emptyMessage);
    throw error;
  }
  dependencies.log(`\nWrote ${result.currentCount} ${config.label} listings (was ${result.previousCount})`);
  // A replay (e.g. the commit landed but the refresh ledger did not) reports the
  // journaled original counts, so parseDiscovered does not record zero.
  const counts = result.replayed && result.effect ? { ...result.effect, retired: result.retired } : result;
  dependencies.log(`Discovered ${counts.added} new; refreshed ${counts.updated} overlaps; retired ${counts.retired} superseded source ad(s); fetched ${pagesFetched} pages.${result.replayed ? " (already committed; no source change)" : ""}`);
  if (config.nextStep) dependencies.log(config.nextStep);
  return result;
}
