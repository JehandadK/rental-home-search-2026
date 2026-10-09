/** Page and request budgets owned by collectors; refresh and CLIs pass overrides down. */

/**
 * Emergency ceiling, not the normal incremental stopping condition.
 *
 * Newest-first collectors must normally continue until they cross the prior
 * observation boundary (two consecutive all-known pages). A tiny fixed budget
 * can strand fresh ads behind busy or imperfectly grouped result pages, so the
 * default is deliberately much larger than an ordinary refresh should need.
 * `--max-pages` remains available as an explicit diagnostic/operator cap.
 */
export const DEFAULT_INCREMENTAL_PAGE_CEILING = 100;

export function positiveInteger(value: string | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum) throw new Error(`Expected integer >= ${minimum}, got ${value}`);
  return n;
}
