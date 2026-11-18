import { describe, expect, it } from "vitest";
import {
  decideHome,
  isReviewDone,
  previousHome,
  rankedParts,
  rankReasons,
  reviewSkipped,
  reviewTally,
  skipHome,
  startReview,
  undoDecision,
} from "./reviewQueue";
import type { ScorePart } from "./scoring";

describe("review queue", () => {
  it("takes each key once, in order", () => {
    expect(startReview(["a", "b", "a", "c"]).keys).toEqual(["a", "b", "c"]);
  });

  it("moves on after a decision and tallies it", () => {
    const decided = decideHome(startReview(["a", "b"]), null, "shortlisted")!;
    expect(decided.mark).toBe("shortlisted");
    expect(decided.session.index).toBe(1);
    const next = decideHome(decided.session, null, "no-foreigners")!.session;
    expect(isReviewDone(next)).toBe(true);
    expect(reviewTally(next)).toEqual({ reviewed: 2, shortlisted: 1, ruledOut: 1, skipped: 0 });
  });

  it("clears a mark chosen again, and stays on the home", () => {
    const decided = decideHome(startReview(["a", "b"]), "shortlisted", "shortlisted")!;
    expect(decided.mark).toBeNull();
    expect(decided.session.index).toBe(0);
    expect(reviewTally(decided.session).reviewed).toBe(0);
  });

  it("undoes the last decision back to the mark it replaced, on that home", () => {
    let session = decideHome(startReview(["a", "b", "c"]), "not-interested", "shortlisted")!.session;
    session = skipHome(session);
    const undone = undoDecision(session)!;
    expect(undone.step).toMatchObject({ key: "a", previousMark: "not-interested" });
    expect(undone.session.index).toBe(0);
    expect(undone.session.outcomes).toEqual({ b: "skipped" });
    expect(undoDecision(undone.session)).toBeUndefined();
  });

  it("skips without overwriting a decision, steps back, and re-reviews the skipped homes", () => {
    let session = decideHome(startReview(["a", "b", "c"]), null, "shortlisted")!.session;
    session = skipHome(skipHome(session));
    session = skipHome(previousHome(previousHome(previousHome(session))));
    expect(session.outcomes).toEqual({ a: "shortlisted", b: "skipped", c: "skipped" });
    expect(previousHome(startReview(["a"])).index).toBe(0);
    const again = reviewSkipped(session);
    expect(again.keys).toEqual(["b", "c"]);
    expect(reviewTally(again)).toEqual({ reviewed: 1, shortlisted: 1, ruledOut: 0, skipped: 0 });
  });

  it("does nothing past the end", () => {
    const done = skipHome(startReview(["a"]));
    expect(skipHome(done)).toBe(done);
    expect(decideHome(done, null, "shortlisted")).toBeUndefined();
  });
});

describe("score reasons", () => {
  const part = (key: ScorePart["key"], score: number | null, weight: number): ScorePart => ({ key, value: 1, score, weight });
  const parts = [
    part("rent", 90, 3),
    part("size", 40, 2),
    part("station", 100, 1),
    part("school", 10, 1),
    part("shop", null, 2),
    part("busStop", 80, 0),
  ];

  it("orders weighted criteria with data by contribution", () => {
    expect(rankedParts(parts).map((p) => p.key)).toEqual(["rent", "station", "size", "school"]);
  });

  it("names the two strongest and the two that cost most", () => {
    const { strongest, weakest } = rankReasons(parts);
    expect(strongest.map((p) => p.key)).toEqual(["rent", "station"]);
    expect(weakest.map((p) => p.key)).toEqual(["size", "school"]);
  });
});
