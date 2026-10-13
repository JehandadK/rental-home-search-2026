/** List-first Nifty discovery. Zero mandatory detail requests; per-page checkpoints. */
import { NiftyBrowser } from "../src/collectors/nifty/niftyBrowser";
import { niftyCaptureExpression } from "../src/collectors/nifty/niftyCapture";
import { cachedPage } from "../src/collectors/shared/captureStore";
import { BACKUP_DIR, JsonSourceStore, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { ingestNiftyListPage } from "../src/collectors/nifty/niftyIngestion";
import { asEndOfResults, crawlNiftyCity } from "../src/collectors/nifty/niftyCrawl";
import { DEFAULT_INCREMENTAL_PAGE_CEILING, positiveInteger } from "../src/collectors/shared/pageBudget";
import { TARGET_CITIES } from "../src/collectors/shared/targetCities";
import { collectorSettings, describeSettings, withMinArea } from "../src/collectors/shared/searchFilters";

const args = process.argv.slice(2);
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const slug = arg("--city") ?? "sokashi_ct";
const city = TARGET_CITIES.find((candidate) => candidate.nifty === slug);
if (!city) throw new Error("Unknown Nifty city");
const limit = positiveInteger(arg("--pages"), DEFAULT_INCREMENTAL_PAGE_CEILING);
const deep = args.includes("--deep");
const { minAreaM2 } = collectorSettings("nifty", args);
const urlFor = (page: number) => withMinArea("nifty", `https://myhome.nifty.com/rent/${city.prefectureSlug}/${slug}/${page > 1 ? page + "/" : ""}?sort=regDate-desc`, minAreaM2);
const browser = new NiftyBrowser();
const ingestion = new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR)));
let connected = false;
console.log(describeSettings("nifty", { minAreaM2 }));
try {
  const { added, pages } = await crawlNiftyCity({ limit, deep }, {
    page: (page) => cachedPage({ source: "nifty", city: city.label, url: urlFor(page), page }, async () => {
      // The tab always opens on page 1, whose results exist; later pages are fetched from it.
      if (!connected) { await browser.connect(urlFor(1)); connected = true; }
      try { return await browser.evaluate<string>(niftyCaptureExpression(urlFor(page))); }
      catch (error) { throw asEndOfResults(error, page); }
    }),
    ingest: (capture) => ingestNiftyListPage(ingestion, capture, minAreaM2),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  });
  console.log(`Discovered ${added} new; ${pages} list pages; 0 detail loads; source checkpointed after each page.`);
} catch (e) {
  console.error(`Nifty stopped (validated progress retained): ${(e as Error).message}`); process.exitCode = 2;
} finally { await browser.close(); }
