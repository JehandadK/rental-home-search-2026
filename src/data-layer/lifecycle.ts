/**
 * Listing lifecycle tracking across data refreshes.
 *
 * Pure reconciliation logic used by `npm run data:build`: given the previous
 * built dataset and the freshly merged one, it
 *   - carries `firstSeenAt` forward for listings that are still advertised,
 *   - stamps `firstSeenAt` on listings never seen before (the UI highlights
 *     these as NEW),
 *   - keeps listings that vanished from every source, marked `status: "sold"`
 *     instead of dropping them.
 *
 * Identity for tracking is deliberately coarser than the cross-source dedupe
 * key: name + address + floor area. Rent moves with the market and must not
 * make a listing look "new" (or its old price look "sold"). A merged row can
 * also change its name when its preferred portal ad changes, so a row whose
 * key is unknown still continues a previous row it shares a portal ad with.
 */
import { listingAdKey } from "../domain/availability";
import { sourceListings } from "../domain/listingDedup";
import type { RawListing } from "../domain/types";

import { trackingKey } from "../domain/listingIdentity";
export { trackingKey } from "../domain/listingIdentity";

export interface LifecycleStats {
  /** In both the previous and the fresh dataset (price may have moved). */
  continued: number;
  /** Never seen before this build. */
  added: number;
  /** Absent from the fresh dataset; kept and marked sold. */
  sold: number;
  /** Were marked sold but are advertised again. */
  reactivated: number;
}

export interface ReconciledListings {
  /** Fresh listings first (source order), then sold carry-forwards. */
  listings: RawListing[];
  stats: LifecycleStats;
}

/**
 * The previous build's row a current row continues: same tracking key, else
 * the previous row (earliest discovered) it shares a portal ad with.
 */
export function previousMatcher(previous: readonly RawListing[]): (listing: RawListing) => RawListing | undefined {
  const previousByKey = new Map<string, RawListing>();
  for (const listing of previous) previousByKey.set(trackingKey(listing), listing);
  // Only real ads: a row with neither URL nor id has no ad identity to share.
  const adsOf = (listing: RawListing) => sourceListings(listing).filter((ad) => ad.url || ad.id).map((ad) => listingAdKey(ad.source, ad.url, ad.id));
  const previousByAd = new Map<string, RawListing[]>();
  for (const listing of previous) {
    for (const ad of adsOf(listing)) previousByAd.set(ad, [...(previousByAd.get(ad) ?? []), listing]);
  }
  return (listing) => previousByKey.get(trackingKey(listing))
    ?? [...new Set(adsOf(listing).flatMap((ad) => previousByAd.get(ad) ?? []))]
      .sort((a, b) => (a.firstSeenAt ?? "9999").localeCompare(b.firstSeenAt ?? "9999"))[0];
}

/**
 * Merge lifecycle state from `previous` (last build) into `current` (fresh
 * merge of all sources). Listings in `current` come out active with correct
 * seen-timestamps; previous listings missing from `current` are appended as
 * sold. A listing that returns after being sold keeps its original
 * `firstSeenAt` — a re-listing is not a discovery.
 */
export function reconcileLifecycle(
  previous: readonly RawListing[],
  current: readonly RawListing[],
  nowIso: string,
): ReconciledListings {
  const priorOf = previousMatcher(previous);
  const continued = new Set<RawListing>();

  const currentKeys = new Set<string>();
  const stats: LifecycleStats = { continued: 0, added: 0, sold: 0, reactivated: 0 };
  const listings: RawListing[] = [];

  for (const listing of current) {
    const key = trackingKey(listing);
    currentKeys.add(key);
    const prior = priorOf(listing);
    if (prior) {
      continued.add(prior);
      if (prior.status === "sold") stats.reactivated++;
      else stats.continued++;
      listings.push({
        ...listing,
        status: "active",
        firstSeenAt: prior.firstSeenAt ?? null,
        lastSeenAt: nowIso,
        soldAt: null,
      });
    } else {
      stats.added++;
      listings.push({
        ...listing,
        status: "active",
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        soldAt: null,
      });
    }
  }

  for (const listing of previous) {
    if (currentKeys.has(trackingKey(listing)) || continued.has(listing)) continue;
    stats.sold++;
    // Already-sold listings keep their original soldAt; don't re-stamp.
    listings.push(listing.status === "sold" ? listing : { ...listing, status: "sold", soldAt: nowIso });
  }

  return { listings, stats };
}
