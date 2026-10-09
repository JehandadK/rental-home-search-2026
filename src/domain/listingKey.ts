/**
 * A stable identity for a listing, used to cross-link hover highlighting
 * between the map and the table. Listing names are not unique (the same
 * building appears with different layouts), so the key folds in address
 * and rent as a tiebreak.
 */
import type { EnrichedListing } from "./types";

export function listingKey(listing: EnrichedListing): string {
  return listing.id ?? `${listing.name}|${listing.address}|${listing.rent}`;
}
