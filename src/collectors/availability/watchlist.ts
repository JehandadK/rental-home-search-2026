/**
 * The homes a refresh re-checks: the best-scoring ones that have gone longest
 * without evidence that they are still on offer.
 *
 *  - Only the `top` homes by score are watched. Sold, rented-out and
 *    likely-rented homes are settled and left out, and so are UR rooms: the UR
 *    sweep asks UR about every held room on each refresh.
 *  - A home counts as confirmed on the later of its newest "still listed" check
 *    and the last time a refresh saw it in a portal's results. Homes confirmed
 *    within `staleDays` are left alone, so a home found today costs nothing.
 *  - The rest are ordered by how overdue they are. A home's turn comes round
 *    faster the higher it ranks: at rank `HALF_RANK` it waits twice as long as
 *    the top home, at three times that rank four times as long.
 */
import { adKey, type AvailabilityMap, isLikelyRented, isRentedOut, withAvailability } from "../../domain/availability";
import { sourceListings } from "../../domain/listingDedup";
import type { RawListing } from "../../domain/types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rank at which a home is re-checked half as often as the best one. */
export const HALF_RANK = 50;
/** A home with no sighting or check on record is treated as this long unconfirmed. */
const UNKNOWN_AGE_DAYS = 365;

export interface WatchOptions<T> {
  /** How many of the best-scoring homes to watch. */
  top: number;
  /** Homes confirmed on offer within this many days are not visited. */
  staleDays: number;
  now: Date;
  /** The home's score under the owner's weights; null when it cannot be scored. */
  scoreOf(listing: T): number | null;
}

export interface WatchCandidate<T> {
  listing: T;
  score: number;
  /** 1 = best-scoring watched home. */
  rank: number;
  /** When the home was last shown to be on offer; null when never. */
  confirmedAt: string | null;
  /** Days since `confirmedAt`. */
  ageDays: number;
}

const latest = (a: string | null, b: string | null | undefined): string | null =>
  !b || Number.isNaN(Date.parse(b)) ? a : !a || Date.parse(b) > Date.parse(a) ? b : a;

/** Watched homes that are due a visit, most overdue first. */
export function selectWatchlist<T extends RawListing>(listings: readonly T[], known: AvailabilityMap, options: WatchOptions<T>): WatchCandidate<T>[] {
  const watched = listings
    .flatMap((listing) => {
      if (listing.status === "sold") return [];
      const ads = sourceListings(listing).filter((ad) => ad.url);
      if (!ads.length || ads.some((ad) => ad.source === "ur")) return [];
      const current = withAvailability(listing, known);
      if (isRentedOut(current) || isLikelyRented(current)) return [];
      const score = options.scoreOf(listing);
      return score == null ? [] : [{ listing, score, ads }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, options.top);

  return watched
    .map(({ listing, score, ads }, index) => {
      const confirmedAt = ads.reduce<string | null>((newest, ad) => {
        const record = known[adKey(ad.source, ad.url, ad.id)];
        return record?.state === "listed" ? latest(newest, record.checkedAt) : newest;
      }, latest(null, listing.lastSeenAt));
      const ageDays = confirmedAt ? Math.max(0, (options.now.getTime() - Date.parse(confirmedAt)) / DAY_MS) : UNKNOWN_AGE_DAYS;
      return { listing, score, rank: index + 1, confirmedAt, ageDays };
    })
    .filter((candidate) => candidate.ageDays >= options.staleDays)
    .sort((a, b) => overdue(b) - overdue(a) || a.rank - b.rank);
}

/** How overdue a watched home is: its unconfirmed age, discounted by rank. */
export const overdue = (candidate: { ageDays: number; rank: number }): number => candidate.ageDays / (1 + (candidate.rank - 1) / HALF_RANK);
