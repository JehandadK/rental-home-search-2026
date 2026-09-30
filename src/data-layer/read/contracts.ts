/**
 * Read models for the web app (M5).
 *
 * The web app imports these types only. A client that fetches published
 * assets, an in-memory fake for tests, or a future API client (M7) can
 * implement `WebDataClient`; the app never learns where the data is stored.
 */
import type { EnrichedListing } from "../../domain/types";
import type { ReferenceDataSnapshot } from "../contracts";

export interface ReadOptions {
  signal?: AbortSignal;
}

export interface ReadResult<T> {
  data: T;
  /**
   * Set when the current source failed and the data came from an older
   * fallback copy. The app shows it, and offers a retry, rather than hiding it.
   */
  stale?: { reason: string };
}

/**
 * Every published browser listing, already deduplicated. Filtering, place
 * selection, and scoring are user state and happen in the browser.
 */
export interface ListingQueryResult {
  listings: readonly EnrichedListing[];
}

export interface WebDataClient {
  queryListings(options?: ReadOptions): Promise<ReadResult<ListingQueryResult>>;
  /** Cities, boundaries, and places; ids and counts come from the data. */
  loadReferenceSnapshot(options?: ReadOptions): Promise<ReadResult<ReferenceDataSnapshot>>;
}
