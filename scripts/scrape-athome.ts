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
 * Blocked/uncertain navigation is not retried automatically. The application
 * layer stages parsed observations and commits once after every city finishes,
 * so a failed crawl never overwrites the last good source snapshot.
 */
import { pathToFileURL } from "node:url";
import { BACKUP_DIR, JsonSourceStore, ShrinkGuardError, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { cachedPage } from "../src/collectors/shared/captureStore";
import { AthomeBrowser } from "../src/collectors/athome/athomeBrowser";
import { runPortalScrape, type PortalCollectorConfig, type PortalCollectorDependencies } from "../src/collectors/shared/portalCollector";

const cityUrl = (slug: string) => `https://www.athome.co.jp/chintai/saitama/${slug}/list/`;

export const ATHOME_COLLECTOR: PortalCollectorConfig = {
  source: "athome",
  label: "AtHome",
  cities: [
    { city: "Soka", url: cityUrl("soka-city"), heading: "Soka (soka-city)" },
    { city: "Koshigaya", url: cityUrl("koshigaya-city"), heading: "Koshigaya (koshigaya-city)" },
    // Kawaguchi borders western Soka; its eastern/northern neighbourhoods are
    // especially relevant to Al Sanad School and are ranked by actual distance.
    { city: "Kawaguchi", url: cityUrl("kawaguchi-city"), heading: "Kawaguchi (kawaguchi-city)" },
  ],
  delayMs: 1800,
  roomNoun: "rooms",
  stopMessage: "  stopped: 2 consecutive pages were entirely known",
  emptyMessage: "AtHome crawl returned no usable rooms; existing source left untouched.",
  nextStep: "Next: npm run data:build && npm run enrich && npm run find:new",
};

export function runAthomeScrape(args: readonly string[], dependencies: PortalCollectorDependencies) {
  return runPortalScrape(ATHOME_COLLECTOR, args, dependencies);
}

async function main(): Promise<void> {
  const browser = new AthomeBrowser();
  let activeCity = "";
  await runAthomeScrape(process.argv.slice(2), {
    client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
    page: (meta) => cachedPage(meta, async () => {
      if (activeCity !== meta.city) {
        const url = ATHOME_COLLECTOR.cities.find((city) => city.city === meta.city)!.url;
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
