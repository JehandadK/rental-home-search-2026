import { describe, expect, it } from "vitest";
import { bestIndexes, MAX_COMPARE, toggleCompare } from "./compare";

describe("toggleCompare", () => {
  it("adds at the end and removes on a second toggle", () => {
    expect(toggleCompare(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleCompare(["a", "b"], "a")).toEqual(["b"]);
  });

  it("refuses to grow past the limit but still removes", () => {
    const full = ["a", "b", "c", "d"];
    expect(full).toHaveLength(MAX_COMPARE);
    expect(toggleCompare(full, "e")).toEqual(full);
    expect(toggleCompare(full, "c")).toEqual(["a", "b", "d"]);
  });
});

describe("bestIndexes", () => {
  it("picks the lowest or highest value, ties included", () => {
    expect([...bestIndexes([90_000, 80_000, 80_000], "low")]).toEqual([1, 2]);
    expect([...bestIndexes([55, 70, 62], "high")]).toEqual([1]);
  });

  it("ignores missing values", () => {
    expect([...bestIndexes([null, 12, 8, undefined], "low")]).toEqual([2]);
  });

  it("names no winner with one value or when all are equal", () => {
    expect(bestIndexes([null, 5], "low").size).toBe(0);
    expect(bestIndexes([5, 5, 5], "high").size).toBe(0);
  });
});
