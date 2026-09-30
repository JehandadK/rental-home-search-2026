/**
 * Place-selection state with localStorage persistence, so a curated set of
 * stations/schools survives reloads.
 */
import { useCallback, useEffect, useState } from "react";
import { defaultSelection, type PlaceSelection } from "../../domain/placeSelection";
import { PLACE_CATALOG } from "../../domain/reference";
import type { DistanceParameterKey } from "../../domain/places";

const STORAGE_KEY = "soka-scorer-places-v1";
const DEFAULT_SELECTION = defaultSelection(PLACE_CATALOG);

function loadSelection(): PlaceSelection {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as PlaceSelection;
      const merged = { ...DEFAULT_SELECTION.byParameter, ...parsed.byParameter };
      // v1 stored Baitul Aman as a single poi target. Mosque scoring now
      // defaults to nearest of all mosques; migrate that legacy default while
      // preserving genuinely curated multi-mosque choices.
      const oldBaitulOnly = merged.poi2?.length === 1 && merged.poi2[0].includes("Baitul Aman");
      if (oldBaitulOnly) merged.poi2 = null;
      return { byParameter: merged };
    }
  } catch {
    // Ignore corrupt storage.
  }
  return DEFAULT_SELECTION;
}

export function usePlaceSelection() {
  const [selection, setSelection] = useState<PlaceSelection>(loadSelection);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  }, [selection]);

  /** Replace the chosen ids for one parameter (null = any place). */
  const setPlaces = useCallback((key: DistanceParameterKey, ids: string[] | null) => {
    setSelection((s) => ({ byParameter: { ...s.byParameter, [key]: ids } }));
  }, []);

  /** Add or remove one place from a parameter's selection. */
  const togglePlace = useCallback((key: DistanceParameterKey, id: string) => {
    setSelection((s) => {
      const current = s.byParameter[key];
      const next = current == null
        ? [id]
        : current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id];
      return {
        byParameter: { ...s.byParameter, [key]: next.length === 0 ? null : next },
      };
    });
  }, []);

  /** Choose a single place as the target (poi1/poi2). */
  const setTarget = useCallback((key: DistanceParameterKey, id: string) => {
    setSelection((s) => ({ byParameter: { ...s.byParameter, [key]: [id] } }));
  }, []);

  const reset = useCallback(() => setSelection(DEFAULT_SELECTION), []);

  return { selection, setPlaces, togglePlace, setTarget, reset };
}
