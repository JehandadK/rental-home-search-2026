/**
 * Review mode's queue: one home at a time, a decision or a skip, then the
 * next. The queue is a fixed list of keys taken when review starts, so a
 * decision that drops a home from the parent's filtered rows does not shift
 * every later home by one.
 *
 * Every decision is kept as a step that remembers the mark it replaced, so
 * "undo" can put that mark back (including "no mark") and return to the home.
 * Pure: the caller applies the marks; this module only tracks the session.
 */
import { isRuledOut, type ListingMark } from "./marks";
import type { ScorePart } from "./scoring";

/** What happened to a home in this session. A home not yet reached has none. */
export type ReviewOutcome = "shortlisted" | "ruledOut" | "skipped";

/** One decision, with what it replaced so it can be undone. */
export interface ReviewStep {
  key: string;
  /** Where the home sat in the queue, to return to it on undo. */
  index: number;
  previousMark: ListingMark | null;
  previousOutcome: ReviewOutcome | undefined;
}

export interface ReviewSession {
  keys: readonly string[];
  /** The home on screen; keys.length once the queue is done. */
  index: number;
  outcomes: Readonly<Record<string, ReviewOutcome>>;
  /** Decisions, oldest first. */
  history: readonly ReviewStep[];
}

export interface ReviewTally {
  reviewed: number;
  shortlisted: number;
  ruledOut: number;
  skipped: number;
}

/** A session over these keys, each once, in the order given. */
export function startReview(keys: Iterable<string>, outcomes: ReviewSession["outcomes"] = {}): ReviewSession {
  return { keys: [...new Set(keys)], index: 0, outcomes, history: [] };
}

export function isReviewDone(session: ReviewSession): boolean {
  return session.index >= session.keys.length;
}

export function currentKey(session: ReviewSession): string | null {
  return session.keys[session.index] ?? null;
}

/** Move on without deciding. A home decided earlier keeps its decision. */
export function skipHome(session: ReviewSession): ReviewSession {
  const key = currentKey(session);
  if (key == null) return session;
  const outcomes = session.outcomes[key] ? session.outcomes : { ...session.outcomes, [key]: "skipped" as const };
  return { ...session, outcomes, index: session.index + 1 };
}

export function previousHome(session: ReviewSession): ReviewSession {
  return session.index > 0 ? { ...session, index: Math.min(session.index, session.keys.length) - 1 } : session;
}

/**
 * Apply `chosen` to the home on screen, which has `current` today. Choosing
 * the mark it already has clears it and stays on the home, so a slip of the
 * key can be taken back in place; any other mark moves on to the next home.
 * Returns the mark to store, or undefined when there is no home on screen.
 */
export function decideHome(
  session: ReviewSession,
  current: ListingMark | null,
  chosen: ListingMark,
): { session: ReviewSession; mark: ListingMark | null } | undefined {
  const key = currentKey(session);
  if (key == null) return undefined;
  const step: ReviewStep = { key, index: session.index, previousMark: current, previousOutcome: session.outcomes[key] };
  const history = [...session.history, step];
  if (current === chosen) {
    const { [key]: _cleared, ...outcomes } = session.outcomes;
    return { session: { ...session, outcomes, history }, mark: null };
  }
  const outcome: ReviewOutcome = isRuledOut(chosen) ? "ruledOut" : "shortlisted";
  return {
    session: { ...session, outcomes: { ...session.outcomes, [key]: outcome }, history, index: session.index + 1 },
    mark: chosen,
  };
}

/** Take back the last decision: the mark to restore, and the session back on that home. */
export function undoDecision(session: ReviewSession): { session: ReviewSession; step: ReviewStep } | undefined {
  const step = session.history.at(-1);
  if (!step) return undefined;
  const { [step.key]: _undone, ...rest } = session.outcomes;
  const outcomes = step.previousOutcome ? { ...rest, [step.key]: step.previousOutcome } : rest;
  return { session: { ...session, outcomes, history: session.history.slice(0, -1), index: step.index }, step };
}

export function reviewTally(session: ReviewSession): ReviewTally {
  const tally: ReviewTally = { reviewed: 0, shortlisted: 0, ruledOut: 0, skipped: 0 };
  for (const outcome of Object.values(session.outcomes)) {
    tally.reviewed++;
    tally[outcome]++;
  }
  return tally;
}

/** A new pass over the homes skipped so far; the other decisions still count in the tally. */
export function reviewSkipped(session: ReviewSession): ReviewSession {
  const skipped = session.keys.filter((key) => session.outcomes[key] === "skipped");
  const outcomes = Object.fromEntries(Object.entries(session.outcomes).filter(([, outcome]) => outcome !== "skipped"));
  return startReview(skipped, outcomes);
}

/** Criteria that count toward the score: weighted and with data. */
type CountedPart = ScorePart & { score: number };

/** The criteria behind the score, the largest weighted contribution first. */
export function rankedParts(parts: readonly ScorePart[]): CountedPart[] {
  return parts
    .filter((part): part is CountedPart => part.weight > 0 && part.score != null)
    .sort((a, b) => b.score * b.weight - a.score * a.weight);
}

/**
 * The two criteria that lift the score most and the two that cost it most.
 * "Cost" is the points a criterion falls short by, times its weight, so a
 * heavily weighted 60 outranks a lightly weighted 20. No criterion is both.
 */
export function rankReasons(parts: readonly ScorePart[]): { strongest: CountedPart[]; weakest: CountedPart[] } {
  const ranked = rankedParts(parts);
  const strongest = ranked.slice(0, 2);
  const weakest = ranked
    .filter((part) => !strongest.includes(part) && part.score < 100)
    .sort((a, b) => (100 - b.score) * b.weight - (100 - a.score) * a.weight)
    .slice(0, 2);
  return { strongest, weakest };
}
