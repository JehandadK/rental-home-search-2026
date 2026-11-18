import { describe, expect, it } from "vitest";
import {
  DEAL_RATIO,
  estimateMarketRents,
  formatMarketDelta,
  marketVerdict,
  MIN_MARKET_SAMPLE,
  PRICEY_RATIO,
  type MarketEstimate,
} from "./marketRent";
import { listingKey } from "./listingKey";
import type { EnrichedListing } from "./types";

const NOW = new Date("2026-11-18T00:00:00Z");

const listing = (over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  name: "L",
  address: "埼玉県草加市",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2010,
  stationWalkMin: 8,
  url: null,
  source: "test",
  geocoded: true,
  lat: 35.83,
  lon: 139.8,
  ...over,
});

/** A repeatable stand-in for Math.random. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** What a home in the made-up town "should" ask: bigger and newer cost more, the east side 20% more. */
const trueRent = (sizeM2: number, builtYear: number, lon: number) =>
  1_400 * sizeM2 ** 0.9 * (1 - 0.006 * (2026 - builtYear)) * (lon > 139.8 ? 1.2 : 1);

/** A town of homes priced at their true rent, give or take `noise`. */
function town(count: number, noise = 0.03): EnrichedListing[] {
  const random = seeded(7);
  return Array.from({ length: count }, (_, i) => {
    const sizeM2 = 25 + Math.round(random() * 60);
    const builtYear = 1985 + Math.round(random() * 40);
    const lat = 35.8 + random() * 0.05;
    const lon = 139.77 + random() * 0.06;
    const rent = Math.round((trueRent(sizeM2, builtYear, lon) * (1 + (random() - 0.5) * 2 * noise)) / 100) * 100;
    return listing({ id: `home-${i}`, name: `Home ${i}`, sizeM2, builtYear, lat, lon, rent, layout: sizeM2 > 55 ? "3LDK" : "2DK" });
  });
}

const estimate = (over: Partial<MarketEstimate> = {}): MarketEstimate => ({
  expectedRent: 100_000,
  deltaYen: 0,
  deltaRatio: 0,
  confidence: "high",
  comparables: [],
  ...over,
});

