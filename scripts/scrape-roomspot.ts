/** Incremental newest-first RoomSpot collector for Soka, Koshigaya and Kawaguchi 2K+. */
import { readSource, ShrinkGuardError, writeSource } from "./lib/dataStore";
import { trackingKey } from "./lib/lifecycle";
import { cachedPage } from "./lib/captureStore";
import {
  isRoomspotOverlap,
  mergeRoomspotIncremental,
  parseRoomspotPage,
  roomspotMatchKeys,
} from "./lib/roomspot";
import { RoomspotBrowser } from "./lib/roomspotBrowser";
import type { RawListing } from "../src/types";
import { DEFAULT_INCREMENTAL_PAGE_CEILING } from "./lib/refreshPlan";

const CITIES = [
  { code: "221", city: "Soka", address: "埼玉県草加市" },
  { code: "222", city: "Koshigaya", address: "埼玉県越谷市" },
  { code: "203", city: "Kawaguchi", address: "埼玉県川口市" },
];
const FULL = process.argv.includes("--full");
const DEEP = process.argv.includes("--deep");
const pageFlag = process.argv.indexOf("--max-pages");
const MAX_PAGES = pageFlag >= 0
  ? Math.max(1, Number(process.argv[pageFlag + 1]) || 1)
  : DEFAULT_INCREMENTAL_PAGE_CEILING;
const STOP_AFTER_KNOWN = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const urlFor = ({ code, address }: (typeof CITIES)[number]) =>
  `https://www.roomspot.net/rent/search/area/pref_11/city_${code}/?address[]=${encodeURIComponent(address)}` +
  `&ftlsflg=1&sort=new_arrival&item_per_page=30`;

async function main(): Promise<void> {
  if (FULL) throw new Error("--full requires verified per-city exhaustion. Use --deep; capped discovery never authorizes SOLD detection.");
  const previous = await readSource("roomspot");
  const deep = DEEP || !previous;
  const known = new Set((previous?.listings ?? []).flatMap(roomspotMatchKeys));
  const discovered: RawListing[] = [];
  const seen: RawListing[] = [];
  let pagesFetched = 0;
  const observedAtByKey: Record<string, string> = {};
  const browser = new RoomspotBrowser();
  let activeCity = "";

  console.log(FULL ? "RoomSpot full audit" : deep ? "RoomSpot deep newest-first bootstrap" : "RoomSpot incremental newest-first discovery");
  try {
    for (const city of CITIES) {
      console.log(`\n=== ${city.city} ===`);
      let knownPages = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const capture = await cachedPage({ source: "roomspot", city: city.city, url: `${urlFor(city)}&page_num=${page}`, page }, async () => {
          if (activeCity !== city.city) {
            if (activeCity) await browser.navigate(urlFor(city));
            else await browser.connect(urlFor(city));
            activeCity = city.city;
          }
          return browser.fetchPage(page);
        });
        const parsed = parseRoomspotPage(capture.html, city.city);
        pagesFetched++;
        for (const listing of parsed) observedAtByKey[trackingKey(listing)] = capture.capturedAt;
        if (parsed.length === 0) continue;
        let added = 0, overlap = 0, duplicate = 0;
        for (const listing of parsed) {
          if (seen.some((item) => isRoomspotOverlap(item, listing))) { duplicate++; continue; }
          seen.push(listing); discovered.push(listing);
          if (roomspotMatchKeys(listing).some((alias) => known.has(alias))) overlap++;
          else added++;
        }
        console.log(`  page ${page}: ${parsed.length} family rooms (${added} new, ${overlap} known, ${duplicate} duplicate)`);
        if (!FULL && !deep) {
          knownPages = added === 0 ? knownPages + 1 : 0;
          if (knownPages >= STOP_AFTER_KNOWN) { console.log("  stopped: two all-known pages"); break; }
        }
        await sleep(1000);
      }
    }
  } finally { await browser.close(); }

  if (discovered.length === 0) throw new Error("RoomSpot returned no in-scope family listings; source left untouched");
  const mergedHistory = mergeRoomspotIncremental(previous?.listings ?? [], discovered);
  const merged = FULL
    ? { ...mergedHistory, listings: mergedHistory.listings.filter((listing) => discovered.some((fresh) => isRoomspotOverlap(fresh, listing))) }
    : mergedHistory;
  const result = await writeSource(
    {
      source: "roomspot", scrapedAt: new Date().toISOString(), completeSnapshot: FULL,
      provenance: {
        mode: FULL ? "full audit" : deep ? "deep newest-first" : "incremental newest-first",
        pagesFetched, cities: CITIES.map((city) => city.city), newListings: merged.added,
        observedTrackingKeys: [...new Set(discovered.map(trackingKey))],
        observedAtByKey,
        capturedBy: "scripts/scrape-roomspot.ts via Pi Control Chrome",
      }, listings: merged.listings,
    },
    { force: process.argv.includes("--force") },
  );
  console.log(`\nWrote ${merged.listings.length} RoomSpot listings (was ${result.previousCount})`);
  console.log(`Discovered ${merged.added} new; refreshed ${merged.updated} overlaps; fetched ${pagesFetched} pages.`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ShrinkGuardError ? 2 : 1);
});
