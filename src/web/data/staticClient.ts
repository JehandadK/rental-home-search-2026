/**
 * In-memory `WebDataClient`: serves fixed data. The bundled compatibility
 * client uses it, and tests use it as a fake.
 */
import type { ReferenceDataSnapshot } from "../../data-layer/contracts";
import type { WebDataClient } from "../../data-layer/read/contracts";
import type { EnrichedListing } from "../../domain/types";

export function createStaticWebDataClient(data: {
  listings: readonly EnrichedListing[];
  reference: ReferenceDataSnapshot;
}): WebDataClient {
  return {
    queryListings: async () => ({ data: { listings: data.listings } }),
    loadReferenceSnapshot: async () => ({ data: data.reference }),
  };
}
