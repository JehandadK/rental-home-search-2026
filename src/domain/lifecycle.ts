/**
 * Listing lifecycle helpers for the UI: which listings are freshly
 * discovered (highlight them) and which are sold (kept, but de-emphasised).
 *
 * The timestamps are assigned by `npm run data:build` (see
 * src/data-layer/lifecycle.ts); listings from before tracking began have a null
 * `firstSeenAt` and are therefore never "new".
 */
import type { EnrichedListing } from "./types";

/** How long a listing counts as "new" after it is first seen. */
export const NEW_LISTING_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A listing that is no longer advertised (contracted / delisted), kept for reference. */
export function isSold(listing: Pick<EnrichedListing, "status">): boolean {
  return listing.status === "sold";
}

/**
 * True while a listing is within NEW_LISTING_WINDOW_DAYS of being first
 * seen. Sold listings are never new — a re-listing keeps its original
 * firstSeenAt, so it ages out normally.
 */
export function isNewListing(
  listing: Pick<EnrichedListing, "status" | "firstSeenAt">,
  now: Date = new Date(),
): boolean {
  if (isSold(listing) || !listing.firstSeenAt) return false;
  const ageMs = now.getTime() - Date.parse(listing.firstSeenAt);
  return ageMs >= 0 && ageMs < NEW_LISTING_WINDOW_DAYS * DAY_MS;
}

/** Counts for header display: how many listings are new / sold right now. */
export function lifecycleCounts(listings: readonly EnrichedListing[]): {
  newCount: number;
  soldCount: number;
} {
  let newCount = 0;
  let soldCount = 0;
  for (const listing of listings) {
    if (isSold(listing)) soldCount++;
    else if (isNewListing(listing)) newCount++;
  }
  return { newCount, soldCount };
}
