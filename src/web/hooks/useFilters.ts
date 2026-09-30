/**
 * Filter state with localStorage persistence, so a chosen area focus and
 * bounds survive reloads.
 */
import { useCallback, useEffect, useState } from "react";
import { EMPTY_FILTERS, type ListingFilters } from "../../domain/filters";

const STORAGE_KEY = "soka-scorer-filters-v1";

function loadFilters(): ListingFilters {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { ...EMPTY_FILTERS, ...JSON.parse(saved) };
  } catch {
    // Ignore corrupt storage.
  }
  return EMPTY_FILTERS;
}

export function useFilters() {
  const [filters, setFilters] = useState<ListingFilters>(loadFilters);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  const update = useCallback((patch: Partial<ListingFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
  }, []);

  const reset = useCallback(() => setFilters(EMPTY_FILTERS), []);

  return { filters, update, reset };
}
