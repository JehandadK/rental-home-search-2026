/**
 * The user's decision marks, persisted to localStorage so they survive
 * reloads and listing-data refreshes. Keyed by listingKey, which prefers
 * the stable source id assigned at scrape time.
 */
import { useCallback, useEffect, useState } from "react";
import type { ListingMark, MarkMap } from "../../domain/marks";

const STORAGE_KEY = "soka-scorer-marks-v1";

function loadMarks(): MarkMap {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // Ignore corrupt storage.
  }
  return {};
}

export function useMarks() {
  const [marks, setMarks] = useState<MarkMap>(loadMarks);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  }, [marks]);

  /** Set the decision mark for one listing key; null clears it. */
  const setMark = useCallback((key: string, mark: ListingMark | null) => {
    setMarks((current) => {
      const next = { ...current };
      if (mark == null) delete next[key];
      else next[key] = mark;
      return next;
    });
  }, []);

  const clearMarks = useCallback(() => setMarks({}), []);

  return { marks, setMark, clearMarks };
}
