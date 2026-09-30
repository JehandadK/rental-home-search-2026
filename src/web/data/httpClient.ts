/**
 * Runtime web data client: fetches the assets `npm run data:web` publishes
 * (public/data/, served by Vite and copied into dist/).
 *
 * Every request revalidates with the server. If that fails, the browser's
 * HTTP cache is asked for its last copy instead; data served that way is
 * flagged stale so the app can say so and offer a retry. Nothing is bundled.
 */
import type { ReferenceDataSnapshot } from "../../data-layer/contracts";
import type { ReadOptions, ReadResult, WebDataClient } from "../../data-layer/read/contracts";
import type { EnrichedListing } from "../../domain/types";
import { unpackListings, type WebPayload } from "../../domain/webPayload";

export interface HttpClientOptions {
  /** Directory URL of the published assets, ending in "/". */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** "no-cache" revalidates; "force-cache" accepts any cached copy. */
  cache?: RequestCache;
}

export const LISTINGS_ASSET = "listings.json";
export const REFERENCE_ASSET = "reference.json";

export function createHttpWebDataClient({ baseUrl, fetch = globalThis.fetch, cache = "no-cache" }: HttpClientOptions): WebDataClient {
  const getJson = async (asset: string, options?: ReadOptions): Promise<unknown> => {
    const url = `${baseUrl}${asset}`;
    const response = await fetch(url, { cache, signal: options?.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${url} is not valid JSON`);
    }
  };
  return {
    queryListings: async (options) => {
      const payload = await getJson(LISTINGS_ASSET, options);
      if (!payload || typeof payload !== "object") throw new Error(`${LISTINGS_ASSET} is not a listing payload`);
      const listings: readonly EnrichedListing[] = unpackListings(payload as WebPayload | EnrichedListing[]);
      return { data: { listings } };
    },
    loadReferenceSnapshot: async (options) => {
      const snapshot = await getJson(REFERENCE_ASSET, options);
      assertReferenceSnapshot(snapshot);
      return { data: snapshot };
    },
  };
}

function assertReferenceSnapshot(value: unknown): asserts value is ReferenceDataSnapshot {
  const snapshot = value as Partial<Record<string, { records?: unknown }>> & { revision?: unknown };
  const valid = !!value && typeof value === "object" && typeof snapshot.revision === "string" &&
    ["cities", "boundaries", "places"].every((id) => Array.isArray(snapshot[id]?.records));
  if (!valid) throw new Error(`${REFERENCE_ASSET} is not a reference snapshot`);
}

/**
 * Serve each read from `primary`, or from `fallback` when primary fails,
 * flagging fallback data as stale. An aborted read is never retried, and if
 * both fail the primary error is reported.
 */
export function withStaleFallback(primary: WebDataClient, fallback: WebDataClient): WebDataClient {
  const read = <T>(first: () => Promise<ReadResult<T>>, second: () => Promise<ReadResult<T>>, signal?: AbortSignal) =>
    first().catch(async (error: unknown) => {
      if (signal?.aborted) throw error;
      const result = await second().catch(() => { throw error; });
      return { ...result, stale: { reason: error instanceof Error ? error.message : String(error) } };
    });
  return {
    queryListings: (options) =>
      read(() => primary.queryListings(options), () => fallback.queryListings(options), options?.signal),
    loadReferenceSnapshot: (options) =>
      read(() => primary.loadReferenceSnapshot(options), () => fallback.loadReferenceSnapshot(options), options?.signal),
  };
}

/** The production client: revalidate, falling back to the browser's cached copy. */
export function createRuntimeWebDataClient(baseUrl: string): WebDataClient {
  return withStaleFallback(
    createHttpWebDataClient({ baseUrl }),
    createHttpWebDataClient({ baseUrl, cache: "force-cache" }),
  );
}
