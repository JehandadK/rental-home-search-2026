import { describe, expect, it } from "vitest";
import { buildBriefing, decodeSeenDataAt, isQuietBriefing, newestFirstSeen, type BriefingInput } from "./briefing";
import type { MarketEstimate } from "./marketRent";
import type { ScoredRow } from "./scoring";
import type { EnrichedListing } from "./types";

const NOW = new Date(2026, 10, 18, 9, 0);

const listing = (id: string, over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  id,
  name: id,
  address: "埼玉県草加市",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2010,
  stationWalkMin: 8,
  url: `https://example.test/${id}`,
  source: "suumo",
  geocoded: true,
  status: "active",
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const row = (home: EnrichedListing, total: number): ScoredRow => ({ listing: home, score: { total, parts: [] } });

const estimate = (deltaRatio: number, over: Partial<MarketEstimate> = {}): MarketEstimate => ({
  expectedRent: 100_000,
  deltaYen: Math.round(deltaRatio * 100_000),
  deltaRatio,
  confidence: "high",
  comparables: [],
  ...over,
});

const gone = (home: EnrichedListing): EnrichedListing => ({
  ...home,
  sourceListings: [{
    source: "suumo",
    id: home.id,
    url: home.url,
    availability: { state: "gone", checkedAt: "2026-11-17T00:00:00.000Z", evidence: "404", method: "probe" },
  }],
});

function brief(over: Partial<BriefingInput> & { homes: [EnrichedListing, number][] }) {
  const { homes, ...rest } = over;
  return buildBriefing({
    rows: homes.map(([home, total]) => row(home, total)),
    all: homes.map(([home]) => home),
    marks: {},
    notes: {},
    market: new Map(),
    seenDataAt: null,
    newWithinDays: 14,
    now: NOW,
    ...rest,
  });
}

describe("buildBriefing", () => {
  it("counts homes first seen after the acknowledged data as unseen, best first", () => {
    const old = listing("old", { firstSeenAt: "2026-11-10T00:00:00.000Z" });
    const fresh = listing("fresh", { firstSeenAt: "2026-11-18T02:00:00.000Z" });
    const fresher = listing("fresher", { firstSeenAt: "2026-11-18T02:10:00.000Z" });
    const briefing = brief({ homes: [[old, 90], [fresh, 60], [fresher, 75]], seenDataAt: "2026-11-13T03:10:00.000Z" });
    expect(briefing.unseen.map(({ listing: home }) => home.id)).toEqual(["fresher", "fresh"]);
    expect(briefing.undecided.map(({ listing: home }) => home.id)).toEqual(["old", "fresher", "fresh"]);
    expect(briefing.dataAt).toBe("2026-11-18T02:10:00.000Z");
  });

  it("falls back to the new window until anything has been acknowledged", () => {
    const recent = listing("recent", { firstSeenAt: "2026-11-10T00:00:00.000Z" });
    const stale = listing("stale", { firstSeenAt: "2026-10-01T00:00:00.000Z" });
    const undated = listing("undated", { firstSeenAt: null });
    const briefing = brief({ homes: [[recent, 50], [stale, 80], [undated, 70]] });
    expect(briefing.unseen.map(({ listing: home }) => home.id)).toEqual(["recent"]);
  });

  it("leaves decided and taken homes out of what to review", () => {
    const marked = listing("marked", { firstSeenAt: "2026-11-18T00:00:00.000Z" });
    const taken = gone(listing("taken", { firstSeenAt: "2026-11-18T00:00:00.000Z" }));
    const sold = listing("sold", { firstSeenAt: "2026-11-18T00:00:00.000Z", status: "sold" });
    const open = listing("open", { firstSeenAt: "2026-11-18T00:00:00.000Z" });
    const briefing = brief({
      homes: [[marked, 90], [taken, 80], [sold, 70], [open, 60]],
      marks: { marked: "not-interested" },
      seenDataAt: "2026-11-13T00:00:00.000Z",
    });
    expect(briefing.unseen.map(({ listing: home }) => home.id)).toEqual(["open"]);
    expect(briefing.undecided.map(({ listing: home }) => home.id)).toEqual(["open"]);
  });

  it("lists undecided deals, the biggest gap first, and only on firm evidence", () => {
    const a = listing("a");
    const b = listing("b");
    const c = listing("c");
    const d = listing("d");
    const briefing = brief({
      homes: [[a, 90], [b, 50], [c, 70], [d, 60]],
      market: new Map([
        ["a", estimate(-0.16)],
        ["b", estimate(-0.3)],
        ["c", estimate(-0.05)],
        ["d", estimate(-0.4, { confidence: "low" })],
      ]),
    });
    expect(briefing.deals.map(({ listing: home }) => home.id)).toEqual(["b", "a"]);
  });

  it("warns when a shortlisted or applied-for home looks taken, even one the filters hide", () => {
    const shortlisted = gone(listing("shortlisted"));
    const applied = listing("applied", { status: "sold" });
    const ruledOut = gone(listing("ruled-out"));
    const fine = listing("fine");
    const briefing = buildBriefing({
      rows: [row(fine, 50)],
      all: [shortlisted, applied, ruledOut, fine],
      marks: { shortlisted: "shortlisted", applied: "applied", "ruled-out": "taken", fine: "shortlisted" },
      notes: {},
      market: new Map(),
      seenDataAt: null,
      newWithinDays: 14,
      now: NOW,
    });
    expect(briefing.gone.map(({ key, reason }) => [key, reason])).toEqual([
      ["shortlisted", "rented-out"],
      ["applied", "sold"],
    ]);
  });

  it("lists viewings from today on, soonest first, and drops those of ruled-out homes", () => {
    const a = listing("a");
    const b = listing("b");
    const c = listing("c");
    const d = listing("d");
    const note = (viewingAt: string) => ({ text: "", viewingAt, updatedAt: "2026-11-01T00:00:00.000Z" });
    const briefing = brief({
      homes: [[a, 1], [b, 1], [c, 1], [d, 1]],
      notes: { a: note("2026-11-21T14:00"), b: note("2026-11-18"), c: note("2026-11-17T10:00"), d: note("2026-11-19T09:00") },
      marks: { d: "not-interested" },
    });
    expect(briefing.viewings.map(({ key }) => key)).toEqual(["b", "a"]);
  });

  it("is quiet when there is nothing to act on", () => {
    const seen = listing("seen", { firstSeenAt: "2026-11-01T00:00:00.000Z" });
    const briefing = brief({ homes: [[seen, 50]], seenDataAt: "2026-11-01T00:00:00.000Z" });
    expect(isQuietBriefing(briefing)).toBe(true);
    expect(briefing.undecided).toHaveLength(1);
  });
});

describe("newestFirstSeen", () => {
  it("returns the latest first-seen time, ignoring undated homes", () => {
    expect(newestFirstSeen([
      listing("a", { firstSeenAt: "2026-11-01T00:00:00.000Z" }),
      listing("b", { firstSeenAt: null }),
      listing("c", { firstSeenAt: "2026-11-18T02:10:00.000Z" }),
    ])).toBe("2026-11-18T02:10:00.000Z");
    expect(newestFirstSeen([listing("b", { firstSeenAt: null })])).toBeNull();
    expect(newestFirstSeen([])).toBeNull();
  });
});

describe("decodeSeenDataAt", () => {
  it("keeps a readable time and drops anything else", () => {
    expect(decodeSeenDataAt("2026-11-18T02:10:00.000Z")).toBe("2026-11-18T02:10:00.000Z");
    expect(decodeSeenDataAt("soon")).toBeNull();
    expect(decodeSeenDataAt(42)).toBeNull();
    expect(decodeSeenDataAt(undefined)).toBeNull();
  });
});
