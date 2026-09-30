/**
 * Which properties are worth a browser visit. Cheap by construction:
 *  - never sold rows, never properties already known rented out,
 *  - skip properties confirmed live recently (stale-days),
 *  - most likely gone first: the ones a refresh has not seen for longest.
 */
import { adKey, type AvailabilityMap, withAvailability, isRentedOut } from "../../domain/availability";
import { sourceListings } from "../../domain/listingDedup";
import type { RawListing } from "../../domain/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SelectOptions {
  limit: number;
  staleDays: number;
  now: Date;
  /** Re-verify properties already recorded as rented out. */
  recheckGone?: boolean;
  city?: string;
  minSizeM2?: number;
  maxRent?: number;
}

export function selectCandidates<T extends RawListing>(listings: readonly T[], known: AvailabilityMap, options: SelectOptions): T[] {
  const cutoff = options.now.getTime() - options.staleDays * DAY_MS;
  return listings
    .filter((listing) => {
      if (listing.status === "sold") return false;
      if (options.city && listing.city !== options.city) return false;
      if (options.minSizeM2 != null && (listing.sizeM2 == null || listing.sizeM2 < options.minSizeM2)) return false;
      if (options.maxRent != null && listing.rent > options.maxRent) return false;
      const ads = sourceListings(listing).filter((ad) => ad.url);
      if (!ads.length) return false;
      if (!options.recheckGone && isRentedOut(withAvailability(listing, known))) return false;
      const recentlyLive = ads.some((ad) => {
        const record = known[adKey(ad.source, ad.url, ad.id)];
        return record?.state === "listed" && Date.parse(record.checkedAt) >= cutoff;
      });
      return !recentlyLive;
    })
    .sort((a, b) => (a.lastSeenAt ?? "9999").localeCompare(b.lastSeenAt ?? "9999"))
    .slice(0, options.limit);
}
