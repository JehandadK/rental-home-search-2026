/**
 * Import municipal boundaries and railway stations from MLIT 国土数値情報
 * into the reference catalog (`npm run data:reference:ksj`).
 *
 *   npm run data:reference:ksj -- --n03 <dir> --n02 <N02-xx_Station.geojson> [--names <code.xlsx>] [--catalog <dir>] [--dry-run]
 *
 * `--n03` is a directory holding one `N03-YYYYMMDD_PP.geojson` per prefecture
 * (from the unzipped `N03-YYYYMMDD_PP_GML.zip` downloads); every prefecture
 * file in it is imported together, so borders between prefectures stay
 * identical on both sides. `--n02` is the station file from `N02-xx_GML.zip`.
 * Downloads: https://nlftp.mlit.go.jp/ksj/ (N03 行政区域, N02 鉄道). `--names`
 * is the 総務省 全国地方公共団体コード workbook
 * (https://www.soumu.go.jp/denshijiti/code.html), whose kana readings give
 * every city and prefecture its English name. The downloads are inputs only
 * and are not kept in the repository.
 *
 * Boundaries are simplified (topology preserved) to about 20 m. Stations are
 * kept when they lie inside an imported municipality. The catalog update is a
 * revisioned upsert/retire per dataset; re-running with the same files is a
 * no-op. Next: `npm run data:web`.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import { importMunicipalities, type N03FeatureCollection } from "../src/collectors/ksj/municipalities";
import { importStations, type N02StationCollection } from "../src/collectors/ksj/stations";
import { municipalityNamesFromWorkbook } from "../src/collectors/soumu/municipalityNames";
import { planReferenceImport } from "../src/data-layer/referenceImport";

/** ≈ 22 m: borders stay true at street zoom while the catalog stays a few MB. */
const TOLERANCE_DEGREES = 0.0002;
const PRECISION = 5;
/** Islets under 0.05 km² (a few hundred metres across) are dropped. */
const MIN_ISLAND_AREA_KM2 = 0.05;
const CHANGED_BY = "data:reference:ksj";

