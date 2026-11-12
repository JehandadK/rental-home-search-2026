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

/** One verdict about two listings, each given by its ad keys. */
export interface DuplicateAnswer {
  a: string[];
  b: string[];
  verdict: DuplicateVerdict;
}

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

  /** Record several verdicts at once: a case of three listings, or every likely pair. */
  const decideMany = useCallback((answers: readonly DuplicateAnswer[]) => {
    if (answers.length === 0) return;
    const decidedAt = new Date().toISOString();
    setDecisions((current) => ({
      ...current,
      ...Object.fromEntries(answers.map(({ a, b, verdict }) => [decisionKey(a, b), { verdict, a, b, decidedAt }])),
    }));
  }, [setDecisions]);

  /** Forget decisions, putting their pairs back up for review. */
  const undoMany = useCallback((keys: readonly string[]) => {
    setDecisions((current) => {
      if (!keys.some((key) => key in current)) return current;
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  }, [setDecisions]);
  const undo = useCallback((key: string) => undoMany([key]), [undoMany]);

  return { decisions, decide, decideMany, undo, undoMany };
}
