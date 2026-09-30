/**
 * Listing collection state: the loaded base listings, plus custom listings
 * the user adds by hand (persisted through the user-state store).
 */
import { useCallback, useMemo } from "react";
import type { EnrichedListing } from "../../domain/types";
import { deduplicateListings } from "../../domain/listingDedup";
import { decodeCustomListings } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useListings(baseListings: readonly EnrichedListing[]) {
  const [custom, setCustom] = usePersistentState<EnrichedListing[]>(USER_STATE_KEYS.customListings, decodeCustomListings);

  const addListing = useCallback((listing: EnrichedListing) => {
    setCustom((list) => [...list, listing]);
  }, [setCustom]);

  const removeListing = useCallback((name: string) => {
    setCustom((list) => list.filter((l) => l.name !== name));
  }, [setCustom]);

  // Keep this array referentially stable. Rebuilding it on every App render
  // used to cascade into rebuilding the ~2m-entry proximity matrix, resolving
  // every place and rescoring every listing — even for a simple map hover.
  const listings = useMemo(
    // The generated base payload is already deduplicated at build time. Avoid
    // an O(n²) browser pass unless a custom listing actually needs merging.
    () => custom.length === 0
      ? baseListings
      : deduplicateListings([...baseListings, ...custom]) as EnrichedListing[],
    [baseListings, custom],
  );
  return { listings, custom, addListing, removeListing };
}
