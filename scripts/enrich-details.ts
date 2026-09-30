/** Optional bounded detail enrichment AFTER cross-portal deduplication. */
import { BACKUP_DIR, DATA_DIR, JsonSourceStore, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { enrichDetailsCli } from "../src/collectors/enrichment/detailEnrichmentRunner";

/** Existing CLI and parking alias keep their names, defaults, output, and exit codes. */
if (process.argv[1]?.endsWith("enrich-details.ts")) {
  enrichDetailsCli(process.argv.slice(2), {
    dataDir: DATA_DIR,
    client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
  }).catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
}