describe("estimateMarketRents", () => {
  it("recovers what homes in a town ask from the homes themselves", () => {
    const homes = town(600);
    const estimates = estimateMarketRents(homes, NOW);
    expect(estimates.size).toBe(600);
    const errors = homes
      .map((home) => Math.abs(estimates.get(listingKey(home))!.expectedRent / trueRent(home.sizeM2!, home.builtYear!, home.lon!) - 1))
      .sort((a, b) => a - b);
    // Half the homes within 4% of their true rent, nine in ten within 10%.
    expect(errors[300]).toBeLessThan(0.04);
    expect(errors[540]).toBeLessThan(0.1);
  });

  it("calls a home priced well under its neighbours a deal, and one well over pricey", () => {
    const homes = town(600);
    const fair = trueRent(60, 2005, 139.785);
    const cheap = listing({ id: "cheap", sizeM2: 60, builtYear: 2005, lat: 35.825, lon: 139.785, rent: Math.round(fair * 0.7), layout: "3LDK" });
    const dear = listing({ id: "dear", sizeM2: 60, builtYear: 2005, lat: 35.826, lon: 139.786, rent: Math.round(fair * 1.4), layout: "3LDK" });
    const estimates = estimateMarketRents([...homes, cheap, dear], NOW);

    const cheapEstimate = estimates.get("cheap")!;
    expect(marketVerdict(cheapEstimate)).toBe("deal");
    expect(cheapEstimate.deltaRatio).toBeLessThan(-0.2);
    expect(cheapEstimate.deltaYen).toBe(cheap.rent - cheapEstimate.expectedRent);
    expect(cheapEstimate.expectedRent % 100).toBe(0);

    expect(marketVerdict(estimates.get("dear"))).toBe("pricey");
  });

  it("still sees a deal that is advertised on several portals", () => {
    const homes = town(600);
    const fair = trueRent(60, 2005, 139.785);
    const copy = (id: string, rent: number) =>
      listing({ id, sizeM2: 60, builtYear: 2005, lat: 35.825, lon: 139.785, rent, layout: "3LDK" });
    const rent = Math.round(fair * 0.7);
    // The same room on three more portals, one of them rounded a little differently.
    const copies = [copy("portal-a", rent), copy("portal-b", rent), copy("portal-c", rent), copy("portal-d", rent + 1_000)];
    const estimates = estimateMarketRents([...homes, ...copies], NOW);
    for (const { id } of copies) {
      const result = estimates.get(id!)!;
      expect(marketVerdict(result)).toBe("deal");
      expect(result.comparables.map(({ key }) => key)).not.toEqual(expect.arrayContaining(["portal-a", "portal-b", "portal-c", "portal-d"]));
    }
  });

  it("shows the nearest similar homes as evidence, never the home itself", () => {
    const homes = town(600);
    const estimates = estimateMarketRents(homes, NOW);
    const subject = homes[0];
    const { comparables } = estimates.get(listingKey(subject))!;
    expect(comparables.length).toBeGreaterThan(0);
    expect(comparables.length).toBeLessThanOrEqual(4);
    for (const comparable of comparables) {
      expect(comparable.key).not.toBe(listingKey(subject));
      expect(Math.abs(comparable.sizeM2 - subject.sizeM2!)).toBeLessThanOrEqual(0.3 * subject.sizeM2!);
      expect(comparable.distanceM).toBeLessThan(3_000);
    }
  });

  it("does not let one absurd rent move its neighbours' estimates", () => {
    const homes = town(600);
    const before = estimateMarketRents(homes, NOW);
    const typo = listing({ id: "typo", sizeM2: 50, builtYear: 2000, lat: 35.825, lon: 139.785, rent: 5_000_000 });
    const after = estimateMarketRents([...homes, typo], NOW);
    const moved = homes.map((home) => Math.abs(after.get(listingKey(home))!.expectedRent / before.get(listingKey(home))!.expectedRent - 1));
    expect(Math.max(...moved)).toBeLessThan(0.08);
    expect(moved.sort((a, b) => a - b)[300]).toBeLessThan(0.01);
  });

  it("is unsure about a home far from every other, and about a floor area outside the usual range", () => {
    const homes = town(600);
    const remote = listing({ id: "remote", lat: 36.4, lon: 140.4 });
    const mansion = listing({ id: "mansion", sizeM2: 320, lat: 35.825, lon: 139.785, rent: 500_000 });
    const estimates = estimateMarketRents([...homes, remote, mansion], NOW);
    expect(estimates.get("remote")!.confidence).toBe("low");
    expect(marketVerdict(estimates.get("remote"))).toBeNull();
    expect(estimates.get("mansion")!.confidence).toBe("low");
    expect(estimates.get(listingKey(homes[0]))!.confidence).toBe("high");
  });

  it("skips homes missing a size, an age or a location, and still estimates the rest", () => {
    const homes = town(200);
    const estimates = estimateMarketRents([
      ...homes,
      listing({ id: "no-size", sizeM2: null }),
      listing({ id: "no-year", builtYear: null }),
      listing({ id: "no-place", lat: undefined, lon: undefined, geocoded: false }),
    ], NOW);
    expect(estimates.size).toBe(200);
    expect(estimates.has("no-size")).toBe(false);
    expect(estimates.has("no-year")).toBe(false);
    expect(estimates.has("no-place")).toBe(false);
  });

  it("makes no estimate from too few homes", () => {
    expect(estimateMarketRents(town(MIN_MARKET_SAMPLE - 1), NOW).size).toBe(0);
    expect(estimateMarketRents([], NOW).size).toBe(0);
  });

  it("gives the same answer whatever order the listings come in", () => {
    const homes = town(300);
    const forward = estimateMarketRents(homes, NOW);
    const backward = estimateMarketRents([...homes].reverse(), NOW);
    for (const home of homes) {
      const key = listingKey(home);
      expect(backward.get(key)!.expectedRent / forward.get(key)!.expectedRent).toBeCloseTo(1, 2);
    }
  });
});

describe("marketVerdict", () => {
  it("draws the lines at the deal and pricey ratios", () => {
    expect(marketVerdict(estimate({ deltaRatio: DEAL_RATIO }))).toBe("deal");
    expect(marketVerdict(estimate({ deltaRatio: DEAL_RATIO + 0.01 }))).toBe("fair");
    expect(marketVerdict(estimate({ deltaRatio: PRICEY_RATIO }))).toBe("pricey");
    expect(marketVerdict(estimate({ deltaRatio: PRICEY_RATIO - 0.01 }))).toBe("fair");
  });

  it("gives no verdict without an estimate or on thin evidence", () => {
    expect(marketVerdict(undefined)).toBeNull();
    expect(marketVerdict(estimate({ deltaRatio: -0.5, confidence: "low" }))).toBeNull();
    expect(marketVerdict(estimate({ deltaRatio: -0.5, confidence: "medium" }))).toBe("deal");
  });
});

describe("formatMarketDelta", () => {
  it("writes a signed whole percentage", () => {
    expect(formatMarketDelta(-0.124)).toBe("−12%");
    expect(formatMarketDelta(0.08)).toBe("+8%");
    expect(formatMarketDelta(0.004)).toBe("±0%");
    expect(formatMarketDelta(-0.004)).toBe("±0%");
  });
});
