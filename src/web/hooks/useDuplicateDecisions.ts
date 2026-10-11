/**
 * The user's answers about possible duplicate pairs ("same home" or
 * "different homes"), persisted through the user-state store. Keyed by each
 * side's portal ad keys, so an answer survives rebuilds that change listing ids.
 */
import { useCallback } from "react";
import { decisionKey, type DuplicateDecision, type DuplicateVerdict } from "../../domain/possibleDuplicates";
import { decodeDuplicateDecisions } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useDuplicateDecisions() {
  const [decisions, setDecisions] = usePersistentState<Record<string, DuplicateDecision>>(
    USER_STATE_KEYS.duplicateDecisions,
    decodeDuplicateDecisions,
  );

  /** Record a verdict about two listings, given each side's ad keys. */
  const decide = useCallback((a: string[], b: string[], verdict: DuplicateVerdict) => {
    setDecisions((current) => ({
      ...current,
      [decisionKey(a, b)]: { verdict, a, b, decidedAt: new Date().toISOString() },
    }));
  }, [setDecisions]);

  /** Forget a decision, putting the pair back up for review. */
  const undo = useCallback((key: string) => {
    setDecisions((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, [setDecisions]);

  return { decisions, decide, undo };
}
