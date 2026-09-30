import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildReferenceModel } from "../src/domain/referenceData";
import { DATA_DIR, REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { LEGACY_REFERENCE_FILES } from "../src/storage/json/dataMigrations/legacyReferenceFiles";
import { comparablePlace, legacyPlaceCatalog } from "../src/storage/json/dataMigrations/legacyPlaceCatalog.contract";
import { planAppPlaceAnnotations } from "../src/storage/json/dataMigrations/legacyReference";
import type { PointOfInterest } from "../src/domain/types";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts", "pin-reference-app-ids.ts");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempCopy(from: string, files?: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pin-app-ids-"));
  dirs.push(dir);
  if (files) for (const file of files) await cp(join(from, file), join(dir, file));
  else await cp(from, dir, { recursive: true });
  return dir;
}

const run = (catalog: string, legacy = DATA_DIR) =>
  execFileSync(process.execPath, ["--import", "tsx", script, "--catalog", catalog, "--legacy", legacy], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });

async function snapshotFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of (await readdir(dir)).sort()) out[file] = await readFile(join(dir, file), "utf8");
  return out;
}

/** A freshly migrated, unpinned catalog, as data:reference:migrate created it. */
async function freshCatalog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pin-app-ids-"));
  dirs.push(dir);
  const catalog = join(dir, "catalog");
  migrate(catalog);
  return catalog;
}

const migrate = (output: string) =>
  execFileSync(process.execPath, ["--import", "tsx", join(root, "scripts", "migrate-reference-data.ts"), "--output", output], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });

describe("the checked-in reference catalog", () => {
  it("already has its app place ids pinned", () => {
    expect(run(REFERENCE_CATALOG_DIR)).toContain("already pinned");
  });
});

describe("pinning app place ids into the reference catalog", () => {
  it("makes the catalog reproduce the pre-M5 app catalog, and is a no-op when re-run", async () => {
    const catalog = await freshCatalog();
    const before = await snapshotFiles(catalog);
    const repository = new JsonReferenceDataRepository(catalog);
    const original = await repository.loadSnapshot();

    const expected = legacyPlaceCatalog(DATA_DIR);
    const output = run(catalog);
    // Every place gains an app id, and the subtitles that were missing are filled in.
    expect(output).toMatch(/Pinned app ids for \d+ places/);

    const annotated = await repository.loadSnapshot();
    expect(annotated.places.revision).not.toBe(original.places.revision);
    expect(annotated.places.records.map((record) => record.id)).toEqual(original.places.records.map((record) => record.id));
    const { catalog: places } = buildReferenceModel(annotated);
    expect(places.places.map(comparablePlace)).toEqual(expected.map(comparablePlace));
    // Existing attributes survive; POI roles still resolve.
    const pois = JSON.parse(await readFile(join(DATA_DIR, "pois.json"), "utf8")) as PointOfInterest[];
    expect(places.withRole("poi1")?.name).toBe(pois.find((poi) => poi.id === "poi1")?.name);
    expect(places.withRole("poi2")?.name).toBe(pois.find((poi) => poi.id === "poi2")?.name);
    expect(annotated.places.provenance?.lastChange).toMatchObject({ changedBy: "data:reference:app-ids" });

    // Previous files are retained unchanged; only a new revision and the manifest checkpoint are added.
    const after = await snapshotFiles(catalog);
    for (const [file, content] of Object.entries(before)) {
      if (file !== "manifest.json") expect(after[file], file).toBe(content);
    }
    expect(Object.keys(after).filter((file) => !(file in before))).toHaveLength(2);

    expect(run(catalog)).toContain("already pinned");
    expect(await snapshotFiles(catalog)).toEqual(after);

    // The legacy migration command still recognises the catalog it created.
    expect(migrate(catalog)).toContain("already matches the legacy inputs");
    expect(await snapshotFiles(catalog)).toEqual(after);
  });

  it("pins places added after the migration, so later changes cannot shift their ids", async () => {
    const catalog = await freshCatalog();
    run(catalog);
    const repository = new JsonReferenceDataRepository(catalog);
    const pinned = await repository.loadSnapshot();
    const now = new Date().toISOString();
    const added = (id: string, name: string) => ({ id, category: "busStop", name, lat: 35.83, lon: 139.8, status: "active" as const, updatedAt: now });
    const existingName = pinned.places.records.find((record) => record.category === "busStop")!.name;
    await repository.updatePlaces({ upsert: [added("busStop:zz-new-1", "新しい停留所"), added("busStop:zz-new-2", existingName)] },
      { expectedRevision: pinned.places.revision, changedBy: "test", reason: "add stops" });

    expect(run(catalog)).toContain("Pinned app ids for 2 places");
    const after = await repository.loadSnapshot();
    const pins = new Map(after.places.records.map((record) => [record.id, record.attributes]));
    expect(pins.get("busStop:zz-new-1")).toMatchObject({ appPlaceId: "busStop:新しい停留所" });
    // A repeated name gets the next free suffix, never an existing place's id.
    const repeated = pins.get("busStop:zz-new-2")?.appPlaceId as string;
    expect(repeated).toMatch(new RegExp(`^busStop:${existingName}#\\d+$`));
    const ids = after.places.records.map((record) => record.attributes?.appPlaceId);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = after.places.records.map((record) => record.attributes?.appOrder as number);
    expect(Math.max(...orders)).toBe(orders.length - 1);
    // Existing places keep their pins and the catalog still reproduces the pre-M5 ids.
    expect(buildReferenceModel(after).catalog.places.slice(0, -2).map(comparablePlace))
      .toEqual(legacyPlaceCatalog(DATA_DIR).map(comparablePlace));
    expect(run(catalog)).toContain("already pinned");
  });

  it("refuses when the original files no longer match the catalog's migration inputs", async () => {
    const catalog = await freshCatalog();
    const legacy = await tempCopy(DATA_DIR, LEGACY_REFERENCE_FILES);
    const busStops = JSON.parse(await readFile(join(legacy, "bus_stops.json"), "utf8")) as unknown[];
    await writeFile(join(legacy, "bus_stops.json"), JSON.stringify(busStops.reverse()));
    const before = await snapshotFiles(catalog);

    expect(() => run(catalog, legacy)).toThrow();
    expect(await snapshotFiles(catalog)).toEqual(before);
  });

  it("fails closed when a legacy place is missing from the catalog", async () => {
    const snapshot = await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot();
    const { readLegacyReferenceFiles } = await import("../src/storage/json/dataMigrations/legacyReferenceFiles");
    const { legacy } = await readLegacyReferenceFiles(DATA_DIR);
    expect(() => planAppPlaceAnnotations(legacy, snapshot.places.records.slice(1), new Date().toISOString()))
      .toThrow(/Catalog has no record/);
  });
});
