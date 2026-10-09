/**
 * Side-by-side comparison: a short, ordered list of listing keys the user
 * pinned to compare. Kept small on purpose — past four columns a comparison
 * stops being readable and becomes another table.
 */

export const MAX_COMPARE = 4;

/** The list with `key` added (at the end) or removed. A full list is left unchanged. */
export function toggleCompare(keys: readonly string[], key: string): string[] {
  if (keys.includes(key)) return keys.filter((k) => k !== key);
  if (keys.length >= MAX_COMPARE) return [...keys];
  return [...keys, key];
}

/**
 * Indexes of the best values in one comparison row. Nothing is highlighted
 * when fewer than two homes have a value, or when every value is the same:
 * there is no winner to point at.
 */
export function bestIndexes(values: readonly (number | null | undefined)[], better: "low" | "high"): Set<number> {
  const known = values.flatMap((value, index) => (value == null ? [] : [{ value, index }]));
  if (known.length < 2) return new Set();
  const best = better === "low"
    ? Math.min(...known.map(({ value }) => value))
    : Math.max(...known.map(({ value }) => value));
  if (known.every(({ value }) => value === best)) return new Set();
  return new Set(known.filter(({ value }) => value === best).map(({ index }) => index));
}
