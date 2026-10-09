/**
 * Briefly show how far each listing moved after a scoring change.
 *
 * When one of `causes` changes (the scoring config, the place selection),
 * the ranking from just before the change becomes the baseline, and every
 * listing's move against it is reported for `holdMs`. Further changes inside
 * that window keep the original baseline and restart the clock, so typing
 * "12" into a weight box shows the move from the old weight, not from "1".
 * Other changes — a filter, a new mark — re-rank silently, and end a window
 * that is showing, since its moves would no longer be the scoring's doing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { rankByScore, rankMoves, type RankMap } from "../../domain/rankMovement";
import type { ScoredRow } from "../../domain/scoring";

export const RANK_MOVE_HOLD_MS = 4000;

const NO_MOVES: ReadonlyMap<string, number> = new Map();

export function useRankMovement(
  rows: readonly ScoredRow[],
  causes: readonly unknown[],
  holdMs = RANK_MOVE_HOLD_MS,
): ReadonlyMap<string, number> {
  const ranks = useMemo(() => rankByScore(rows), [rows]);
  const last = useRef<{ ranks: RankMap; causes: readonly unknown[] }>({ ranks, causes });
  const [baseline, setBaseline] = useState<RankMap | null>(null);

  // No dependency list: comparing a few references after every render is
  // cheaper than making callers memoise their causes into one stable value.
  useEffect(() => {
    const previous = last.current;
    last.current = { ranks, causes };
    const caused = causes.length !== previous.causes.length
      || causes.some((cause, i) => cause !== previous.causes[i]);
    if (caused) setBaseline((current) => current ?? previous.ranks);
    else if (ranks !== previous.ranks) setBaseline(null);
  });

  useEffect(() => {
    if (!baseline) return;
    const timer = setTimeout(() => setBaseline(null), holdMs);
    return () => clearTimeout(timer);
  }, [baseline, ranks, holdMs]);

  return useMemo(() => (baseline ? rankMoves(baseline, ranks) : NO_MOVES), [baseline, ranks]);
}
