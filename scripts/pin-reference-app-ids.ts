/**
 * Pin app-facing ids on reference places (`npm run data:reference:app-ids`).
 *
 * Saved place selections store the id the app derives for each place. Every
 * active catalog place is pinned to that id and its position, so adding or
 * retiring places can never move a saved selection to a different place.
 * Run this after adding places; it pins only the places that lack a pin, as
 * a revisioned catalog update, and is a no-op when nothing is missing.
 */
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import { planPlacePins } from "../src/data-layer/referencePins";

async function main(): Promise<void> {
  const directory = argValue("--catalog") ?? REFERENCE_CATALOG_DIR;
  const repository = new JsonReferenceDataRepository(directory);
  const snapshot = await repository.loadSnapshot();
  const changes = planPlacePins(snapshot.places.records, new Date().toISOString());
  if (changes.length === 0) {
    console.log(`App place ids are already pinned in ${directory}`);
    return;
  }
  const updated = await repository.updatePlaces({ upsert: changes }, {
    expectedRevision: snapshot.places.revision,
    changedBy: "data:reference:app-ids",
    reason: "Pin app place ids and order for places added since the last pinning",
  });
  console.log(`Pinned app ids for ${changes.length} places in ${directory}`);
  for (const record of changes) console.log(`  ${record.attributes?.appPlaceId} (${record.id})`);
  console.log(`  places revision: ${snapshot.places.revision} -> ${updated.revision}`);
  console.log("  The previous dataset file and manifest checkpoint were retained for rollback. Next: npm run data:web");
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
