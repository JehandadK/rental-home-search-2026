import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnrichedListing } from "../domain/types";
import { packListings } from "../domain/webPayload";
import { fileSnapshotSource, LISTINGS_FILE, REFERENCE_FILE, type FileSnapshotSource } from "./snapshot";

const listing = (id: string, rent: number): EnrichedListing => ({
  id, name: id, address: "埼玉県草加市", city: "Soka", rent, layout: "2LDK", sizeM2: 50, builtYear: 2010,
  stationWalkMin: 5, url: null, source: "athome", geocoded: true, lat: 35.8282, lon: 139.8033,
});

const reference = (revision: string) => ({
  revision,
  cities: { records: [] },
  boundaries: { records: [] },
  places: { records: [{ id: "s1", name: "草加", category: "station", lat: 35.8277, lon: 139.8036 }] },
});

let dir: string;
let source: FileSnapshotSource | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "api-snapshot-"));
});
afterEach(async () => {
  source?.close();
  source = undefined;
  await rm(dir, { recursive: true, force: true });
});

const write = async (listings: EnrichedListing[], revision = "rev-aaaaaaaaaaaa") => {
  await writeFile(join(dir, LISTINGS_FILE), JSON.stringify(packListings(listings)));
  await writeFile(join(dir, REFERENCE_FILE), JSON.stringify(reference(revision)));
};
/** Make the next write look changed even within one timestamp tick. */
const touch = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("fileSnapshotSource", () => {
  it("loads the published files into a ready snapshot", async () => {
    await write([listing("a", 90_000), listing("b", 80_000)]);
    source = fileSnapshotSource({ dir, checkEveryMs: 0 });
    expect(source.status().state).toBe("loading");
    await source.ready;
    const snapshot = source.current()!;
    expect(snapshot.context.listings.map((l) => l.id)).toEqual(["a", "b"]);
    expect(snapshot.dataRevision).toMatch(/^rev-aaaaaaaa\.[0-9a-f]{12}$/);
    expect(source.status()).toMatchObject({ state: "ready", dataRevision: snapshot.dataRevision, error: null });
  });

  it("keeps the same snapshot when nothing changed, and swaps in a new one when a file does", async () => {
    await write([listing("a", 90_000)]);
    source = fileSnapshotSource({ dir, checkEveryMs: 0 });
    await source.ready;
    const first = source.current();
    await source.reload();
    expect(source.current()).toBe(first);
    await touch();
    await write([listing("a", 95_000)]);
    await source.reload();
    expect(source.current()).not.toBe(first);
    expect(source.current()!.dataRevision).not.toBe(first!.dataRevision);
    expect(source.current()!.context.listings[0].rent).toBe(95_000);
  });

  it("keeps serving the last good snapshot when a reload fails, and says why", async () => {
    const lines: string[] = [];
    await write([listing("a", 90_000)]);
    source = fileSnapshotSource({ dir, checkEveryMs: 0, log: (line) => lines.push(line) });
    await source.ready;
    const good = source.current();
    await touch();
    await writeFile(join(dir, LISTINGS_FILE), "{ truncated");
    await source.reload();
    expect(source.current()).toBe(good);
    expect(source.status()).toMatchObject({ state: "ready", error: expect.stringContaining("JSON") });
    expect(lines.at(-1)).toContain(`still serving ${good!.dataRevision}`);
  });

  it("reports a failed first load without a snapshot", async () => {
    source = fileSnapshotSource({ dir: join(dir, "missing"), checkEveryMs: 0 });
    await source.ready;
    expect(source.current()).toBeNull();
    expect(source.status()).toMatchObject({ state: "failed", error: expect.stringContaining("ENOENT") });
  });

  it("rejects a reference file that is not a snapshot", async () => {
    await write([listing("a", 90_000)]);
    await writeFile(join(dir, REFERENCE_FILE), JSON.stringify({ hello: 1 }));
    source = fileSnapshotSource({ dir, checkEveryMs: 0 });
    await source.ready;
    expect(source.status().error).toContain("not a reference snapshot");
  });
});