async function main(): Promise<void> {
  const n03Dir = requiredArg("--n03");
  const n02File = requiredArg("--n02");
  const catalog = argValue("--catalog") ?? REFERENCE_CATALOG_DIR;
  const namesFile = argValue("--names");
  const dryRun = process.argv.includes("--dry-run");

  const n03Files = (await readdir(n03Dir)).filter((name) => /^N03-\d{8}_\d{2}\.geojson$/.test(name)).sort();
  if (n03Files.length === 0) throw new Error(`No N03-YYYYMMDD_PP.geojson files in ${n03Dir}`);
  const editions = new Set(n03Files.map((name) => name.slice(0, 12)));
  if (editions.size !== 1) throw new Error(`Mixed N03 editions in ${n03Dir}: ${[...editions].join(", ")}`);
  const boundaryEdition = [...editions][0];
  const stationEdition = basename(n02File).match(/^(N02-\d{2})_Station\.geojson$/)?.[1];
  if (!stationEdition) throw new Error(`${n02File} is not an N02-xx_Station.geojson file`);

  const collections = await Promise.all(n03Files.map(async (name) =>
    JSON.parse(await readFile(join(n03Dir, name), "utf8")) as N03FeatureCollection));
  const { municipalities, skipped } = importMunicipalities(collections, {
    tolerance: TOLERANCE_DEGREES,
    precision: PRECISION,
    minIslandAreaKm2: MIN_ISLAND_AREA_KM2,
  });
  // The workbook is a zip of XML parts; the system unzip reads them.
  const part = (name: string) => execFileSync("unzip", ["-p", namesFile!, name], { encoding: "utf8", maxBuffer: 1 << 28 });
  const names = namesFile
    ? municipalityNamesFromWorkbook(part("xl/sharedStrings.xml"), [part("xl/worksheets/sheet1.xml"), part("xl/worksheets/sheet2.xml")])
    : new Map();
  const englishFor = (m: { code: string; name: string }) => {
    const name = names.get(m.code);
    return name && name.name === m.name ? name : undefined;
  };
  const unnamed = namesFile ? municipalities.filter((m) => !englishFor(m)) : [];
  const stationData = JSON.parse(await readFile(n02File, "utf8")) as N02StationCollection;
  const stations = importStations(stationData, municipalities.map((m) => ({ key: m.code, geometry: m.geometry })));

  const repository = new JsonReferenceDataRepository(catalog);
  const snapshot = await repository.loadSnapshot();
  const plan = planReferenceImport(
    { cities: snapshot.cities.records, boundaries: snapshot.boundaries.records, places: snapshot.places.records },
    {
      boundaryEdition,
      stationEdition,
      municipalities: municipalities.map((m) => {
        const name = englishFor(m);
        return name ? { ...m, nameEn: name.nameEn, prefectureEn: name.prefectureEn } : m;
      }),
      stations: stations.map(({ area, ...station }) => ({ ...station, municipalityCode: area })),
    },
    new Date().toISOString(),
  );

  const prefectures = new Map<string, number>();
  for (const m of municipalities) prefectures.set(m.prefecture, (prefectures.get(m.prefecture) ?? 0) + 1);
  console.log(`${boundaryEdition}: ${municipalities.length} municipalities from ${n03Files.length} prefecture files`);
  for (const [prefecture, count] of prefectures) console.log(`  ${prefecture} ${count}`);
  for (const entry of skipped) console.log(`  skipped ${entry.name} (${entry.code ?? "no code"}): ${entry.reason}, ${entry.features} features`);
  if (namesFile) {
    console.log(`English names for ${municipalities.length - unnamed.length} municipalities`);
    for (const m of unnamed) console.log(`  no English name for ${m.name} (${m.code}); it keeps its local name`);
  }
  console.log(`${stationEdition}: ${stations.length} stations inside those municipalities`);
  console.log(
    `Plan: cities +${plan.cities.upsert.length}; ` +
      `boundaries +${plan.boundaries.upsert.length} −${plan.boundaries.retire?.length ?? 0}; ` +
      `places +${plan.places.upsert.length} −${plan.places.retire?.length ?? 0}`,
  );
  if (dryRun) {
    console.log("Dry run: the catalog was not changed");
    return;
  }

  const reason = `Import ${boundaryEdition} municipal boundaries and ${stationEdition} railway stations (MLIT 国土数値情報)`;
  if (plan.cities.upsert.length) {
    const updated = await repository.updateCities(plan.cities, { expectedRevision: snapshot.cities.revision, changedBy: CHANGED_BY, reason });
    console.log(`  cities revision: ${snapshot.cities.revision} -> ${updated.revision}`);
  }
  if (plan.boundaries.upsert.length || plan.boundaries.retire?.length) {
    const updated = await repository.updateBoundaries(plan.boundaries, { expectedRevision: snapshot.boundaries.revision, changedBy: CHANGED_BY, reason });
    console.log(`  boundaries revision: ${snapshot.boundaries.revision} -> ${updated.revision}`);
  }
  if (plan.places.upsert.length || plan.places.retire?.length) {
    const updated = await repository.updatePlaces(plan.places, { expectedRevision: snapshot.places.revision, changedBy: CHANGED_BY, reason });
    console.log(`  places revision: ${snapshot.places.revision} -> ${updated.revision}`);
  }
  console.log("  The previous dataset files and manifest checkpoints were retained for rollback. Next: npm run data:web");
}

function requiredArg(name: string): string {
  const value = argValue(name);
  if (!value) throw new Error(`${name} is required (see the header of scripts/import-ksj-reference.ts)`);
  return value;
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
  // Each dataset commits on its own; re-running completes a partly applied import.
  console.error("If some datasets were already updated, re-run the same command to finish the import.");
  process.exitCode = 1;
});
