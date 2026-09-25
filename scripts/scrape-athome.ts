/**
 * AtHome (athome.co.jp) collector for Soka, Koshigaya + Kawaguchi family rentals.
 *
 * Default: incremental newest-first discovery (`?sort=33`), stopping after
 * two all-known pages per city. Existing unseen inventory is preserved.
 * `--full` is rejected until verified per-city exhaustion is implemented;
 * bounded discovery never permits cross-source-absent listings to become SOLD.
 *
 * Search pages already contain rent, admin fee, deposit/key money, area,
 * build date, station walk time and amenity flags, so no detail-page crawl is
 * needed. The browser opens the AtHome homepage before navigating to results.
 * Blocked/uncertain navigation is not retried automatically; a failed crawl
 * never overwrites the last good source snapshot.
 */
import { readSource, ShrinkGuardError, writeSource } from "./lib/dataStore";
import {
  athomeMatchKeys,
  isAthomeOverlap,
  mergeAthomeIncremental,
  parseAthomePage,
} from "./lib/athome";
import { trackingKey } from "./lib/lifecycle";
import { cachedPage } from "./lib/captureStore";
import { AthomeBrowser } from "./lib/athomeBrowser";
import type { RawListing } from "../src/types";
import { DEFAULT_INCREMENTAL_PAGE_CEILING } from "./lib/refreshPlan";

const CITIES = [
  { slug: "soka-city", city: "Soka" },
  { slug: "koshigaya-city", city: "Koshigaya" },
  // Kawaguchi borders western Soka; its eastern/northern neighbourhoods are
  // especially relevant to Al Sanad School and are ranked by actual distance.
  { slug: "kawaguchi-city", city: "Kawaguchi" },
];
const FULL = process.argv.includes("--full");
const DEEP = process.argv.includes("--deep");
const pageFlag = process.argv.indexOf("--max-pages");
const MAX_PAGES = pageFlag >= 0
  ? Math.max(1, Number(process.argv[pageFlag + 1]) || 1)
  : DEFAULT_INCREMENTAL_PAGE_CEILING;
const OVERLAP_STOP_PAGES = 2;
const DELAY_MS = 1800;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cityUrl(slug: string): string {
  return `https://www.athome.co.jp/chintai/saitama/${slug}/list/`;
}

async function main(): Promise<void> {
  if (FULL) throw new Error("--full requires verified per-city exhaustion. Use --deep; capped discovery never authorizes SOLD detection.");
  const previous = await readSource("athome");
  if (!FULL && !previous) {
    console.log("No AtHome snapshot yet; automatically bootstrapping a deep discovery crawl.");
  }
  const effectiveDeep = DEEP || !previous;
  const knownAliases = new Set((previous?.listings ?? []).flatMap(athomeMatchKeys));
  const discovered: RawListing[] = [];
  const seen: RawListing[] = [];
  let pagesFetched = 0;
  const observedAtByKey: Record<string, string> = {};

  console.log(FULL ? "AtHome full-market audit" : effectiveDeep ? "AtHome deep newest-first bootstrap" : "AtHome incremental newest-first discovery");
  const browser = new AthomeBrowser();
  let activeCity = "";
  try {
  for (const config of CITIES) {
    console.log(`\n=== ${config.city} (${config.slug}) ===`);
    let knownPages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const capture = await cachedPage({ source: "athome", city: config.city, url: `${cityUrl(config.slug)}?sort=33&page=${page}`, page }, async () => {
        if (activeCity !== config.city) {
          if (activeCity) await browser.navigate(cityUrl(config.slug));
          else await browser.connect(cityUrl(config.slug));
          activeCity = config.city;
        }
        return browser.fetchPage(page);
      });
      const parsed = parseAthomePage(capture.html, config.city);
      pagesFetched++;
      for (const listing of parsed) observedAtByKey[trackingKey(listing)] = capture.capturedAt;
      if (parsed.length === 0) continue; // a page of small units is not exhaustion
      let added = 0, overlap = 0, duplicate = 0;
      for (const listing of parsed) {
        if (seen.some((item) => isAthomeOverlap(item, listing))) { duplicate++; continue; }
        seen.push(listing); discovered.push(listing);
        if (athomeMatchKeys(listing).some((key) => knownAliases.has(key))) overlap++;
        else added++;
      }
      console.log(`  page ${page}: ${parsed.length} rooms (${added} new, ${overlap} known, ${duplicate} duplicate)`);
      if (!FULL && !effectiveDeep) {
        knownPages = added === 0 ? knownPages + 1 : 0;
        if (knownPages >= OVERLAP_STOP_PAGES) {
          console.log(`  stopped: ${OVERLAP_STOP_PAGES} consecutive pages were entirely known`);
          break;
        }
      }
      await sleep(DELAY_MS);
    }
  }
  } finally {
    await browser.close();
  }

  if (discovered.length === 0) throw new Error("AtHome crawl returned no usable rooms; existing source left untouched.");
  const newListingIds = discovered
    .filter((listing) => !athomeMatchKeys(listing).some((key) => knownAliases.has(key)))
    .map((listing) => listing.id ?? "")
    .filter(Boolean);
  const mergedHistory = mergeAthomeIncremental(previous?.listings ?? [], discovered);
  const merged = FULL
    ? { ...mergedHistory, listings: mergedHistory.listings.filter((listing) => discovered.some((item) => isAthomeOverlap(item, listing))) }
    : mergedHistory;

  const result = await writeSource(
    {
      source: "athome",
      scrapedAt: new Date().toISOString(),
      completeSnapshot: FULL,
      provenance: {
        mode: FULL ? "full-market audit" : effectiveDeep ? "deep newest-first" : "incremental newest-first",
        pagesFetched,
        cities: CITIES.map((city) => city.slug),
        newListings: merged.added,
        newListingIds,
        observedTrackingKeys: [...new Set(discovered.map(trackingKey))],
        observedAtByKey,
        capturedBy: "scripts/scrape-athome.ts",
      },
      listings: merged.listings,
    },
    { force: process.argv.includes("--force"), expectedRevision: previous?.revision ?? null },
  );
  console.log(`\nWrote ${merged.listings.length} AtHome listings (was ${result.previousCount}) to ${result.path}`);
  console.log(`Discovered ${merged.added} new; refreshed ${merged.updated} overlaps; fetched ${pagesFetched} pages.`);
  console.log("Next: npm run data:build && npm run enrich && npm run find:new");
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ShrinkGuardError ? 2 : 1);
});
