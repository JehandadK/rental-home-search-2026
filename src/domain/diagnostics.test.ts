import { describe, expect, it } from "vitest";
import { diagnoseAll, diagnoseParameter } from "./diagnostics";
import type { ScoredRow } from "../web/lib/export";
import type { EnrichedListing, ScoreParameterKey } from "../types";
import type { ListingScore, ScorePart } from "./scoring";

const listing = { name: "L", address: "a", rent: 1 } as EnrichedListing;

/** Build a scored row exposing one parameter with a given score/value. */
const row = (key: ScoreParameterKey, score: number | null, value: number | null): ScoredRow => {
  const part: ScorePart = { key, score, value, weight: 8 };
  const listingScore: ListingScore = { total: score, parts: [part] };
  return { listing, score: listingScore };
};

const WEIGHTS = {
  rent: 7, rentPerM2: 10, moveInCost: 4, size: 5, yearBuilt: 3, poi1: 8, poi2: 8,
  station: 9, busStop: 4, kindergarten: 6, school: 6,
};

describe("diagnoseParameter", () => {
  it("flags a parameter where nearly everything scores zero", () => {
    // 19 of 20 at zero — the real poi1 situation (12-min anchor, 60-min walks).
    const rows = [
      ...Array.from({ length: 19 }, (_, i) => row("poi1", 0, 40 + i)),
      row("poi1", 60, 5),
    ];
    const d = diagnoseParameter("poi1", rows);
    expect(d.kind).toBe("allZero");
    expect(d.zeroShare).toBeCloseTo(0.95, 2);
    expect(d.message).toContain("95%");
    // Suggested anchor is fitted to observed values, well beyond the old 12.
    expect(d.suggestedAnchor).toBeGreaterThan(12);
  });

  it("flags a parameter where nearly everything scores full", () => {
    const rows = Array.from({ length: 10 }, () => row("busStop", 100, 1));
    const d = diagnoseParameter("busStop", rows);
    expect(d.kind).toBe("allFull");
    expect(d.fullShare).toBe(1);
  });

  it("passes a parameter with a healthy spread", () => {
    const rows = [0, 20, 40, 60, 80, 100].map((s, i) => row("rent", s, i * 10));
    expect(diagnoseParameter("rent", rows).kind).toBe("ok");
  });

  it("reports missing data separately", () => {
    const rows = [row("school", null, null), row("school", null, null)];
    expect(diagnoseParameter("school", rows).kind).toBe("noData");
  });

  it("suggests the 75th percentile of observed values", () => {
    const rows = [10, 20, 30, 40].map((v) => row("poi1", 0, v));
    // p75 of [10,20,30,40] → index 3 → 40
    expect(diagnoseParameter("poi1", rows).suggestedAnchor).toBe(40);
  });
});

describe("diagnoseAll", () => {
  it("returns only problem parameters that carry weight", () => {
    const rows = [
      ...Array.from({ length: 19 }, () => row("poi1", 0, 50)),
      row("poi1", 10, 5),
    ];
    const found = diagnoseAll(["poi1"], rows, WEIGHTS);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe("poi1");
  });

  it("ignores parameters whose weight is zero", () => {
    const rows = Array.from({ length: 10 }, () => row("poi1", 0, 50));
    expect(diagnoseAll(["poi1"], rows, { ...WEIGHTS, poi1: 0 })).toHaveLength(0);
  });
});
