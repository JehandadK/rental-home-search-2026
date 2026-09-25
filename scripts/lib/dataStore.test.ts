import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RawListing } from "../../src/types";
import { JsonSourceStore, RevisionConflictError, ShrinkGuardError } from "./dataStore";

const roots: string[] = [];

async function makeStore(): Promise<JsonSourceStore> {
  const root = await mkdtemp(join(tmpdir(), "rental-source-store-"));
  roots.push(root);
  const sources = join(root, "sources");
  const backups = join(root, "backups");
  await mkdir(sources, { recursive: true });
  await mkdir(backups, { recursive: true });
  return new JsonSourceStore(sources, backups);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const listing = (id: string): RawListing => ({
  id,
  name: `Unit ${id}`,
  address: "埼玉県草加市",
  rent: 80_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2000,
  stationWalkMin: null,
  url: `https://example.test/${id}`,
  source: "fixture",
});

const source = (listings: RawListing[], scrapedAt: string) => ({
  source: "fixture",
  scrapedAt,
  completeSnapshot: false,
  listings,
});

describe("JSON source-store revision safety", () => {
  it("accepts a create against the absent revision and returns a committed revision", async () => {
    const store = await makeStore();
    const result = await store.writeSource(source([listing("1")], "2026-09-25T00:00:00.000Z"), {
      expectedRevision: null,
    });

    expect(result.previousCount).toBe(0);
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.readSource("fixture")).resolves.toMatchObject({
      revision: result.revision,
      count: 1,
      listings: [{ id: "1" }],
    });
  });

  it("allows only one concurrent writer with the same expected revision", async () => {
    const store = await makeStore();
    const initial = await store.writeSource(source([listing("1")], "initial"), { expectedRevision: null });
    const expectedRevision = initial.revision;

    const outcomes = await Promise.allSettled([
      store.writeSource(source([listing("2")], "writer-a"), { expectedRevision }),
      store.writeSource(source([listing("3")], "writer-b"), { expectedRevision }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(RevisionConflictError);
    const committed = await store.readSource("fixture");
    expect(committed?.listings).toHaveLength(1);
    expect(["2", "3"]).toContain(committed?.listings[0].id);
  });

  it("hashes legacy source files on read and upgrades them on the next write", async () => {
    const store = await makeStore();
    const path = store.sourcePath("fixture");
    const legacy = { ...source([listing("1")], "legacy"), count: 1 };
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const previous = await store.readSource("fixture");
    expect(previous?.revision).toMatch(/^[a-f0-9]{64}$/);

    const result = await store.writeSource(source([listing("1"), listing("2")], "upgraded"), {
      expectedRevision: previous!.revision!,
    });
    expect(result.revision).not.toBe(previous?.revision);
    await expect(readFile(path, "utf8")).resolves.toContain(`"revision": "${result.revision}"`);
  });

  it("preserves unknown legacy fields when an older writer updates a source", async () => {
    const store = await makeStore();
    const path = store.sourcePath("fixture");
    const legacy = { ...source([listing("1")], "legacy"), count: 1, sourceSpecificExtension: { retained: true } };
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const previous = await store.readSource("fixture");

    await store.writeSource(source([listing("1"), listing("2")], "updated"), {
      expectedRevision: previous!.revision!,
    });
    await expect(readFile(path, "utf8")).resolves.toContain('"sourceSpecificExtension": {\n    "retained": true');
  });

  it("keeps the source unchanged when the shrink guard rejects a write", async () => {
    const store = await makeStore();
    const initial = await store.writeSource(
      source(Array.from({ length: 4 }, (_, i) => listing(String(i))), "initial"),
      { expectedRevision: null },
    );

    await expect(
      store.writeSource(source([listing("new")], "shrunk"), { expectedRevision: initial.revision }),
    ).rejects.toBeInstanceOf(ShrinkGuardError);
    await expect(store.readSource("fixture")).resolves.toMatchObject({
      revision: initial.revision,
      count: 4,
    });
  });
});
