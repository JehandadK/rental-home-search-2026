import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildcareFacility, Mosque, NamedPlace, PointOfInterest, Station } from "../src/domain/types";
import type { CityBoundaryRecord, CityRecord, ReferencePlaceRecord, VersionedDataset } from "../src/data-layer/contracts";

const roots: string[] = [];
const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts", "migrate-reference-data.ts");

async function outputDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reference-migration-test-"));
  roots.push(dir);
  return join(dir, "catalog");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function readLegacy<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(root, "src", "data", file), "utf8")) as T;
}

async function readLegacyCount(file: string): Promise<number> {
  const value = await readLegacy<unknown[]>(file);
  return value.length;
}

async function readDataset<T>(path: string): Promise<VersionedDataset<T>> {
  return JSON.parse(await readFile(path, "utf8")) as VersionedDataset<T>;
}

function takeMatch<T>(rows: T[], predicate: (row: T) => boolean, description: string): T {
  const index = rows.findIndex(predicate);
  expect(index, `missing migrated record: ${description}`).toBeGreaterThanOrEqual(0);
  return rows.splice(index, 1)[0];
}

function run(output: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", script, "--output", output], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("managed reference migration command", () => {
  it("writes the versioned catalog atomically and safely re-runs on unchanged inputs", async () => {
    const output = await outputDirectory();
    const created = run(output);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as {
      schemaVersion: number;
      counts: { cities: number; boundaries: number; places: number; placesByCategory: Record<string, number> };
      datasets: Record<string, { count: number; revision: string }>;
    };

    expect(created).toContain("Created managed reference catalog");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.counts.cities).toBeGreaterThan(0);
    expect(manifest.counts.boundaries).toBeGreaterThan(0);
    expect(manifest.counts.places).toBeGreaterThan(0);
    const legacyCounts = await Promise.all([
      readLegacyCount("pois.json"),
      readLegacyCount("mosques.json"),
      readLegacyCount("stations.json"),
      readLegacyCount("elementary_schools.json"),
      readLegacyCount("kindergartens.json"),
      readLegacyCount("bus_stops.json"),
      readLegacyCount("neighbor_boundaries.json"),
    ]);
    const expectedCategoryCounts: Record<string, number> = {};
    ["poi", "mosque", "station", "school", "childcare", "busStop"].forEach((category, index) => {
      if (legacyCounts[index] > 0) expectedCategoryCounts[category] = legacyCounts[index];
    });
    expect(manifest.counts.placesByCategory).toEqual(expectedCategoryCounts);
    expect(manifest.counts.boundaries).toBe(1 + legacyCounts[6]);
    expect(Object.values(manifest.counts.placesByCategory).reduce((sum, count) => sum + count, 0)).toBe(manifest.counts.places);
    expect(manifest.datasets.cities.count).toBe(manifest.counts.cities);
    expect(manifest.datasets.boundaries.count).toBe(manifest.counts.boundaries);
    expect(manifest.datasets.places.count).toBe(manifest.counts.places);

    const [legacyPois, legacyMosques, legacyStations, legacySchools, legacyChildcare, legacyBusStops] = await Promise.all([
      readLegacy<PointOfInterest[]>("pois.json"),
      readLegacy<Mosque[]>("mosques.json"),
      readLegacy<Station[]>("stations.json"),
      readLegacy<NamedPlace[]>("elementary_schools.json"),
      readLegacy<ChildcareFacility[]>("kindergartens.json"),
      readLegacy<NamedPlace[]>("bus_stops.json"),
    ]);
    const [places, cities, boundaries] = await Promise.all([
      readDataset<ReferencePlaceRecord>(join(output, "places.json")),
      readDataset<CityRecord>(join(output, "cities.json")),
      readDataset<CityBoundaryRecord>(join(output, "boundaries.json")),
    ]);
    const remaining = new Map<string, ReferencePlaceRecord[]>(
      ["poi", "mosque", "station", "school", "childcare", "busStop"].map((category) => [
        category,
        places.records.filter((place) => place.category === category),
      ]),
    );
    for (const source of legacyPois) {
      const place = takeMatch(remaining.get("poi")!, (row) => row.attributes?.legacyId === source.id, source.id);
      expect(place).toMatchObject({ name: source.name, nameLocal: source.nameJa, address: source.address, lat: source.lat, lon: source.lon });
    }
    for (const source of legacyMosques) {
      const place = takeMatch(remaining.get("mosque")!, (row) => row.name === source.name && row.lat === source.lat && row.lon === source.lon, source.name);
      expect(place).toMatchObject({ nameLocal: source.nameJa, address: source.address, attributes: source.source ? { source: source.source } : undefined });
    }
    for (const source of legacyStations) {
      const place = takeMatch(remaining.get("station")!, (row) => row.name === source.name && row.lat === source.lat && row.lon === source.lon, source.name);
      expect(place.attributes).toMatchObject({ nameEn: source.nameEn, operator: source.operator });
    }
    for (const source of legacySchools) {
      takeMatch(remaining.get("school")!, (row) => row.name === source.name && row.lat === source.lat && row.lon === source.lon, source.name);
    }
    for (const source of legacyChildcare) {
      const place = takeMatch(remaining.get("childcare")!, (row) => row.name === source.name && row.lat === source.lat && row.lon === source.lon, source.name);
      expect(place).toMatchObject({ subtitle: source.type, attributes: { facilityType: source.type } });
    }
    for (const source of legacyBusStops) {
      takeMatch(remaining.get("busStop")!, (row) => row.name === source.name && row.lat === source.lat && row.lon === source.lon, source.name);
    }
    for (const rows of remaining.values()) expect(rows).toHaveLength(0);

    const cityNames = new Set(cities.records.map((city) => city.nameLocal));
    expect(cityNames.size).toBe(cities.records.length);
    const soka = boundaries.records.find((boundary) => cities.records.find((city) => city.id === boundary.cityId)?.nameLocal === "草加市");
    expect(soka?.geometry.type).toBe("Polygon");
    if (soka?.geometry.type === "Polygon") expect(soka.geometry.coordinates[0]).toEqual(await readLegacy("soka_boundary.json"));
    const legacyNeighbors = await readLegacy<Array<{ name: string; ring: readonly (readonly [number, number])[] }>>("neighbor_boundaries.json");
    for (const source of legacyNeighbors) {
      const city = cities.records.find((record) => record.nameLocal === source.name);
      expect(city, `missing city ${source.name}`).toBeTruthy();
      const boundary = boundaries.records.find((record) => record.cityId === city?.id);
      expect(boundary?.geometry.type).toBe("Polygon");
      if (boundary?.geometry.type === "Polygon") expect(boundary.geometry.coordinates[0]).toEqual(source.ring);
    }
    expect(run(output)).toContain("already matches the legacy inputs");
  });

  it("refuses to overwrite a catalog changed after migration", async () => {
    const output = await outputDirectory();
    run(output);
    const placesPath = join(output, "places.json");
    const places = JSON.parse(await readFile(placesPath, "utf8")) as { records: unknown[] };
    places.records.push({ id: "manual-change" });
    const modified = JSON.stringify(places);
    await writeFile(placesPath, modified, "utf8");

    expect(() => run(output)).toThrow("Refusing to overwrite existing reference catalog");
    await expect(readFile(placesPath, "utf8")).resolves.toBe(modified);
  });
});
