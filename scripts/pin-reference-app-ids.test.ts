import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ReferencePlaceRecord } from "../src/data-layer/contracts";
import { planPlacePins } from "../src/data-layer/referencePins";
import { buildReferenceModel } from "../src/domain/referenceData";
import { REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts", "pin-reference-app-ids.ts");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function catalogCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pin-app-ids-"));
  dirs.push(dir);
  await cp(REFERENCE_CATALOG_DIR, dir, { recursive: true });
  return dir;
}

const run = (catalog: string) =>
  execFileSync(process.execPath, ["--import", "tsx", script, "--catalog", catalog], { cwd: root, encoding: "utf8", timeout: 30_000 });

async function files(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of (await readdir(dir)).sort()) out[file] = await readFile(join(dir, file), "utf8");
  return out;
}

const AT = "2026-09-30T00:00:00.000Z";
const record = (id: string, name: string, extra: Partial<ReferencePlaceRecord> = {}): ReferencePlaceRecord =>
  ({ id, category: "busStop", name, lat: 35.83, lon: 139.8, status: "active", updatedAt: AT, ...extra });

describe("planPlacePins", () => {
  it("pins unpinned active places after the pinned ones, avoiding every pinned id", () => {
    const changes = planPlacePins([
      record("a", "東口", { attributes: { appPlaceId: "busStop:東口", appOrder: 0 } }),
      record("b", "東口", { status: "retired", retiredAt: AT, retirementReason: "moved", attributes: { appPlaceId: "busStop:東口#1", appOrder: 1 } }),
      record("c", "東口"),
      record("d", "西口"),
      record("e", "北口", { status: "retired", retiredAt: AT, retirementReason: "closed" }),
    ], AT);
    expect(changes.map((change) => [change.id, change.attributes])).toEqual([
      ["c", { appPlaceId: "busStop:東口#2", appOrder: 2 }],
      ["d", { appPlaceId: "busStop:西口", appOrder: 3 }],
    ]);
  });

  it("plans nothing when every active place is pinned", () => {
    expect(planPlacePins([record("a", "東口", { attributes: { appPlaceId: "busStop:東口", appOrder: 0 } })], AT)).toEqual([]);
  });
});

describe("pinning app place ids into the reference catalog", () => {
  it("has every place pinned in the checked-in catalog", () => {
    expect(run(REFERENCE_CATALOG_DIR)).toContain("already pinned");
  });

  it("pins added places as a revisioned update without moving existing pins", async () => {
    const catalog = await catalogCopy();
    const repository = new JsonReferenceDataRepository(catalog);
    const before = await repository.loadSnapshot();
    const existingIds = buildReferenceModel(before).catalog.places.map((place) => place.id);
    const existingName = before.places.records.find((place) => place.category === "busStop")!.name;
    await repository.updatePlaces({ upsert: [record("busStop:zz-new-1", "新しい停留所"), record("busStop:zz-new-2", existingName)] },
      { expectedRevision: before.places.revision, changedBy: "test", reason: "add stops" });
    const filesBefore = await files(catalog);

    expect(run(catalog)).toContain("Pinned app ids for 2 places");
    const after = await repository.loadSnapshot();
    const pins = new Map(after.places.records.map((place) => [place.id, place.attributes]));
    expect(pins.get("busStop:zz-new-1")).toMatchObject({ appPlaceId: "busStop:新しい停留所" });
    expect(String(pins.get("busStop:zz-new-2")?.appPlaceId)).toMatch(new RegExp(`^busStop:${existingName}#\\d+$`));
    expect(after.places.provenance?.lastChange).toMatchObject({ changedBy: "data:reference:app-ids" });

    const ids = buildReferenceModel(after).catalog.places.map((place) => place.id);
    expect(ids.slice(0, existingIds.length)).toEqual(existingIds);
    expect(new Set(ids).size).toBe(ids.length);

    // Earlier files are kept; one dataset revision and one manifest checkpoint are added.
    const filesAfter = await files(catalog);
    for (const [file, content] of Object.entries(filesBefore)) if (file !== "manifest.json") expect(filesAfter[file], file).toBe(content);
    expect(Object.keys(filesAfter).filter((file) => !(file in filesBefore))).toHaveLength(2);
    expect(run(catalog)).toContain("already pinned");
    expect(await files(catalog)).toEqual(filesAfter);
  });
});
