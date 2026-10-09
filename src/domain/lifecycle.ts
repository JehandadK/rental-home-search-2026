/**
 * Listing lifecycle helpers for the UI: which listings are freshly
 * discovered (highlight them) and which are sold (kept, but de-emphasised).
 *
 * The timestamps are assigned by `npm run data:build` (see
 * src/data-layer/lifecycle.ts); listings from before tracking began have a null
 * `firstSeenAt` and are therefore never "new".
 */
import type { EnrichedListing } from "./types";
import { isRentedOut } from "./availability";

/** How long a listing counts as "new" after it is first seen, by default. */
export const NEW_LISTING_WINDOW_DAYS = 14;

/** The range the user may set the "new" window to, in days. */
export const MIN_NEW_WINDOW_DAYS = 1;
export const MAX_NEW_WINDOW_DAYS = 14;

/** A whole number of days within MIN/MAX_NEW_WINDOW_DAYS; anything unusable → the default. */
export function clampNewWindowDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days)) return NEW_LISTING_WINDOW_DAYS;
  return Math.min(MAX_NEW_WINDOW_DAYS, Math.max(MIN_NEW_WINDOW_DAYS, Math.round(days)));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A listing that is no longer advertised (contracted / delisted), kept for reference. */
export function isSold(listing: Pick<EnrichedListing, "status">): boolean {
  return listing.status === "sold";
}

/**
 * True while a listing is within `windowDays` of being first seen. Sold
 * listings are never new — a re-listing keeps its original firstSeenAt, so
 * it ages out normally.
 */
export function isNewListing(
  listing: Pick<EnrichedListing, "status" | "firstSeenAt">,
  now: Date = new Date(),
  windowDays: number = NEW_LISTING_WINDOW_DAYS,
): boolean {
  if (isSold(listing) || !listing.firstSeenAt) return false;
  const ageMs = now.getTime() - Date.parse(listing.firstSeenAt);
  return ageMs >= 0 && ageMs < windowDays * DAY_MS;
}

/** Counts for header display: how many listings are new / sold right now. */
export function lifecycleCounts(
  listings: readonly EnrichedListing[],
  windowDays: number = NEW_LISTING_WINDOW_DAYS,
): {
  newCount: number;
  soldCount: number;
  /** Still-advertised-by-absence rows that every portal has shown as gone. */
  rentedOutCount: number;
} {
  let newCount = 0;
  let soldCount = 0;
  let rentedOutCount = 0;
  for (const listing of listings) {
    if (isSold(listing)) soldCount++;
    else if (isRentedOut(listing)) rentedOutCount++;
    else if (isNewListing(listing, new Date(), windowDays)) newCount++;
  }
  return { newCount, soldCount, rentedOutCount };
}
