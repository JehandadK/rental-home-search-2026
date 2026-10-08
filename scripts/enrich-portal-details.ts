/**
 * Bounded AtHome / RoomSpot detail loading for the agency store their list
 * pages leave out (掲載不動産会社 / 広告主情報):
 *
 *   npm run detail:athome -- [--limit 10] [--force] [--replay]
 *   npm run detail:roomspot -- [--limit 10] [--force] [--replay]
 *
 * Pages load only in the headed browser (the Chrome bridge, or
 * BROWSER_DRIVER=playwright). AtHome shows fresh profiles a human-verification
 * page: with ATHOME_VERIFY_WAIT_SECONDS set, the run waits passively for a person
 * to complete it in that window; it never answers or works around it. A
 * verification, block or unknown page stops all requests (circuit breaker) and
 * pauses the source for an hour, doubling on each repeat. `--replay` makes no
 * requests and re-submits the cached captures under data/.captures/details.
 */
import { pathToFileURL } from "node:url";
import { BACKUP_DIR, DATA_DIR, JsonSourceStore, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { recordEndedPortalAds } from "../src/storage/json/availabilityStore";
import { portalDetailsCli, type PortalDetailLoader } from "../src/collectors/enrichment/portalDetailRunner";
import { AthomeBrowser } from "../src/collectors/athome/athomeBrowser";
import { RoomspotBrowser } from "../src/collectors/roomspot/roomspotBrowser";

function loaderFor(source: "athome" | "roomspot"): PortalDetailLoader {
  const browser = source === "athome" ? new AthomeBrowser() : new RoomspotBrowser();
  let opened = false;
  return {
    load: (url) => { opened = true; return browser.readDetail(url); },
    // Nothing to close when every page came from the capture cache.
    close: async () => { if (opened) await browser.close(); },
  };
}

async function main(args: readonly string[]): Promise<void> {
  const source = args[args.indexOf("--source") + 1];
  if (!args.includes("--source") || (source !== "athome" && source !== "roomspot")) throw new Error("Usage: enrich-portal-details.ts --source athome|roomspot [--limit N] [--force] [--replay]");
  await portalDetailsCli(args, {
    source, dataDir: DATA_DIR, loader: loaderFor(source), onEnded: recordEndedPortalAds,
    client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
