/**
 * Incremental newest-first RoomSpot collector for Soka, Koshigaya and Kawaguchi 2K+.
 * Browser navigation and the capture cache stay here; the application layer
 * stages parsed observations and commits once after every city finishes.
 */
import { pathToFileURL } from "node:url";
import { BACKUP_DIR, JsonSourceStore, ShrinkGuardError, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { cachedPage } from "./lib/captureStore";
import { RoomspotBrowser } from "./lib/roomspotBrowser";
import { runPortalScrape, type PortalCollectorConfig, type PortalCollectorDependencies } from "./lib/portalCollector";

const urlFor = (code: string, address: string) =>
  `https://www.roomspot.net/rent/search/area/pref_11/city_${code}/?address[]=${encodeURIComponent(address)}` +
  `&ftlsflg=1&sort=new_arrival&item_per_page=30`;

export const ROOMSPOT_COLLECTOR: PortalCollectorConfig = {
  source: "roomspot",
  label: "RoomSpot",
  cities: [
    { city: "Soka", url: urlFor("221", "埼玉県草加市"), heading: "Soka" },
    { city: "Koshigaya", url: urlFor("222", "埼玉県越谷市"), heading: "Koshigaya" },
    { city: "Kawaguchi", url: urlFor("203", "埼玉県川口市"), heading: "Kawaguchi" },
  ],
  delayMs: 1000,
  roomNoun: "family rooms",
  stopMessage: "  stopped: two all-known pages",
  emptyMessage: "RoomSpot returned no in-scope family listings; source left untouched",
};

export function runRoomspotScrape(args: readonly string[], dependencies: PortalCollectorDependencies) {
  return runPortalScrape(ROOMSPOT_COLLECTOR, args, dependencies);
}

async function main(): Promise<void> {
  const browser = new RoomspotBrowser();
  let activeCity = "";
  await runRoomspotScrape(process.argv.slice(2), {
    client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
    page: (meta) => cachedPage(meta, async () => {
      if (activeCity !== meta.city) {
        const url = ROOMSPOT_COLLECTOR.cities.find((city) => city.city === meta.city)!.url;
        if (activeCity) await browser.navigate(url);
        else await browser.connect(url);
        activeCity = meta.city;
      }
      return browser.fetchPage(meta.page);
    }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: console.log,
    close: () => browser.close(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ShrinkGuardError ? 2 : 1);
});
