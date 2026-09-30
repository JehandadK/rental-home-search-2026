import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DATA_DIR, atomicWriteJson } from "../src/storage/json/dataStore";
import { withFileLock } from "../src/node/jsonFile";
import { catalogRevision, CURRENT_CATALOG_REVISION_ALGORITHM, legacyCatalogRevision } from "../src/storage/json/referenceCatalog";
import { migrateLegacyReferenceData, type LegacyReferenceData } from "../src/storage/json/dataMigrations/legacyReference";
import type { ReferenceCatalogManifest, ReferenceDataSnapshot, VersionedDataset } from "../src/data-layer/contracts";

const SOURCE_FILES = [
  "pois.json",
  "mosques.json",
  "stations.json",
  "elementary_schools.json",
  "kindergartens.json",
  "bus_stops.json",
  "soka_boundary.json",
  "neighbor_boundaries.json",
] as const;
const DEFAULT_OUTPUT = resolve(DATA_DIR, "../../data/reference/v1");

async function main(): Promise<void> {
  const output = outputPath(process.argv.slice(2));
  await withFileLock(output, async () => {
    const { legacy, sourceFiles } = await readLegacyInputs();
    if (existsSync(output)) {
      if (await existingOutputMatches(output, sourceFiles)) {
        console.log(`Reference catalog already matches the legacy inputs: ${output}`);
        return;
      }
      throw new Error(
        `Refusing to overwrite existing reference catalog ${output}. ` +
          `Choose a new --output path; replacement requires a reviewed backup/migration.`,
      );
    }

    const migratedAt = new Date().toISOString();
    const snapshot = migrateLegacyReferenceData(legacy, migratedAt);
    const manifest = makeManifest(snapshot, migratedAt, sourceFiles);
    const parent = dirname(output);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, `.${basename(output)}.tmp-${process.pid}-${randomUUID()}-`));
    try {
      await atomicWriteJson(join(staging, "cities.json"), snapshot.cities);
      await atomicWriteJson(join(staging, "boundaries.json"), snapshot.boundaries);
      await atomicWriteJson(join(staging, "places.json"), snapshot.places);
      // The manifest is written last inside staging and the directory only
      // becomes visible after all datasets are fully written.
      await atomicWriteJson(join(staging, "manifest.json"), manifest);
      await rename(staging, output);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    console.log(`Created managed reference catalog: ${output}`);
    console.log(`  cities: ${snapshot.cities.records.length}`);
    console.log(`  boundaries: ${snapshot.boundaries.records.length}`);
    console.log(`  places: ${snapshot.places.records.length} (${snapshot.places.records.filter((p) => p.category === "poi").length} POIs)`);
    console.log(`  revision: ${snapshot.revision}`);
  });
}

async function readLegacyInputs(): Promise<{ legacy: LegacyReferenceData; sourceFiles: Record<string, string> }> {
  const parsed = new Map<string, unknown>();
  const sourceFiles: Record<string, string> = {};
  for (const file of SOURCE_FILES) {
    const raw = await readFile(join(DATA_DIR, file), "utf8");
    parsed.set(file, JSON.parse(raw) as unknown);
    sourceFiles[file] = createHash("sha256").update(raw).digest("hex");
  }
  return {
    legacy: {
      pois: parsed.get("pois.json") as LegacyReferenceData["pois"],
      mosques: parsed.get("mosques.json") as LegacyReferenceData["mosques"],
      stations: parsed.get("stations.json") as LegacyReferenceData["stations"],
      schools: parsed.get("elementary_schools.json") as LegacyReferenceData["schools"],
      childcare: parsed.get("kindergartens.json") as LegacyReferenceData["childcare"],
      busStops: parsed.get("bus_stops.json") as LegacyReferenceData["busStops"],
      sokaBoundary: parsed.get("soka_boundary.json") as LegacyReferenceData["sokaBoundary"],
      neighborBoundaries: parsed.get("neighbor_boundaries.json") as LegacyReferenceData["neighborBoundaries"],
    },
    sourceFiles,
  };
}

async function existingOutputMatches(output: string, sourceFiles: Record<string, string>): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as ReferenceCatalogManifest;
    if (
      manifest.schemaVersion !== 1 ||
      (manifest.revisionAlgorithm != null && manifest.revisionAlgorithm !== 1 && manifest.revisionAlgorithm !== 2) ||
      JSON.stringify(manifest.sourceFiles) !== JSON.stringify(sourceFiles) ||
      !manifest.counts?.placesByCategory
    ) return false;
    const [cities, boundaries, places] = await Promise.all([
      readDataset(join(output, "cities.json")),
      readDataset(join(output, "boundaries.json")),
      readDataset(join(output, "places.json")),
    ]);
    const datasets = { cities, boundaries, places };
    for (const [datasetId, dataset] of Object.entries(datasets)) {
      if (
        dataset.datasetId !== datasetId ||
        dataset.schemaVersion !== manifest.datasets[datasetId]?.schemaVersion ||
        !Array.isArray(dataset.records) ||
        dataset.records.length !== manifest.datasets[datasetId]?.count ||
        digest(JSON.stringify(dataset.records)) !== dataset.revision ||
        dataset.revision !== manifest.datasets[datasetId]?.revision
      ) return false;
    }
    const placesByCategory: Record<string, number> = {};
    for (const value of places.records) {
      if (!value || typeof value !== "object" || typeof (value as { category?: unknown }).category !== "string") return false;
      const category = (value as { category: string }).category;
      placesByCategory[category] = (placesByCategory[category] ?? 0) + 1;
    }
    if (
      manifest.counts.cities !== cities.records.length ||
      manifest.counts.boundaries !== boundaries.records.length ||
      manifest.counts.places !== places.records.length ||
      JSON.stringify(Object.entries(manifest.counts.placesByCategory).sort()) !== JSON.stringify(Object.entries(placesByCategory).sort())
    ) return false;
    const expectedRevision = manifest.revisionAlgorithm === CURRENT_CATALOG_REVISION_ALGORITHM
      ? catalogRevision(manifest)
      : legacyCatalogRevision(manifest);
    return manifest.revision === expectedRevision;
  } catch {
    return false;
  }
}

async function readDataset(path: string): Promise<VersionedDataset<unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as VersionedDataset<unknown>;
}

function makeManifest(
  snapshot: ReferenceDataSnapshot,
  migratedAt: string,
  sourceFiles: Record<string, string>,
): ReferenceCatalogManifest {
  const placesByCategory: Record<string, number> = {};
  for (const place of snapshot.places.records) {
    placesByCategory[place.category] = (placesByCategory[place.category] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    revisionAlgorithm: CURRENT_CATALOG_REVISION_ALGORITHM,
    revision: snapshot.revision,
    migratedAt,
    datasets: {
      cities: datasetManifest("cities.json", snapshot.cities),
      boundaries: datasetManifest("boundaries.json", snapshot.boundaries),
      places: datasetManifest("places.json", snapshot.places),
    },
    counts: {
      cities: snapshot.cities.records.length,
      boundaries: snapshot.boundaries.records.length,
      places: snapshot.places.records.length,
      placesByCategory,
    },
    sourceFiles,
  };
}

function datasetManifest<T>(file: string, dataset: VersionedDataset<T>) {
  return {
    file,
    schemaVersion: dataset.schemaVersion,
    revision: dataset.revision,
    count: dataset.records.length,
  };
}

function outputPath(args: string[]): string {
  const index = args.indexOf("--output");
  if (index < 0) return DEFAULT_OUTPUT;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a directory path");
  return resolve(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
