/** Offline-testable AtHome/RoomSpot collector loop. Source reads, overlap state and merges live behind the client. */
import { portalPageUrl, type PortalDiscoveryClient, type ScrapeIngestionReceipt } from "../../data-layer/ingestion/contracts";
import type { PageCapture } from "./captureStore";
import { listCaptureBatch } from "./listCaptureBatch";
import { DEFAULT_INCREMENTAL_PAGE_CEILING } from "./pageBudget";
import { EndOfResultsError, lastResultsPage } from "./resultPages";
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
  /** Throws EndOfResultsError when a page past page 1 has no results. */
  page(meta: Pick<PageCapture, "source" | "city" | "url" | "page">): Promise<PageCapture>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /** Called once, after the last city's commit or after a failure. */
  close?(): Promise<void>;
}

export function portalPageBudget(args: readonly string[]): number {
  const flag = args.indexOf("--max-pages");
  return flag >= 0 ? Math.max(1, Number(args[flag + 1]) || 1) : DEFAULT_INCREMENTAL_PAGE_CEILING;
}

/** A replay (the commit landed but the refresh ledger did not) reports the journaled original counts. */
const effectOf = (receipt: ScrapeIngestionReceipt) => receipt.replayed && receipt.effect ? { ...receipt.effect, retired: receipt.retired } : receipt;

/** One receipt for a run of per-city commits: summed counts, the first city's starting size and the last city's state. */
function combineReceipts(receipts: readonly ScrapeIngestionReceipt[]): ScrapeIngestionReceipt {
  const sum = (key: "added" | "updated" | "retired" | "ignored" | "novel") => receipts.reduce((total, receipt) => total + receipt[key], 0);
  return { ...receipts.at(-1)!, previousCount: receipts[0].previousCount, added: sum("added"), updated: sum("updated"), retired: sum("retired"),
    ignored: sum("ignored"), novel: sum("novel"), replayed: receipts.every((receipt) => receipt.replayed), effect: undefined };
}

/** The run's summary lines; `parseDiscovered` reads the refresh ledger's count from the "Discovered" one. */
export function logCommittedCities(log: (message: string) => void, listings: string, refreshed: string, receipts: readonly ScrapeIngestionReceipt[], pagesFetched: number) {
  const result = combineReceipts(receipts);
  const counts = receipts.map(effectOf).reduce((total, effect) => ({ added: total.added + effect.added, updated: total.updated + effect.updated,
    retired: total.retired + effect.retired }), { added: 0, updated: 0, retired: 0 });
  log(`\nWrote ${result.currentCount} ${listings} (was ${result.previousCount})`);
  log(`Discovered ${counts.added} new; refreshed ${counts.updated} ${refreshed}; retired ${counts.retired} superseded source ad(s); fetched ${pagesFetched} pages.${result.replayed ? " (already committed; no source change)" : ""}`);
  return result;
}

/**
 * Each city is staged and committed on its own, so a failure in one city keeps
 * every city committed before it. The run still fails, and stops there: a
 * blocked or failing portal is not asked for further cities.
 */
export async function runPortalScrape(config: PortalCollectorConfig, args: readonly string[], dependencies: PortalCollectorDependencies) {
  if (args.includes("--full")) {
    await dependencies.close?.();
    throw new Error("--full requires verified per-city exhaustion. Use --deep; capped discovery never authorizes SOLD detection.");
  }
  const maxPages = portalPageBudget(args);
  const cities = selectCities(args, config.cities, (city) => city.city);
  let deep = args.includes("--deep");
  let pagesFetched = 0;
  const receipts: ScrapeIngestionReceipt[] = [];
  const committed: string[] = [];
  let failing = "the run";
  try {
    for (const [index, city] of cities.entries()) {
      failing = city.city;
      const session = await dependencies.client.beginPortalDiscovery({ source: config.source, deep, maxPages, cities: [{ label: city.city, url: city.url }] });
      if (index === 0) {
        if (session.bootstrap) dependencies.log(`No ${config.label} snapshot yet; automatically bootstrapping a deep discovery crawl.`);
        dependencies.log(session.deep ? `${config.label} deep newest-first bootstrap` : `${config.label} incremental newest-first discovery`);
      }
      // A bootstrap stays deep for every city, although the first commit creates the snapshot.
      deep = session.deep;
      dependencies.log(`\n=== ${city.heading} ===`);
      let parsed = 0;
      for (let page = 1; page <= maxPages; page++) {
        const meta = { source: config.source, city: city.city, url: portalPageUrl(config.source, city.url, page), page };
        let capture: PageCapture;
        try { capture = await dependencies.page(meta); }
        catch (error) {
          if (page === 1 || !(error instanceof EndOfResultsError)) throw error;
          dependencies.log(`  page ${page}: no results; end of ${city.city}'s results`);
          session.endOfResults(city.city);
          break;
        }
        if (capture.source !== meta.source || capture.url !== meta.url || capture.city !== meta.city || capture.page !== page) {
          throw new Error(`${config.label} capture identity mismatch`);
        }
        const result = session.stagePage(await listCaptureBatch(capture));
        pagesFetched++;
        parsed += result.parsedCount;
        const last = lastResultsPage(capture);
        const lastPage = !result.stopReason && last !== undefined && page >= last;
        const end = () => { session.endOfResults(city.city); dependencies.log(`  stopped: last results page (${page})`); };
        // A page of small units is not exhaustion and does not count as all-known.
        if (result.parsedCount === 0) { if (result.stopReason) break; if (lastPage) { end(); break; } continue; }
        dependencies.log(`  page ${page}: ${result.parsedCount} ${config.roomNoun} (${result.novel} new, ${result.overlap} known, ${result.duplicate} duplicate)`);
        if (result.stopReason === "overlap") { dependencies.log(config.stopMessage); break; }
        if (lastPage) { end(); break; }
        await dependencies.sleep(config.delayMs);
        if (result.stopReason) break;
      }
      if (!parsed) { dependencies.log(`  no in-scope ${config.roomNoun} in ${city.city}; nothing to commit`); continue; }
      const receipt = await session.commit({ allowShrink: args.includes("--force") });
      receipts.push(receipt);
      committed.push(city.city);
      const effect = effectOf(receipt);
      dependencies.log(`  committed ${city.city}: ${effect.added} new, ${effect.updated} refreshed${receipt.replayed ? " (already committed)" : ""}`);
    }
  } catch (error) {
    if (receipts.length) {
      dependencies.log(`\nKept the ${committed.join(", ")} commit(s); ${failing} failed and the run stopped there.`);
      logCommittedCities(dependencies.log, `${config.label} listings`, "overlaps", receipts, pagesFetched);
    }
    throw error;
  } finally {
    await dependencies.close?.();
  }
  if (!receipts.length) throw new Error(config.emptyMessage);
  const result = logCommittedCities(dependencies.log, `${config.label} listings`, "overlaps", receipts, pagesFetched);
  if (config.nextStep) dependencies.log(config.nextStep);
  return result;
}
