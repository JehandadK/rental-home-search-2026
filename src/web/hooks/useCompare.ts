/**
 * The listings pinned for side-by-side comparison, in the order they were
 * added, persisted through the user-state store.
 */
import { useCallback } from "react";
import { toggleCompare } from "../../domain/compare";
import { decodeCompare } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useCompare() {
  const [compare, setCompare] = usePersistentState<string[]>(USER_STATE_KEYS.compare, decodeCompare);

  const toggle = useCallback((key: string) => setCompare((current) => toggleCompare(current, key)), [setCompare]);
  const clear = useCallback(() => setCompare([]), [setCompare]);
  /** Drop keys whose listing has left the data, so they stop holding a slot. */
  const retain = useCallback((known: { has(key: string): boolean }) => {
    setCompare((current) => {
      const kept = current.filter((key) => known.has(key));
      return kept.length === current.length ? current : kept;
    });
  }, [setCompare]);

  return { compare, toggleCompare: toggle, clearCompare: clear, retainCompare: retain };
}
