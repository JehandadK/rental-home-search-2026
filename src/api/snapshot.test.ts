import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnrichedListing } from "../domain/types";
import { packListings } from "../domain/webPayload";
import { isDataUrl, LISTINGS_FILE, publishedSnapshotSource, REFERENCE_FILE, remoteFiles, type PublishedSnapshotSource } from "./snapshot";

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
let source: PublishedSnapshotSource | undefined;
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

describe("publishedSnapshotSource", () => {
  it("loads the published files into a ready snapshot", async () => {
    await write([listing("a", 90_000), listing("b", 80_000)]);
    source = publishedSnapshotSource({ from: dir, checkEveryMs: 0 });
    expect(source.status().state).toBe("loading");
    await source.ready;
    const snapshot = source.current()!;
    expect(snapshot.context.listings.map((l) => l.id)).toEqual(["a", "b"]);
    expect(snapshot.dataRevision).toMatch(/^rev-aaaaaaaa\.[0-9a-f]{12}$/);
    expect(source.status()).toMatchObject({ state: "ready", dataRevision: snapshot.dataRevision, error: null });
  });

  it("keeps the same snapshot when nothing changed, and swaps in a new one when a file does", async () => {
    await write([listing("a", 90_000)]);
    source = publishedSnapshotSource({ from: dir, checkEveryMs: 0 });
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
    source = publishedSnapshotSource({ from: dir, checkEveryMs: 0, log: (line) => lines.push(line) });
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
    source = publishedSnapshotSource({ from: join(dir, "missing"), checkEveryMs: 0 });
    await source.ready;
    expect(source.current()).toBeNull();
    expect(source.status()).toMatchObject({ state: "failed", error: expect.stringContaining("ENOENT") });
  });

  it("rejects a reference file that is not a snapshot", async () => {
    await write([listing("a", 90_000)]);
    await writeFile(join(dir, REFERENCE_FILE), JSON.stringify({ hello: 1 }));
    source = publishedSnapshotSource({ from: dir, checkEveryMs: 0 });
    await source.ready;
    expect(source.status().error).toContain("not a reference snapshot");
  });
});

