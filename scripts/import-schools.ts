/**
 * Add a saved list of elementary schools and childcare facilities to the
 * reference catalog (`npm run data:reference:schools`).
 *
 *   npm run data:reference:schools -- [--file <saved list>] [--catalog <dir>] [--dry-run]
 *
 * The list is a saved OpenStreetMap extract for some cities, by default
 * `data/reference/imports/osm-schools-koshigaya-soka.json`; its provenance
 * records the Overpass query. Entries the catalog already has (same category
 * and name, at the same spot) are skipped; the rest become `school` and
 * `childcare` places, so the nearest-school and nearest-kindergarten scores
 * count them. Re-running is a no-op.
 * Next: `npm run data:web`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { DATA_DIR, REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import type { ReferencePlaceRecord } from "../src/data-layer/contracts";
import { planSchoolImport } from "../src/data-layer/schoolImport";

const DEFAULT_FILE = join(DATA_DIR, "reference", "imports", "osm-schools-koshigaya-soka.json");
const CHANGED_BY = "data:reference:schools";

interface SavedList {
  provenance: { source: string; capturedAt: string; cities: string[] };
  records: ReferencePlaceRecord[];
}

async function main(): Promise<void> {
  const file = argValue("--file") ?? DEFAULT_FILE;
  const catalog = argValue("--catalog") ?? REFERENCE_CATALOG_DIR;
  const dryRun = process.argv.includes("--dry-run");

  const saved = JSON.parse(await readFile(file, "utf8")) as SavedList;
  const repository = new JsonReferenceDataRepository(catalog);
  const snapshot = await repository.loadSnapshot();
  const plan = planSchoolImport(snapshot.places.records, saved.records, new Date().toISOString());
  const cities = saved.provenance.cities.join(", ");

  console.log(`${saved.provenance.source} (${cities}), captured ${saved.provenance.capturedAt}: ${saved.records.length} schools and childcare facilities`);
  console.log(`  already in the catalog: ${plan.matched.length}`);
  for (const record of plan.places.upsert) console.log(`  + ${record.category}: ${record.name}`);
  console.log(`Plan: places +${plan.places.upsert.length}`);
  if (dryRun) {
    console.log("Dry run: the catalog was not changed");
    return;
  }
  if (plan.places.upsert.length === 0) {
    console.log(`The list is already in ${catalog}`);
    return;
  }
  const updated = await repository.updatePlaces(plan.places, {
    expectedRevision: snapshot.places.revision,
    changedBy: CHANGED_BY,
    reason: `Add the elementary schools and childcare facilities of ${cities} (${saved.provenance.source}, ${saved.provenance.capturedAt})`,
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
