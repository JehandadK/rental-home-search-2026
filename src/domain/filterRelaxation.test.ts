import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, type ListingFilters } from "./filters";
import { relaxationHints } from "./filterRelaxation";

describe("relaxationHints", () => {
  // A stand-in pipeline: each active filter removes a fixed share of 20 homes.
  const countMatching = (filters: ListingFilters) => {
    let n = 20;
    if (filters.rentMax != null) n -= 14;
    if (filters.layouts.length) n -= 11;
    if (filters.newOnly) n -= 20;
    return Math.max(0, n);
  };

  it("lists each active filter that brings homes back on its own, most first", () => {
    const filters = { ...EMPTY_FILTERS, rentMax: 60_000, layouts: ["3"], newOnly: true };
    const hints = relaxationHints(filters, countMatching);
    // Any two of these filters already exclude everything, so no single clear helps.
    expect(hints).toEqual([]);
    const withoutNew = relaxationHints({ ...filters, newOnly: false }, countMatching);
    expect(withoutNew.map(({ id, count }) => [id, count])).toEqual([["rent", 9], ["layouts", 6]]);
    expect(withoutNew[0].patch).toEqual({ rentMin: null, rentMax: null });
  });

  it("ignores inactive filters, including an area mode with no areas", () => {
    const seen: ListingFilters[] = [];
    relaxationHints({ ...EMPTY_FILTERS, areaMode: "exclude" }, (filters) => {
      seen.push(filters);
      return 1;
    });
    expect(seen).toHaveLength(0);
  });
});