describe("publishedSnapshotSource from a URL", () => {
  interface FakeFile { body: string; etag?: string }
  const files = new Map<string, FakeFile>();
  const gets: string[] = [];
  /** Status codes the next GETs answer with, before the server recovers. */
  const failNextGets: number[] = [];
  let headStatus = 200;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const file = files.get(url);
    if (!file) return new Response("missing", { status: 404 });
    const headers: Record<string, string> = { "content-length": String(Buffer.byteLength(file.body)) };
    if (file.etag) headers.etag = file.etag;
    if (init?.method === "HEAD") return new Response(null, { status: headStatus, headers });
    gets.push(url);
    const fail = failNextGets.shift();
    if (fail) return new Response("busy", { status: fail });
    return new Response(file.body, { status: 200, headers });
  }) as typeof fetch;

  const BASE = "https://static.example/rentals/data";
  const publish = (listings: EnrichedListing[], etag?: string, revision = "rev-bbbbbbbbbbbb") => {
    files.set(`${BASE}/${LISTINGS_FILE}`, { body: JSON.stringify(packListings(listings)), etag: etag && `"l-${etag}"` });
    files.set(`${BASE}/${REFERENCE_FILE}`, { body: JSON.stringify(reference(revision)), etag: etag && `"r-${etag}"` });
  };
  beforeEach(() => {
    files.clear();
    gets.length = 0;
    failNextGets.length = 0;
    headStatus = 200;
  });

  it("loads the published files from the URL, with or without a trailing slash", async () => {
    publish([listing("a", 90_000)], "1");
    source = publishedSnapshotSource({ from: BASE, checkEveryMs: 0, fetch: fakeFetch });
    await source.ready;
    expect(source.current()!.context.listings.map((l) => l.id)).toEqual(["a"]);
    expect(gets).toEqual([`${BASE}/${LISTINGS_FILE}`, `${BASE}/${REFERENCE_FILE}`]);
  });

  it("downloads again only when an ETag changes", async () => {
    publish([listing("a", 90_000)], "1");
    source = publishedSnapshotSource({ from: `${BASE}/`, checkEveryMs: 0, fetch: fakeFetch });
    await source.ready;
    await source.reload();
    expect(gets).toHaveLength(2);
    publish([listing("a", 95_000)], "2");
    await source.reload();
    expect(gets).toHaveLength(4);
    expect(source.current()!.context.listings[0].rent).toBe(95_000);
  });

  it("without validators, reads and compares, and keeps the snapshot when nothing changed", async () => {
    publish([listing("a", 90_000)]);
    source = publishedSnapshotSource({ from: BASE, checkEveryMs: 0, fetch: fakeFetch });
    await source.ready;
    const first = source.current();
    await source.reload();
    expect(source.current()).toBe(first);
    publish([listing("a", 99_000)]);
    await source.reload();
    expect(source.current()!.context.listings[0].rent).toBe(99_000);
  });

  it("keeps the last good snapshot when the server fails, and reports a missing file", async () => {
    publish([listing("a", 90_000)], "1");
    source = publishedSnapshotSource({ from: BASE, checkEveryMs: 0, fetch: fakeFetch });
    await source.ready;
    const good = source.current();
    files.delete(`${BASE}/${REFERENCE_FILE}`);
    await source.reload();
    expect(source.current()).toBe(good);
    expect(source.status().error).toContain("HTTP 404");
  });

  it("retries a failed download on the next check even though the ETags did not change", async () => {
    publish([listing("a", 90_000)], "1");
    failNextGets.push(503);
    source = publishedSnapshotSource({ from: BASE, checkEveryMs: 0, fetch: fakeFetch });
    await source.ready;
    expect(source.status()).toMatchObject({ state: "failed" });
    await source.reload();
    expect(source.status()).toMatchObject({ state: "ready", error: null });
    expect(source.current()!.context.listings.map((l) => l.id)).toEqual(["a"]);
  });

  it("falls back to reading and comparing when the server refuses HEAD", async () => {
    publish([listing("a", 90_000)], "1");
    headStatus = 405;
    source = publishedSnapshotSource({ from: BASE, checkEveryMs: 0, fetch: fakeFetch });
    await source.ready;
    expect(source.status().state).toBe("ready");
  });

  it("does not rebuild when a fingerprint changes but the content does not", async () => {
    publish([listing("a", 90_000)], "1");
    source = publishedSnapshotSource({ from: BASE, checkEveryMs: 0, fetch: fakeFetch });
    await source.ready;
    const first = source.current();
    publish([listing("a", 90_000)], "2");
    await source.reload();
    expect(source.current()).toBe(first);
    await source.reload();
    // The new fingerprint was remembered, so the unchanged files are not downloaded again.
    expect(gets).toHaveLength(4);
  });

  it("refuses data URLs with credentials, a query or a fragment", () => {
    for (const url of ["https://u:p@x.example/data/", "https://x.example/data/?sig=abc", "https://x.example/data/#a"]) {
      expect(() => remoteFiles(url), url).toThrow(/credentials, a query or a fragment/);
    }
  });

  it("refuses a body longer than it said it was", async () => {
    const liar = (async () => new Response("x".repeat(50), { status: 200, headers: { "content-length": "10" } })) as unknown as typeof fetch;
    await expect(remoteFiles(BASE, { fetch: liar }).read()).rejects.toThrow(/over its stated 10 bytes/);
  });

  it("accepts a compressed response whose decoded body is longer than its Content-Length", async () => {
    const { gzipSync } = await import("node:zlib");
    publish([listing("a", 90_000)], "1");
    const compressed = (async (input: string | URL | Request) => {
      const file = files.get(String(input))!;
      const body = gzipSync(file.body);
      return new Response(body, { status: 200, headers: { "content-encoding": "gzip", "content-length": String(body.length) } });
    }) as typeof fetch;
    // A Response built from gzip bytes is not decoded by itself; decode it the way fetch would.
    const decoding = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await compressed(input, init);
      const decoded = response.body!.pipeThrough(new DecompressionStream("gzip"));
      return new Response(decoded, { status: 200, headers: response.headers });
    }) as typeof fetch;
    const [listings] = await remoteFiles(BASE, { fetch: decoding }).read();
    expect(JSON.parse(listings.toString()).listings).toHaveLength(1);
  });

  it("starts no download and reports nothing once closed, even mid-check", async () => {
    publish([listing("a", 90_000)], "1");
    const lines: string[] = [];
    source = publishedSnapshotSource({ from: BASE, checkEveryMs: 0, fetch: fakeFetch, log: (line) => lines.push(line) });
    source.close();
    await source.ready;
    await source.reload();
    expect(gets).toEqual([]);
    expect(source.status()).toMatchObject({ state: "loading", error: null });
    expect(lines).toEqual([]);
  });

  it("refuses files over the size cap", async () => {
    publish([listing("a", 90_000)], "1");
    const files_ = remoteFiles(BASE, { fetch: fakeFetch, maxBytes: 100 });
    await expect(files_.read()).rejects.toThrow(/over 100 bytes/);
  });

  it("only takes http(s) URLs", () => {
    expect(isDataUrl("https://x/data/")).toBe(true);
    expect(isDataUrl("/srv/data")).toBe(false);
    expect(() => remoteFiles("ftp://x/data/")).toThrow(/use http/);
  });
});
