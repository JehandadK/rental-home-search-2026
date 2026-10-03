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

  return { compare, toggleCompare: toggle, clearCompare: clear };
}
