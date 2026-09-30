/** Compatibility alias: one optional detail fetch now captures ALL useful fields. */
export { parseParking, extractParkingCell, type ParkingInfo } from "../src/collectors/shared/parking";
import { BACKUP_DIR, DATA_DIR, JsonSourceStore, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { enrichDetailsCli } from "../src/collectors/enrichment/detailEnrichmentRunner";

if (process.argv[1]?.endsWith("backfill-parking.ts")) {
  enrichDetailsCli(process.argv.slice(2), {
    dataDir: DATA_DIR,
    client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
  }).catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
}
