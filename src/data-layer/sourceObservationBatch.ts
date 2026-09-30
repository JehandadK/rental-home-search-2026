import type { ListingObservationBatch } from "./contracts";
import type { RawListing } from "../domain/types";
import { trackingKey } from "../domain/listingIdentity";

/** Build an incremental batch, retiring only IDs explained by source aliases. */
export function sourceObservationBatch(input: {
  source: string;
  previous: readonly RawListing[];
  current: readonly RawListing[];
  expectedRevision: string | null;
  observedAt: string;
  observedAtByKey: Readonly<Record<string, string>>;
  provenance: Readonly<Record<string, unknown>>;
  matchKeys(listing: RawListing): readonly string[];
}): ListingObservationBatch {
  const currentIds = new Set(input.current.map((listing) => listing.id).filter((id): id is string => Boolean(id)));
  const currentAliases = new Set(input.current.flatMap((listing) => input.matchKeys(listing)));
  const retirements = input.previous
    .filter((listing) =>
      listing.id && !currentIds.has(listing.id) && input.matchKeys(listing).some((key) => currentAliases.has(key)),
    )
    .map((listing) => ({
      id: listing.id!,
      effectiveAt: input.observedAt,
      reason: `Superseded by a newer ${input.source} observation with matching source aliases`,
    }));

  return {
    source: input.source,
    expectedRevision: input.expectedRevision,
    observedAt: input.observedAt,
    completeness: "incremental",
    observations: input.current.map((listing) => {
      if (listing.source !== input.source) {
        throw new Error(`Listing source ${listing.source} does not match batch ${input.source}`);
      }
      const keys = input.matchKeys(listing);
      const sourceListingId = listing.id ?? listing.url ?? keys[0];
      if (!sourceListingId) throw new Error(`Source ${input.source} listing has no stable identity: ${listing.name}`);
      return {
        source: input.source,
        sourceListingId,
        observedAt: input.observedAtByKey[sourceTrackingKey(listing)] ?? input.observedAt,
        listing,
      };
    }),
    retirements,
    provenance: input.provenance,
  };
}

export function sourceTrackingKey(listing: RawListing): string {
  return trackingKey(listing);
}
