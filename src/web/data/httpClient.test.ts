import { describe, expect, it } from "vitest";
import { packListings } from "../../domain/webPayload";
import { FIXTURE_LISTINGS, FIXTURE_REFERENCE } from "../testing/referenceFixture.contract";
import { createHttpWebDataClient, withStaleFallback } from "./httpClient";

interface Call {
  url: string;
  cache?: RequestCache;
  signal?: AbortSignal | null;
}

/** A fetch that serves fixed bodies per asset name; `cached` answers force-cache requests. */
function fakeFetch(
  live: Record<string, unknown> | "offline",
  cached: Record<string, unknown> = {},
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, cache: init?.cache, signal: init?.signal });
    const name = url.slice(url.lastIndexOf("/") + 1);
    const source = init?.cache === "force-cache" ? cached : live;
    if (source === "offline") throw new TypeError("Failed to fetch");
    if (!(name in source)) return new Response("missing", { status: 404 });
    const body = source[name];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const PUBLISHED = { "listings.json": packListings(FIXTURE_LISTINGS), "reference.json": FIXTURE_REFERENCE };

describe("createHttpWebDataClient", () => {
  it("fetches and unpacks the published assets, revalidating by default", async () => {
    const { fetch, calls } = fakeFetch(PUBLISHED);
    const client = createHttpWebDataClient({ baseUrl: "/app/data/", fetch });
    const listings = await client.queryListings();
    const reference = await client.loadReferenceSnapshot();
    expect(listings).toEqual({ data: { listings: FIXTURE_LISTINGS.map((listing) => ({ ...listing, attributes: [] })) } });
    expect(reference).toEqual({ data: FIXTURE_REFERENCE });
    expect(calls.map((call) => [call.url, call.cache])).toEqual([
      ["/app/data/listings.json", "no-cache"],
      ["/app/data/reference.json", "no-cache"],
    ]);
  });

  it("passes the abort signal through", async () => {
    const { fetch, calls } = fakeFetch(PUBLISHED);
    const controller = new AbortController();
    await createHttpWebDataClient({ baseUrl: "/", fetch }).queryListings({ signal: controller.signal });
    expect(calls[0].signal).toBe(controller.signal);
  });

  it("reports download progress against the decoded size, and still unpacks the data", async () => {
    const body = JSON.stringify(packListings(FIXTURE_LISTINGS));
    const bytes = new TextEncoder().encode(body);
    const half = Math.floor(bytes.length / 2);
    const streamed = (headers: Record<string, string>) => (async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes.slice(0, half)); controller.enqueue(bytes.slice(half)); controller.close(); },
      }),
      { status: 200, headers },
    )) as typeof fetch;
    const read = async (headers: Record<string, string>) => {
      const seen: Array<[number, number | undefined]> = [];
      const result = await createHttpWebDataClient({ baseUrl: "/", fetch: streamed(headers) })
        .queryListings({ onProgress: (progress) => seen.push([progress.loadedBytes, progress.totalBytes]) });
      expect(result.data.listings).toHaveLength(FIXTURE_LISTINGS.length);
      return seen;
    };

    // Uncompressed: Content-Length is the decoded size.
    expect(await read({ "content-length": String(bytes.length) })).toEqual([
      [0, bytes.length], [half, bytes.length], [bytes.length, bytes.length],
    ]);
    // Compressed: Content-Length counts compressed bytes, so the server's own decoded size is used...
    expect((await read({ "content-encoding": "gzip", "content-length": "99", "x-uncompressed-length": String(bytes.length) }))[2])
      .toEqual([bytes.length, bytes.length]);
    // ...and with neither, only the bytes received are known.
    expect((await read({ "content-encoding": "gzip", "content-length": "99" }))[2]).toEqual([bytes.length, undefined]);
  });

  it("rejects HTTP errors, invalid JSON, and unexpected shapes", async () => {
    const client = (live: Record<string, unknown>) => createHttpWebDataClient({ baseUrl: "/", fetch: fakeFetch(live).fetch });
    await expect(client({}).queryListings()).rejects.toThrow("HTTP 404 loading /listings.json");
    await expect(client({ "reference.json": "{not json" }).loadReferenceSnapshot()).rejects.toThrow(/not valid JSON/);
    await expect(client({ "reference.json": { revision: "r", cities: {} } }).loadReferenceSnapshot()).rejects.toThrow(/not a reference snapshot/);
    await expect(client({ "listings.json": { schemaVersion: 9 } }).queryListings()).rejects.toThrow(/Unsupported listing payload/);
    await expect(client({ "listings.json": 42 }).queryListings()).rejects.toThrow(/not a listing payload/);
  });
});

describe("withStaleFallback", () => {
  it("uses the primary result when it succeeds", async () => {
    const { fetch, calls } = fakeFetch(PUBLISHED, PUBLISHED);
    const result = await createRuntimeWebDataClientWith(fetch).loadReferenceSnapshot();
    expect(result.stale).toBeUndefined();
    expect(calls.map((call) => call.cache)).toEqual(["no-cache"]);
  });

  it("falls back to the cached copy and flags it stale when the network fails", async () => {
    const { fetch, calls } = fakeFetch("offline", PUBLISHED);
    const client = createRuntimeWebDataClientWith(fetch);
    const listings = await client.queryListings();
    expect(listings.data.listings).toHaveLength(FIXTURE_LISTINGS.length);
    expect(listings.stale).toEqual({ reason: "Failed to fetch" });
    expect(calls.map((call) => call.cache)).toEqual(["no-cache", "force-cache"]);
  });

  it("reports the primary error when there is no cached copy either", async () => {
    const { fetch } = fakeFetch("offline", {});
    await expect(createRuntimeWebDataClientWith(fetch).loadReferenceSnapshot()).rejects.toThrow("Failed to fetch");
  });

  it("does not fall back after an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    let fallbackCalls = 0;
    const failing = { queryListings: () => Promise.reject(new Error("aborted")), loadReferenceSnapshot: () => Promise.reject(new Error("aborted")) };
    const fallback = {
      queryListings: async () => { fallbackCalls++; return { data: { listings: [] } }; },
      loadReferenceSnapshot: async () => { fallbackCalls++; return { data: FIXTURE_REFERENCE }; },
    };
    await expect(withStaleFallback(failing, fallback).queryListings({ signal: controller.signal })).rejects.toThrow("aborted");
    expect(fallbackCalls).toBe(0);
  });
});

function createRuntimeWebDataClientWith(fetch: typeof globalThis.fetch) {
  return withStaleFallback(
    createHttpWebDataClient({ baseUrl: "/data/", fetch }),
    createHttpWebDataClient({ baseUrl: "/data/", fetch, cache: "force-cache" }),
  );
}
