import { describe, expect, it } from "vitest";
import {
  markMeta,
  markRank,
  matchesMarkFilter,
  summarizeMarks,
  type ListingMark,
} from "./marks";

describe("mark metadata", () => {
  it("looks up a mark's metadata", () => {
    expect(markMeta("taken")?.labelJa).toBe("成約済");
    expect(markMeta(undefined)).toBeNull();
  });
});

describe("matchesMarkFilter", () => {
  const cases: [ListingMark | undefined, boolean, boolean, boolean, boolean, boolean][] = [
    //              all  hideRuledOut  shortlist  unmarked  ruledOut
    ["shortlisted", true, true, true, false, false],
    ["applied", true, true, true, false, false],
    ["taken", true, false, false, false, true],
    ["not-interested", true, false, false, false, true],
    ["no-foreigners", true, false, false, false, true],
    [undefined, true, true, false, true, false],
  ];

  it.each(cases)(
    "mark %s",
    (
      mark: ListingMark | undefined,
      all: boolean,
      hideRuledOut: boolean,
      shortlist: boolean,
      unmarked: boolean,
      ruledOut: boolean,
    ) => {
      expect(matchesMarkFilter(mark, "all")).toBe(all);
      expect(matchesMarkFilter(mark, "hideRuledOut")).toBe(hideRuledOut);
      expect(matchesMarkFilter(mark, "shortlist")).toBe(shortlist);
      expect(matchesMarkFilter(mark, "unmarked")).toBe(unmarked);
      expect(matchesMarkFilter(mark, "ruledOut")).toBe(ruledOut);
    },
  );
});

describe("markRank", () => {
  it("orders candidates before undecided before ruled out", () => {
    expect(markRank("shortlisted")).toBeLessThan(markRank(undefined));
    expect(markRank(undefined)).toBeLessThan(markRank("taken"));
    expect(markRank("applied")).toBe(markRank("shortlisted"));
    expect(markRank("no-foreigners")).toBe(markRank("taken"));
  });
});

describe("summarizeMarks", () => {
  it("counts candidates and ruled-out marks, ignoring the undecided", () => {
    expect(
      summarizeMarks(["shortlisted", "applied", "taken", undefined, "no-foreigners"]),
    ).toEqual({ candidates: 2, ruledOut: 2, total: 4 });
    expect(summarizeMarks([])).toEqual({ candidates: 0, ruledOut: 0, total: 0 });
  });
});
