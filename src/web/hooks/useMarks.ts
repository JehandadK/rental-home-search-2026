/**
 * The user's decision marks, persisted through the user-state store so they
 * survive reloads and listing-data refreshes. Keyed by listingKey, which
 * prefers the stable source id assigned at scrape time.
 */
import { useCallback } from "react";
import type { ListingMark, MarkMap } from "../../domain/marks";
import { decodeMarks } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useMarks() {
  const [marks, setMarks] = usePersistentState<MarkMap>(USER_STATE_KEYS.marks, decodeMarks);

  /** Set the decision mark for one listing key; null clears it. */
  const setMark = useCallback((key: string, mark: ListingMark | null) => {
    setMarks((current) => {
      const next = { ...current };
      if (mark == null) delete next[key];
      else next[key] = mark;
      return next;
    });
  }, [setMarks]);

  const clearMarks = useCallback(() => setMarks({}), [setMarks]);

  return { marks, setMark, clearMarks };
}
