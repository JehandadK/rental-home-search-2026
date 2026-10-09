/**
 * Rank movement: how far each listing moved in the score ranking between
 * two scoring schemes. Changing a weight reorders the market, but without a
 * before/after the effect is invisible unless you remember the old order.
 */
import { listingKey } from "./listingKey";
import type { ScoredRow } from "./scoring";

/** Ranks keyed by listingKey, 1 = best. */
export type RankMap = ReadonlyMap<string, number>;

/**
 * Each listing's position when sorted by score, best first. Ties keep the
 * input order, exactly as the table's stable sort shows them, so a rank here
 * is the number the user sees in the table's # column.
 */
export function rankByScore(rows: readonly ScoredRow[]): RankMap {
  const order = rows
    .map((row, index) => ({ key: listingKey(row.listing), total: row.score.total ?? -1, index }))
    .sort((a, b) => b.total - a.total || a.index - b.index);
  const ranks = new Map<string, number>();
  order.forEach(({ key }, position) => {
    // Exact duplicates share a key; the first (best) position stands.
    if (!ranks.has(key)) ranks.set(key, position + 1);
  });
  return ranks;
}

/**
 * Places moved per listing: positive moved up, negative moved down. Listings
 * that did not move, or that are only in one of the two rankings (filtered
 * in or out meanwhile), are left out.
 */
export function rankMoves(before: RankMap, after: RankMap): Map<string, number> {
  const moves = new Map<string, number>();
  for (const [key, rank] of after) {
    const previous = before.get(key);
    if (previous != null && previous !== rank) moves.set(key, previous - rank);
  }
  return moves;
}
