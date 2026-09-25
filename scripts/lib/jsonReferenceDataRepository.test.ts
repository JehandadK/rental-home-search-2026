import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RevisionConflictError } from "../../src/data-layer/errors";
import { JsonReferenceDataRepository } from "./jsonReferenceDataRepository";

const roots: string[] = [];
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

async function makeRepository(): Promise<{ repo: JsonReferenceDataRepository; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "reference-repository-test-"));
  roots.push(root);
  const directory = join(root, "catalog");
  await cp(join(projectRoot, "data", "reference", "v1"), directory, { recursive: true });
  return { repo: new JsonReferenceDataRepository(directory), directory };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const writeOptions = (expectedRevision: string) => ({
  expectedRevision,
  changedBy: "test",
  reason: "repository contract test",
});

function newPoi(id: string) {
  return {
    id,
    category: "poi",
    name: `New POI ${id}`,
    lat: 35.9,
    lon: 139.9,
    status: "active" as const,
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}

describe("JSON reference-data repository", () => {
  it("loads all managed datasets with the manifest and checksums intact", async () => {
    const { repo } = await makeRepository();
    const snapshot = await repo.loadSnapshot();
    expect(snapshot.cities.records.length).toBeGreaterThan(0);
    expect(snapshot.boundaries.records.length).toBeGreaterThan(0);
    expect(snapshot.places.records.length).toBeGreaterThan(0);
    expect(snapshot.places.records.filter((place) => place.category === "poi").length).toBeGreaterThan(0);
  });

  it("publishes an upsert through a new immutable dataset file and preserves the prior version", async () => {
    const { repo, directory } = await makeRepository();
    const before = await repo.loadSnapshot();
    const oldPath = join(directory, "places.json");
    const oldBytes = await readFile(oldPath, "utf8");
    const originalPoi = before.places.records.find((place) => place.category === "poi")!;

    const updated = await repo.updatePlaces(
      {
        upsert: [
          newPoi("poi:extra"),
          {
            id: originalPoi.id,
            category: originalPoi.category,
            name: `${originalPoi.name} updated`,
            lat: originalPoi.lat,
            lon: originalPoi.lon,
            status: "active",
            updatedAt: "2026-09-25T00:00:00.000Z",
          },
        ],
      },
      writeOptions(before.places.revision),
    );
    const after = await repo.loadSnapshot();
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
      datasets: { places: { file: string; revision: string; count: number } };
    };

    expect(updated.revision).not.toBe(before.places.revision);
    expect(after.revision).not.toBe(before.revision);
    expect(after.places.records.some((place) => place.id === "poi:extra")).toBe(true);
    expect(after.places.records.find((place) => place.id === originalPoi.id)?.attributes).toEqual(originalPoi.attributes);
    expect(manifest.datasets.places.file).toBe(`places.${updated.revision}.json`);
    expect(manifest.datasets.places.count).toBe(before.places.records.length + 1);
    await expect(readFile(oldPath, "utf8")).resolves.toBe(oldBytes);
  });

  it("retires instead of deleting and rejects stale revisions", async () => {
    const { repo } = await makeRepository();
    const before = await repo.loadSnapshot();
    const place = before.places.records[0];
    const retired = await repo.updatePlaces(
      { upsert: [], retire: [{ id: place.id, effectiveAt: "2026-09-25T01:00:00.000Z", reason: "fixture removed" }] },
      writeOptions(before.places.revision),
    );
    const snapshot = await repo.loadSnapshot();
    const record = snapshot.places.records.find((candidate) => candidate.id === place.id);

    expect(retired.records).toHaveLength(before.places.records.length);
    expect(record).toMatchObject({ status: "retired", retirementReason: "fixture removed" });
    await expect(
      repo.updatePlaces({ upsert: [newPoi("poi:stale")] }, writeOptions(before.places.revision)),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(repo.loadSnapshot()).resolves.toMatchObject({
      places: { records: expect.not.arrayContaining([expect.objectContaining({ id: "poi:stale" })]) },
    });
  });

  it("serializes concurrent writers using the same expected revision", async () => {
    const { repo } = await makeRepository();
    const before = await repo.loadSnapshot();
    const writes = await Promise.allSettled([
      repo.updatePlaces({ upsert: [newPoi("poi:a")] }, writeOptions(before.places.revision)),
      repo.updatePlaces({ upsert: [newPoi("poi:b")] }, writeOptions(before.places.revision)),
    ]);
    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    const rejected = writes.find((write) => write.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(RevisionConflictError);
  });

  it("supports multipolygon boundary updates and validates city references", async () => {
    const { repo } = await makeRepository();
    const before = await repo.loadSnapshot();
    const current = before.boundaries.records[0];
    const ring = current.geometry.type === "Polygon"
      ? current.geometry.coordinates
      : current.geometry.coordinates[0];
    const geometry = { type: "MultiPolygon" as const, coordinates: [ring, ring] };
    const updated = await repo.updateBoundaries(
      { upsert: [{ ...current, geometry, updatedAt: "2026-09-25T00:00:00.000Z" }] },
      writeOptions(before.boundaries.revision),
    );
    expect(updated.records.find((record) => record.id === current.id)?.geometry.type).toBe("MultiPolygon");
  });
});
