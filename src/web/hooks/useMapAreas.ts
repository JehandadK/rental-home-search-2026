/**
 * The areas the map shows and the language place names read in, persisted
 * through the user-state store. Until areas are chosen, the map shows the
 * default search area.
 */
import { useCallback, useMemo } from "react";
import { defaultAreas, type NameLanguage } from "../../domain/mapAreas";
import type { ReferenceCity } from "../../domain/referenceData";
import { decodeMapAreas, decodeNameLanguage } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useMapAreas(cities: readonly ReferenceCity[]) {
  const [saved, setSaved] = usePersistentState<string[] | null>(USER_STATE_KEYS.mapAreas, decodeMapAreas);
  const [language, setLanguage] = usePersistentState<NameLanguage>(USER_STATE_KEYS.nameLanguage, decodeNameLanguage);

  const areas = useMemo((): ReadonlySet<string> => {
    if (saved == null) return defaultAreas(cities);
    const known = new Set(cities.map((city) => city.id));
    return new Set(saved.filter((id) => known.has(id)));
  }, [saved, cities]);

  const setAreas = useCallback((next: ReadonlySet<string>) => setSaved([...next]), [setSaved]);
  const resetAreas = useCallback(() => setSaved(null), [setSaved]);

  return { areas, setAreas, resetAreas, language, setLanguage };
}
