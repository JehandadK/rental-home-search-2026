/**
 * Scrapes family-size rental listings from SUUMO for every target city (see targetCities.ts).
 *
 * Default mode is an optimized incremental discovery crawl:
 *   - asks SUUMO for newest-first results (`po1=09`),
 *   - walks only until two consecutive pages are entirely known,
 *   - merges discoveries into the existing source snapshot,
 *   - never marks unseen records sold (a partial crawl cannot prove absence).
 *
 * `--full` remains guarded until per-city exhaustion can be verified. Capped
 * discovery never establishes absence. The application layer stages observations
 * and commits once the bounded crawl succeeds; cached pages survive failures.
 *
 * This collector submits only source observations. Afterwards run
 * `npm run backfill:parking && npm run data:build && npm run enrich`.
 */
import { pathToFileURL } from "node:url";
import { BACKUP_DIR, JsonSourceStore, ShrinkGuardError, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService, scrapeFingerprint } from "../src/data-layer/ingestion/service";
import type { ScrapeBatch, SuumoDiscoveryClient } from "../src/data-layer/ingestion/contracts";
import { cachedPage, validateCapture, type PageCapture } from "../src/collectors/shared/captureStore";
import { parsePage } from "../src/collectors/suumo/suumo";
import { DEFAULT_INCREMENTAL_PAGE_CEILING } from "../src/collectors/shared/pageBudget";
import { TARGET_CITIES, selectCities } from "../src/collectors/shared/targetCities";
import { createBrowserFetch, type BrowserFetch } from "../src/collectors/shared/browserFetch";

/** 2K / 2DK / 2LDK / 3K / 3DK / 3LDK / 4K / 4DK / 4LDK / 5K+ */
const LAYOUT_CODES = ["05", "06", "07", "08", "09", "10", "11", "12", "13", "14"];
const PAGE_DELAY_MS = 2_000;
const MD_QUERY = LAYOUT_CODES.map((c) => `md=${c}`).join("&");
const NEWEST_FIRST = "po1=09";
const CITIES = TARGET_CITIES.map((city) => ({ sc: city.suumo, label: city.label, prefecture: city.prefectureSlug }));

const cityUrl = (city: (typeof CITIES)[number], page: number, newestFirst: boolean) => {
  const params = `${MD_QUERY}${newestFirst ? `&${NEWEST_FIRST}` : ""}${page > 1 ? `&page=${page}` : ""}`;
  return `https://suumo.jp/chintai/${city.prefecture}/${city.sc}/?${params}`;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** List pages load in the headed browser (BROWSER_DRIVER=playwright or the Chrome bridge), never a plain HTTP client. */
async function fetchPage(browser: BrowserFetch, url: string): Promise<string> {
  const res = await browser.fetch(url);
  if (!res.ok) throw new Error(`SUUMO ${url}: HTTP ${res.status}`);
  return res.text();
}

export { parsePage };

/** The adapter submits all parsed observations; identity and deduplication belong to the data layer. */
export async function suumoCaptureBatch(capture: PageCapture): Promise<ScrapeBatch> {
  if (capture.source !== "suumo") throw new Error("Expected a SUUMO capture");
  validateCapture(capture);
  const parsed = parsePage(capture.html, new Date(capture.capturedAt).getFullYear()).map((listing) => ({ ...listing, city: capture.city }));
  if (!parsed.length) throw new Error("SUUMO page had no usable records; capture retained for offline diagnosis");
  const captureId = await scrapeFingerprint({ source: capture.source, city: capture.city, url: capture.url, page: capture.page,
    capturedAt: capture.capturedAt, html: capture.html });
  return { schemaVersion: 1, source: "suumo", scraper: { name: "suumo-list", version: "1", parserVersion: "1" },
    runId: `suumo-page:${capture.capturedAt}`, batchId: captureId, mode: "discovery", capturedAt: capture.capturedAt,
    scope: { urls: [capture.url], cities: [capture.city], filters: { page: capture.page, sort: "newest", layoutCodes: LAYOUT_CODES.join(",") } },
    observations: parsed.map((listing) => ({ sourceListingId: listing.url!, observedAt: capture.capturedAt,
      evidence: { url: capture.url, captureId }, listing })),
  };
}

export interface SuumoScrapeDependencies {
  client: SuumoDiscoveryClient;
  page(meta: Pick<PageCapture, "source" | "city" | "url" | "page">): Promise<PageCapture>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export async function runSuumoScrape(args: readonly string[], dependencies: SuumoScrapeDependencies) {
  if (args.includes("--full")) throw new Error("Authoritative --full requires verified per-city exhaustion, not configured page caps. Use --deep for safe non-destructive discovery.");
  const deep = args.includes("--deep");
  const flag = args.indexOf("--max-pages");
  const maxPages = flag >= 0 ? Math.max(1, Math.floor(Number(args[flag + 1]) || 1)) : DEFAULT_INCREMENTAL_PAGE_CEILING;
  const cities = selectCities(args, CITIES, (city) => city.label);
  const session = await dependencies.client.beginSuumoDiscovery({ deep, maxPages, layoutCodes: LAYOUT_CODES,
    cities: cities.map((city) => ({ code: city.sc, label: city.label })) });
  let pagesFetched = 0;
  dependencies.log(deep ? "Deep newest-first discovery (no deletions)" : "Incremental newest-first discovery (no deletions)");
  for (const city of cities) {
    dependencies.log(`\n=== ${city.label} (${city.sc}) ===`);
    for (let page = 1; page <= maxPages; page++) {
      const meta = { source: "suumo" as const, city: city.label, url: cityUrl(city, page, true), page };
      const capture = await dependencies.page(meta);
      if (capture.url !== meta.url || capture.city !== meta.city || capture.page !== page) throw new Error("SUUMO capture identity mismatch");
      const result = session.stagePage(await suumoCaptureBatch(capture));
      pagesFetched++;
      dependencies.log(`  page ${page}: ${result.parsedCount} properties (${result.novel} new, ${result.overlap} known, ${result.duplicate} duplicate)`);
      if (result.stopReason === "overlap") {
        dependencies.log("  stopped: 2 consecutive pages were entirely known");
        break;
      }
      await dependencies.sleep(PAGE_DELAY_MS);
    }
  }
  const result = await session.commit({ allowShrink: args.includes("--force") });
  dependencies.log(`\nWrote ${result.currentCount} listings (was ${result.previousCount})`);
  // A replay (the commit landed but the refresh ledger did not) reports the journaled
  // original counts, so parseDiscovered does not record zero.
  const counts = result.replayed && result.effect ? { ...result.effect, retired: result.retired } : result;
  dependencies.log(`Discovered ${counts.added} new; refreshed ${counts.updated} overlapping; retired ${counts.retired} superseded source ad(s); fetched ${pagesFetched} pages.${result.replayed ? " (already committed; no source change)" : ""}`);
  dependencies.log("Unseen history was retained; no SOLD decisions were made.");
  dependencies.log("Next: npm run backfill:parking && npm run data:build && npm run enrich");
  return result;
}

async function main(): Promise<void> {
  const browser = createBrowserFetch("suumo-list");
  try {
    await runSuumoScrape(process.argv.slice(2), {
      client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
      page: (meta) => cachedPage(meta, () => fetchPage(browser, meta.url)), sleep, log: console.log,
    });
  } finally {
    await browser.close();
  }
}

// Native-browser imports reuse the parser without starting a network collector.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => {
  if (err instanceof ShrinkGuardError) {
    console.error(`\n${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
