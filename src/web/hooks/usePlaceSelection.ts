/**
 * Place-selection state, persisted through the user-state store so a
 * curated set of stations/schools survives reloads.
 */
import { useCallback, useMemo } from "react";
import { defaultSelection, type PlaceSelection } from "../../domain/placeSelection";
import type { DistanceParameterKey, PlaceCatalog } from "../../domain/places";
import { decodePlaceSelection } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function usePlaceSelection(catalog: PlaceCatalog) {
  const defaults = useMemo(() => defaultSelection(catalog), [catalog]);
  // Decoded once, against the catalog the app loaded with.
  const [selection, setSelection] = usePersistentState<PlaceSelection>(
    USER_STATE_KEYS.placeSelection,
    (raw) => decodePlaceSelection(raw, defaults, catalog.byId),
  );

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

  const reset = useCallback(() => setSelection(defaults), [defaults]);

  return { selection, setPlaces, togglePlace, setTarget, reset };
}
