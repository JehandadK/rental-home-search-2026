import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

async function readLegacyCount(file: string): Promise<number> {
  const value = JSON.parse(await readFile(join(root, "src", "data", file), "utf8")) as unknown[];
  return value.length;
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
