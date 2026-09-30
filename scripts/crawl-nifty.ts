/** List-first Nifty discovery. Zero mandatory detail requests; per-page checkpoints. */
import { NiftyBrowser } from "./lib/niftyBrowser";
import { niftyCaptureExpression } from "./lib/niftyCapture";
import { cachedPage } from "./lib/captureStore";
import { BACKUP_DIR, JsonSourceStore, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { ingestNiftyListPage } from "./lib/niftyIngestion";
import { DEFAULT_INCREMENTAL_PAGE_CEILING, positiveInteger } from "./lib/refreshPlan";

const args = process.argv.slice(2);
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const slug = arg("--city") ?? "sokashi_ct";
const cities: Record<string, string> = { sokashi_ct: "Soka", koshigayashi_ct: "Koshigaya", kawaguchishi_ct: "Kawaguchi" };
if (!cities[slug]) throw new Error("Unknown Nifty city");
const limit = positiveInteger(arg("--pages"), DEFAULT_INCREMENTAL_PAGE_CEILING);
const deep = args.includes("--deep");
const urlFor = (page: number) => `https://myhome.nifty.com/rent/saitama/${slug}/${page > 1 ? page + "/" : ""}?sort=regDate-desc`;
const browser = new NiftyBrowser();
const ingestion = new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR)));
let connected = false, knownPages = 0, totalAdded = 0, pages = 0;
try {
  for (let page = 1; page <= limit; page++) {
    const capture = await cachedPage({ source: "nifty", city: cities[slug], url: urlFor(page), page }, async () => {
      if (!connected) { await browser.connect(urlFor(page)); connected = true; }
      return browser.evaluate<string>(niftyCaptureExpression(urlFor(page)));
    });
    const result = await ingestNiftyListPage(ingestion, capture);
    totalAdded += result.added; pages++;
    knownPages = result.parsedCount > 0 && result.novel === 0 ? knownPages + 1 : 0;
    if (!deep && knownPages >= 2) break;
    if (page < limit) await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`Discovered ${totalAdded} new; ${pages} list pages; 0 detail loads; source checkpointed after each page.`);
} catch (e) {
  console.error(`Nifty stopped (validated progress retained): ${(e as Error).message}`); process.exitCode = 2;
} finally { await browser.close(); }
