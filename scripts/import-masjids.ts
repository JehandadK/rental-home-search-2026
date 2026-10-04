/**
 * Add the saved Google Maps masjid list to the reference catalog's scored
 * mosques (`npm run data:reference:masjids`).
 *
 *   npm run data:reference:masjids -- [--file <saved list>] [--catalog <dir>] [--dry-run]
 *
 * The list is the file saved from a headed-browser capture, by default
 * `data/reference/imports/google-maps-masjids-japan.json`. Entries the capture
 * matched to a catalog mosque are skipped; the rest become `mosque` places,
 * so the nearest-mosque score counts them. Re-running is a no-op.
 * Next: `npm run data:web`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { DATA_DIR, REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import type { ReferencePlaceRecord } from "../src/data-layer/contracts";
import { planMasjidImport } from "../src/data-layer/masjidImport";

const DEFAULT_FILE = join(DATA_DIR, "reference", "imports", "google-maps-masjids-japan.json");
const CHANGED_BY = "data:reference:masjids";

interface SavedList {
  provenance: { listId: string; listTitle: string; capturedAt: string };
  records: ReferencePlaceRecord[];
}

async function main(): Promise<void> {
  const file = argValue("--file") ?? DEFAULT_FILE;
  const catalog = argValue("--catalog") ?? REFERENCE_CATALOG_DIR;
  const dryRun = process.argv.includes("--dry-run");

  const saved = JSON.parse(await readFile(file, "utf8")) as SavedList;
  const repository = new JsonReferenceDataRepository(catalog);
  const snapshot = await repository.loadSnapshot();
  const plan = planMasjidImport(snapshot.places.records, { listId: saved.provenance.listId, records: saved.records }, new Date().toISOString());

  console.log(`${saved.provenance.listTitle} (${saved.provenance.listId}), captured ${saved.provenance.capturedAt}: ${saved.records.length} masjids`);
  for (const { record, catalogId } of plan.matched) console.log(`  already in the catalog: ${record.name} = ${catalogId}`);
  console.log(`Plan: places +${plan.places.upsert.length} −${plan.places.retire?.length ?? 0}`);
  if (dryRun) {
    console.log("Dry run: the catalog was not changed");
    return;
  }
  if (plan.places.upsert.length === 0 && !plan.places.retire?.length) {
    console.log(`The list is already in ${catalog}`);
    return;
  }
  const updated = await repository.updatePlaces(plan.places, {
    expectedRevision: snapshot.places.revision,
    changedBy: CHANGED_BY,
    reason: `Add the masjids of Google Maps list ${saved.provenance.listId} to the scored mosques`,
  });
  console.log(`  places revision: ${snapshot.places.revision} -> ${updated.revision}`);
  console.log("  The previous dataset file and manifest checkpoint were retained for rollback. Next: npm run data:web");
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
