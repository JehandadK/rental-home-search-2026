import { describe, expect, it } from "vitest";
import { rankByScore, rankMoves } from "./rankMovement";
import type { ScoredRow } from "./scoring";
import type { EnrichedListing } from "./types";

const row = (name: string, total: number | null): ScoredRow => ({
  listing: { name, address: "", rent: 1, sourceId: name } as unknown as EnrichedListing,
  score: { total, parts: [] },
});

describe("rankByScore", () => {
  it("ranks best first, unscored last, and ties in input order", () => {
    const ranks = rankByScore([row("a", 50), row("b", 80), row("c", null), row("d", 50)]);
    expect([...ranks.values()]).toHaveLength(4);
    const byName = (name: string) => [...ranks].find(([key]) => key.includes(name))![1];
    expect([byName("b"), byName("a"), byName("d"), byName("c")]).toEqual([1, 2, 3, 4]);
  });
});

describe("rankMoves", () => {
  it("reports places moved, up positive, and skips unmoved or new listings", () => {
    const before = new Map([["a", 1], ["b", 2], ["c", 3]]);
    const after = new Map([["c", 1], ["a", 2], ["b", 3], ["new", 4]]);
    expect(rankMoves(before, after)).toEqual(new Map([["c", 2], ["a", -1], ["b", -1]]));
    expect(rankMoves(before, before).size).toBe(0);
  });
});
