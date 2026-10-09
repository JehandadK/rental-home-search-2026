/**
 * Backfills structured SUUMO fields from previously stored notes.
 * This is a versioned data-layer correction, not evidence of a new scrape.
 *
 * Run with: npm run data:backfill
 */
import { randomUUID } from "node:crypto";
import { BACKUP_DIR, JsonSourceStore, ShrinkGuardError, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { SourceCorrectionService } from "../src/data-layer/corrections/service";
import type { SourceCorrections } from "../src/data-layer/corrections/contracts";

/** CLI adapter: requests a reviewed recipe, never reads source files or constructs replacement rows. */
export async function runSuumoBackfill(client: SourceCorrections, log: (message: string) => void = console.log) {
  const result = await client.applyCorrection({ schemaVersion: 1, source: "suumo",
    rule: { name: "suumo-notes-backfill", version: "1" }, operationId: randomUUID(),
    actor: "scripts/backfill-suumo.ts", reason: "Recover structured floors and unknown included admin fees from stored SUUMO notes",
  });
  if (result.status === "missing") {
    log("No suumo source file — run `npm run scrape` first.");
    return result;
  }
  log(`Backfilled ${result.count} suumo listings: ${result.withFloor} now carry a structured floor.`);
  log("Admin fee stays unknown until the next `npm run scrape`.");
  log("\nNext: npm run data:build && npm run enrich");
  return result;
}

async function main(): Promise<void> {
  const repository = new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR));
  await runSuumoBackfill(new SourceCorrectionService(repository));
}

if (process.argv[1]?.endsWith("backfill-suumo.ts")) {
  main().catch((err) => {
    if (err instanceof ShrinkGuardError) {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  });
}
