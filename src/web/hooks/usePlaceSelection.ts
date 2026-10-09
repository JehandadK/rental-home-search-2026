/**
 * Place-selection state, persisted through the user-state store so a
 * curated set of stations/schools survives reloads.
 */
import { useCallback, useMemo } from "react";
import { defaultSelection, type PlaceSelection } from "../../domain/placeSelection";
import type { DistanceParameterKey, PlaceCatalog } from "../../domain/places";
import { decodeLegacyPlaceSelection, decodePlaceSelection } from "../userState/decoders";
import { LEGACY_USER_STATE_KEYS, USER_STATE_KEYS } from "../userState/store";
import { usePersistentState, useUserStateStore } from "../userState/UserStateContext";

export function usePlaceSelection(catalog: PlaceCatalog) {
  const store = useUserStateStore();
  const defaults = useMemo(() => defaultSelection(), []);
  // Decoded once, against the catalog the app loaded with. With nothing saved
  // under the current key, migrate a v1 selection (private school as target).
  const [selection, setSelection] = usePersistentState<PlaceSelection>(
    USER_STATE_KEYS.placeSelection,
    (raw) => raw === undefined
      ? decodeLegacyPlaceSelection(
          store.read(LEGACY_USER_STATE_KEYS.placeSelection), defaults, catalog.byId, catalog.withRole("poi1")?.id)
      : decodePlaceSelection(raw, defaults, catalog.byId),
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

  const reset = useCallback(() => setSelection(defaults), [defaults]);

  return { selection, setPlaces, togglePlace, reset };
}
