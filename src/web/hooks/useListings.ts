/**
 * Listing collection state: the loaded base listings, plus custom listings
 * the user adds by hand (persisted to localStorage).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EnrichedListing } from "../../domain/types";
import { deduplicateListings } from "../../domain/listingDedup";

const STORAGE_KEY = "soka-scorer-custom-listings-v1";

function loadCustom(): EnrichedListing[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // Ignore corrupt storage.
  }
  return [];
}

export function useListings(baseListings: readonly EnrichedListing[]) {
  const [custom, setCustom] = useState<EnrichedListing[]>(loadCustom);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
  }, [custom]);

  const addListing = useCallback((listing: EnrichedListing) => {
    setCustom((list) => [...list, listing]);
  }, []);

  const removeListing = useCallback((name: string) => {
    setCustom((list) => list.filter((l) => l.name !== name));
  }, []);

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
