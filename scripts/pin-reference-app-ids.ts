/**
 * Pin the app-facing place ids and order into the managed reference catalog
 * (`npm run data:reference:app-ids`, M5).
 *
 * Saved place selections store ids the app derived from the original
 * reference files' names and order. This records each migrated place's id,
 * position, and subtitle as a revisioned catalog update, so the web app can
 * read the catalog instead of those files without resetting selections.
 * Re-running it on an annotated catalog is a no-op.
 */
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { DATA_DIR, REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import { planAppPlaceAnnotations } from "../src/storage/json/dataMigrations/legacyReference";
import { readLegacyReferenceFiles } from "../src/storage/json/dataMigrations/legacyReferenceFiles";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReferenceCatalogManifest } from "../src/data-layer/contracts";

async function main(): Promise<void> {
  const directory = argValue("--catalog") ?? REFERENCE_CATALOG_DIR;
  const legacyDir = argValue("--legacy") ?? DATA_DIR;
  const { legacy, sourceFiles } = await readLegacyReferenceFiles(legacyDir);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as ReferenceCatalogManifest;
  if (JSON.stringify(manifest.sourceFiles) !== JSON.stringify(sourceFiles)) {
    throw new Error(
      "The original reference files changed after the catalog was migrated from them, " +
        "so their order no longer describes the catalog. Review the change before pinning app ids.",
    );
  }

  const repository = new JsonReferenceDataRepository(directory);
  const snapshot = await repository.loadSnapshot();
  const changes = planAppPlaceAnnotations(legacy, snapshot.places.records, new Date().toISOString());
  if (changes.length === 0) {
    console.log(`App place ids are already pinned in ${directory}`);
    return;
  }
  const updated = await repository.updatePlaces({ upsert: changes }, {
    expectedRevision: snapshot.places.revision,
    changedBy: "data:reference:app-ids",
    reason: "Pin the app place ids, order, and subtitles derived from the original reference files (M5)",
  });
  console.log(`Pinned app ids for ${changes.length} places in ${directory}`);
  console.log(`  places revision: ${snapshot.places.revision} -> ${updated.revision}`);
  console.log("  The previous dataset file and manifest checkpoint were retained for rollback.");
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a directory path`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
