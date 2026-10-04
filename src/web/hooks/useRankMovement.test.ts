// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingKey } from "../../domain/listingKey";
import type { ScoredRow } from "../../domain/scoring";
import type { EnrichedListing } from "../../domain/types";
import { useRankMovement } from "./useRankMovement";

const listing = (name: string) => ({ name, address: name, rent: 1 }) as unknown as EnrichedListing;
const [a, b, c] = ["a", "b", "c"].map(listing);
const ranked = (...order: EnrichedListing[]): ScoredRow[] =>
  order.map((home, i) => ({ listing: home, score: { total: 100 - i, parts: [] } }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useRankMovement", () => {
  it("shows moves after a scoring change, measured from before the first of a burst, then clears", () => {
    const { result, rerender } = renderHook(
      ({ rows, cause }) => useRankMovement(rows, [cause], 4000),
      { initialProps: { rows: ranked(a, b, c), cause: 1 } },
    );
    expect(result.current.size).toBe(0);

    rerender({ rows: ranked(b, a, c), cause: 2 });
    expect(result.current.get(listingKey(b))).toBe(1);
    expect(result.current.get(listingKey(a))).toBe(-1);

    // A second change inside the window keeps the original baseline.
    act(() => vi.advanceTimersByTime(3000));
    rerender({ rows: ranked(c, b, a), cause: 3 });
    expect(result.current.get(listingKey(c))).toBe(2);
    expect(result.current.get(listingKey(a))).toBe(-2);
    expect(result.current.has(listingKey(b))).toBe(false);

    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.size).toBe(0);
  });

  it("re-ranks silently when something other than the scoring changes", () => {
    const { result, rerender } = renderHook(
      ({ rows, cause }) => useRankMovement(rows, [cause]),
      { initialProps: { rows: ranked(a, b, c), cause: 1 } },
    );
    rerender({ rows: ranked(c, a), cause: 1 });
    expect(result.current.size).toBe(0);
  });

  it("ends a showing window when a filter re-ranks, rather than crediting the scoring", () => {
    const { result, rerender } = renderHook(
      ({ rows, cause }) => useRankMovement(rows, [cause]),
      { initialProps: { rows: ranked(a, b, c), cause: 1 } },
    );
    rerender({ rows: ranked(b, a, c), cause: 2 });
    expect(result.current.size).toBe(2);
    rerender({ rows: ranked(c, b), cause: 2 });
    expect(result.current.size).toBe(0);
  });
});
