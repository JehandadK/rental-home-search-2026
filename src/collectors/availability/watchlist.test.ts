import { describe, expect, it } from "vitest";
import { selectWatchlist } from "./watchlist";
import { VisitGuard } from "./visitGuard";
import { parseWatchConfig, DEFAULT_WATCH } from "./watchConfig";
import { adKey, type AvailabilityMap } from "../../domain/availability";
import type { RawListing } from "../../domain/types";

const NOW = new Date("2026-11-11T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const suumo = (n: number) => `https://suumo.jp/chintai/jnc_${String(n).padStart(12, "0")}/?bc=${n}`;
const athome = (n: number) => `https://www.athome.co.jp/chintai/${n}/`;

/** A home whose name is its score, last seen `seenDaysAgo` days ago. */
const home = (score: number, seenDaysAgo: number, over: Partial<RawListing> = {}): RawListing => ({
  name: String(score), address: "埼玉県草加市1", rent: 80000, layout: "2LDK", sizeM2: 60, builtYear: 2010, stationWalkMin: 5,
  url: suumo(score), source: "suumo", lastSeenAt: daysAgo(seenDaysAgo), sourceListings: [{ source: "suumo", url: suumo(score) }], ...over,
});
const record = (url: string, state: "listed" | "gone", checkedDaysAgo: number, source = "suumo"): AvailabilityMap =>
  ({ [adKey(source, url)]: { source, url, state, checkedAt: daysAgo(checkedDaysAgo), evidence: "test", method: "probe" } });
const select = (listings: RawListing[], known: AvailabilityMap = {}, top = 300) =>
  selectWatchlist(listings, known, { top, staleDays: 5, now: NOW, scoreOf: (listing) => Number(listing.name) }).map((candidate) => candidate.listing.name);

describe("selectWatchlist", () => {
  it("watches only the best-scoring homes", () => {
    expect(select([home(50, 30), home(70, 30), home(60, 30)], {}, 2)).toEqual(["70", "60"]);
  });

  it("leaves alone a home a refresh saw, or a check confirmed, within the stale window", () => {
    const known = record(suumo(60), "listed", 2);
    expect(select([home(70, 1), home(60, 40), home(50, 40)], known)).toEqual(["50"]);
  });

  it("counts the newer of the last sighting and the last live check", () => {
    const [candidate] = selectWatchlist([home(70, 40)], record(suumo(70), "listed", 9), { top: 5, staleDays: 5, now: NOW, scoreOf: () => 70 });
    expect(candidate.confirmedAt).toBe(daysAgo(9));
    expect(candidate.ageDays).toBeCloseTo(9);
  });

  it("puts the most overdue first, and a better home ahead of an equally stale one", () => {
    expect(select([home(60, 20), home(70, 20), home(65, 60)])).toEqual(["65", "70", "60"]);
  });

  it("lets a lower-ranked home wait longer than a top one", () => {
    // 51 homes: the best is 10 days stale, the worst (rank 51, half as urgent) 15 days.
    const others = Array.from({ length: 49 }, (_, i) => home(80 - i, 0));
    expect(select([home(90, 10), ...others, home(10, 15)])).toEqual(["90", "10"]);
  });

  it("treats a home with no sighting or check on record as long overdue", () => {
    expect(select([home(70, 60), home(60, 0, { lastSeenAt: null })])).toEqual(["60", "70"]);
  });

  it("skips homes that are settled: sold, rented out, likely rented", () => {
    const both = [{ source: "suumo", url: suumo(60) }, { source: "nifty", url: "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_aa11/" }];
    const listings = [home(70, 30, { status: "sold" }), home(65, 30), home(60, 30, { sourceListings: both }), home(55, 30)];
    const known = { ...record(suumo(65), "gone", 3), ...record(suumo(60), "gone", 3) };
    expect(select(listings, known)).toEqual(["55"]);
  });

  it("leaves UR rooms to the UR sweep, and unscored or ad-less homes out", () => {
    const ur = home(70, 30, { source: "ur", sourceListings: [{ source: "ur", url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_1230_room.html?JKSS=000010101" }] });
    const picked = selectWatchlist([ur, home(60, 30, { url: null as unknown as string, sourceListings: [] }), home(50, 30), home(40, 30)], {}, {
      top: 5, staleDays: 5, now: NOW, scoreOf: (listing) => (listing.name === "40" ? null : Number(listing.name)),
    });
    expect(picked.map((candidate) => [candidate.listing.name, candidate.rank])).toEqual([["50", 1]]);
  });
});

describe("VisitGuard", () => {
  const check = (source: string, verdict: "listed" | "gone" | "unknown", evidence = "") => ({ source, url: athome(1), verdict, evidence });

  it("counts page loads against the budget", () => {
    const guard = new VisitGuard(2);
    guard.admit("suumo");
    expect(guard.exhausted).toBe(false);
    guard.admit("athome");
    expect(guard.exhausted).toBe(true);
  });

  it("pauses a portal after one verification page, without spending loads on it again", () => {
    const guard = new VisitGuard(10);
    guard.admit("athome");
    guard.record([check("athome", "unknown", "verification or busy page: 認証にご協力ください")]);
    expect(() => guard.admit("athome")).toThrow(/not visited: athome paused/);
    expect(() => guard.admit("suumo")).not.toThrow();
    expect(guard.loads).toBe(2);
    expect([...guard.pausedPortals.keys()]).toEqual(["athome"]);
  });

  it("pauses a portal after two unreadable pages in a row, not after one", () => {
    const guard = new VisitGuard(10);
    guard.record([check("nifty", "unknown", "visit failed: timeout")]);
    guard.record([check("nifty", "listed")]);
    guard.record([check("nifty", "unknown", "HTTP 500")]);
    expect(guard.pausedPortals.size).toBe(0);
    guard.record([check("nifty", "unknown", "visit failed: timeout")]);
    expect(guard.pausedPortals.get("nifty")).toMatch(/2 unreadable pages/);
  });

  it("does not count an ad it refused to visit as another failure", () => {
    const guard = new VisitGuard(10);
    guard.record([check("suumo", "unknown", "visit failed: timeout")]);
    guard.record([check("suumo", "unknown", "visit failed: not visited: athome paused after a verification or busy page")]);
    expect(guard.pausedPortals.size).toBe(0);
  });
});

describe("parseWatchConfig", () => {
  it("reads the availability block and keeps defaults for anything missing or malformed", () => {
    expect(parseWatchConfig({ sources: {} })).toEqual(DEFAULT_WATCH);
    expect(parseWatchConfig({ availability: { top: 120, pageLoads: 0, staleDays: -1, criteria: { weights: { rent: 2 } } } }))
      .toEqual({ top: 120, pageLoads: 0, staleDays: DEFAULT_WATCH.staleDays, criteria: { weights: { rent: 2 } } });
    expect(parseWatchConfig({ availability: { top: "many", criteria: [1] } })).toEqual(DEFAULT_WATCH);
  });
});
