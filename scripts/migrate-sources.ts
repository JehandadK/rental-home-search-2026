/**
 * One-time migration to the per-source data store.
 * Existing sources are skipped; historical rows are submitted to the data layer
 * without claiming new scrape evidence or rewriting the canonical input file.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { BACKUP_DIR, JsonSourceStore, RAW_PATH, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { SourceBootstrapService } from "../src/data-layer/bootstrap/service";
import type { SourceBootstrap } from "../src/data-layer/bootstrap/contracts";
import type { LegacyListing } from "../src/data-layer/contracts";

export async function runSourceMigration(inputPath: string, client: SourceBootstrap, log: (message: string) => void = console.log) {
  let raw: string;
  try { raw = await readFile(inputPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    log("No listings_raw.json to migrate.");
    return null;
  }
  const records = JSON.parse(raw) as LegacyListing[];
  const results = await client.bootstrapSources({ schemaVersion: 1,
    migration: { name: "legacy-source-split", version: "1" }, operationId: randomUUID(),
    actor: "scripts/migrate-sources.ts", reason: "Initialize missing source stores from preserved canonical history",
    input: { datasetId: "listings_raw.json", records },
  }, (result) => {
    if (result.status === "skipped") log(`  ${result.source}: source file already exists, skipped`);
    else log(`  ${result.source}: ${result.count} listings → src/data/sources/${result.source}.json`);
  });
  log("\nNext: npm run data:build");
  return results;
}

async function main(): Promise<void> {
  const repository = new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR));
  await runSourceMigration(RAW_PATH, new SourceBootstrapService(repository));
}

if (process.argv[1]?.endsWith("migrate-sources.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
