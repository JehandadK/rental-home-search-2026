/**
 * The areas the map shows and the language place names read in, persisted
 * through the user-state store. Until areas are chosen, the map shows the
 * default search area: every city the listings are in, plus context
 * neighbours. A chosen set is honoured exactly, so cities with listings can be
 * hidden to keep the map fast on slower devices.
 */
import { useCallback, useMemo } from "react";
import { listingAreas, shownAreas, type NameLanguage } from "../../domain/mapAreas";
import type { ReferenceCity } from "../../domain/referenceData";
import type { EnrichedListing } from "../../domain/types";
import { decodeMapAreas, decodeNameLanguage } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

/** A stable key for a set of city ids, so equal sets keep one identity (and the map keeps its view). */
const keyOf = (ids: ReadonlySet<string>) => [...ids].sort().join("\n");
const fromKey = (key: string): ReadonlySet<string> => new Set(key ? key.split("\n") : []);

export function useMapAreas(
  cities: readonly ReferenceCity[],
  listings: readonly EnrichedListing[],
) {
  const [saved, setSaved] = usePersistentState<string[] | null>(USER_STATE_KEYS.mapAreas, decodeMapAreas);
  const [language, setLanguage] = usePersistentState<NameLanguage>(USER_STATE_KEYS.nameLanguage, decodeNameLanguage);

  const withListingsKey = useMemo(() => keyOf(listingAreas(cities, listings.map((listing) => listing.city))), [cities, listings]);
  const areasKey = useMemo(
    () => keyOf(shownAreas(cities, saved, fromKey(withListingsKey))),
    [cities, saved, withListingsKey],
  );
  const areas = useMemo(() => fromKey(areasKey), [areasKey]);

  const setAreas = useCallback((next: ReadonlySet<string>) => setSaved([...next]), [setSaved]);
  const resetAreas = useCallback(() => setSaved(null), [setSaved]);

  return { areas, setAreas, resetAreas, language, setLanguage };
}
