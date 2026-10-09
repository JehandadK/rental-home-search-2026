/**
 * Filter relaxation: when the filters leave nothing, say which one to loosen.
 * "0 match" alone sends the user hunting through every control; "relaxing
 * max rent would give 14" points at the one that matters.
 */
import { EMPTY_FILTERS, type ListingFilters } from "./filters";

/** One filter that could be cleared, and what clearing it would leave. */
export interface RelaxationHint {
  id: string;
  /** Lower-case, for "relaxing <label> would give N". */
  label: string;
  /** The filter patch that clears it. */
  patch: Partial<ListingFilters>;
  /** Listings that would match with only this filter cleared. */
  count: number;
}

interface Relaxation {
  id: string;
  label: string;
  fields: readonly (keyof ListingFilters)[];
}

/** Each control in the filter panel, as the fields it sets. */
const RELAXATIONS: readonly Relaxation[] = [
  { id: "cities", label: "city", fields: ["cities"] },
  // The include/exclude mode does nothing without areas, so it is not a filter of its own.
  { id: "areas", label: "area", fields: ["areas"] },
  { id: "rent", label: "rent range", fields: ["rentMin", "rentMax"] },
  { id: "size", label: "size range", fields: ["sizeMin", "sizeMax"] },
  { id: "layouts", label: "layout", fields: ["layouts"] },
  { id: "minScore", label: "minimum score", fields: ["minScore"] },
  { id: "parking", label: "parking requirement", fields: ["parking"] },
  { id: "parkingMaxYen", label: "parking price cap", fields: ["parkingMaxYen"] },
  { id: "status", label: "listing status", fields: ["status"] },
  { id: "newOnly", label: "new only", fields: ["newOnly"] },
  { id: "rentedOut", label: "rented-out filter", fields: ["rentedOut"] },
  { id: "markFilter", label: "decision filter", fields: ["markFilter"] },
];

/**
 * For every active filter, how many listings clearing it alone would bring
 * back, best first. Filters whose clearing still gives nothing are left out.
 * `countMatching` runs the app's full filter pipeline for a filter set.
 */
export function relaxationHints(
  filters: ListingFilters,
  countMatching: (filters: ListingFilters) => number,
): RelaxationHint[] {
  const hints: RelaxationHint[] = [];
  for (const { id, label, fields } of RELAXATIONS) {
    if (fields.every((field) => sameValue(filters[field], EMPTY_FILTERS[field]))) continue;
    const patch = Object.fromEntries(fields.map((field) => [field, EMPTY_FILTERS[field]])) as Partial<ListingFilters>;
    const count = countMatching({ ...filters, ...patch });
    if (count > 0) hints.push({ id, label, patch, count });
  }
  return hints.sort((a, b) => b.count - a.count);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}
