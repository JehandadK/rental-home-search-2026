/**
 * Filter state, persisted through the user-state store so a chosen area
 * focus and bounds survive reloads.
 */
import { useCallback } from "react";
import { EMPTY_FILTERS, type ListingFilters } from "../../domain/filters";
import { decodeFilters } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useFilters() {
  const [filters, setFilters] = usePersistentState<ListingFilters>(USER_STATE_KEYS.filters, decodeFilters);

  const update = useCallback((patch: Partial<ListingFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
  }, [setFilters]);

  const reset = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);

  return { filters, update, reset };
}
