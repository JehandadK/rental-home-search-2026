import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ScoringConfig } from "./scoringConfig";
import type { EnrichedListing, Proximity } from "./types";
import { higherIsBetter, lowerIsBetter, scoreListing, walkScore } from "./scoring";

// Walk minutes are recomputed from distM at scoring time, so encode distM such
// that the default knobs (80 m/min, 1.3 detour) reproduce the intended minutes.
const prox = (name: string, walkMin: number): Proximity => ({
  name,
  distM: (walkMin * DEFAULT_CONFIG.walkSpeedMPerMin) / DEFAULT_CONFIG.detourFactor,
  walkMin,
});

const baseListing: EnrichedListing = {
  name: "Test",
  address: "埼玉県草加市",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2000,
  stationWalkMin: null,
  url: null,
  source: "test",
  geocoded: true,
};

const makeListing = (over: Partial<EnrichedListing>): EnrichedListing => ({
  ...baseListing,
  ...over,
});

describe("normalisers", () => {
  it("lowerIsBetter hits both anchors and the midpoint", () => {
    expect(lowerIsBetter(50_000, 50_000, 200_000)).toBe(100);
    expect(lowerIsBetter(200_000, 50_000, 200_000)).toBe(0);
    expect(lowerIsBetter(125_000, 50_000, 200_000)).toBe(50);
  });

  it("lowerIsBetter clamps out-of-range values", () => {
    expect(lowerIsBetter(10_000, 50_000, 200_000)).toBe(100);
    expect(lowerIsBetter(500_000, 50_000, 200_000)).toBe(0);
  });

  it("higherIsBetter hits both anchors and the midpoint", () => {
    expect(higherIsBetter(70, 70, 18)).toBe(100);
    expect(higherIsBetter(18, 70, 18)).toBe(0);
    expect(higherIsBetter(44, 70, 18)).toBe(50);
  });

  it("walkScore is 100 at the doorstep and 0 at the limit", () => {
    expect(walkScore(0, 12)).toBe(100);
    expect(walkScore(12, 12)).toBe(0);
    expect(walkScore(6, 12)).toBe(50);
    expect(walkScore(30, 12)).toBe(0);
  });
});

describe("rent per exclusive area scoring", () => {
  it("strongly rewards lower rent per square metre", () => {
    const spacious = makeListing({ rent: 100_000, sizeM2: 80 }); // ¥1,250/㎡
    const cramped = makeListing({ rent: 100_000, sizeM2: 40 }); // ¥2,500/㎡
    const spaciousPart = scoreListing(spacious, DEFAULT_CONFIG).parts.find((p) => p.key === "rentPerM2")!;
    const crampedPart = scoreListing(cramped, DEFAULT_CONFIG).parts.find((p) => p.key === "rentPerM2")!;
    expect(spaciousPart.value).toBe(1250);
    expect(spaciousPart.score).toBeGreaterThan(crampedPart.score!);
    expect(spaciousPart.weight).toBe(10);
  });

  it("excludes the ratio when exclusive area is missing", () => {
    expect(scoreListing(makeListing({ sizeM2: null }), DEFAULT_CONFIG).parts.find(
      (p) => p.key === "rentPerM2",
    )!.score).toBeNull();
  });
});

describe("qualitative feature scoring", () => {
  it("scores a user-enabled feature and ignores it at weight zero", () => {
    const l = makeListing({
      attributes: [{
        key: "internetFree", category: "connectivity", labelEn: "Free internet",
        labelJa: "インターネット無料", state: true, raw: "インターネット無料",
      }],
    });
    const enabled = {
      ...DEFAULT_CONFIG,
      featureWeights: { ...DEFAULT_CONFIG.featureWeights, internetFree: 5 },
    };
    const part = scoreListing(l, enabled).parts.find((item) => item.key === "internetFree")!;
    expect(part.score).toBe(100);
    expect(part.weight).toBe(5);
    expect(scoreListing(l, DEFAULT_CONFIG).parts.find((item) => item.key === "internetFree")!.weight).toBe(0);
  });

  it("ignores unknown attributes rather than treating them as no", () => {
    const enabled = {
      ...DEFAULT_CONFIG,
      featureWeights: { ...DEFAULT_CONFIG.featureWeights, petAllowed: 10 },
    };
    expect(scoreListing(makeListing({ attributes: [] }), enabled).parts.find((p) => p.key === "petAllowed")!.score).toBeNull();
  });

  it("supports preferring absence for undesirable features", () => {
    const l = makeListing({ attributes: [{
      key: "fixedTermLease", category: "tenancy", labelEn: "Fixed-term lease",
      labelJa: "定期借家", state: false, raw: "普通借家",
    }] });
    const enabled = {
      ...DEFAULT_CONFIG,
      featureWeights: { ...DEFAULT_CONFIG.featureWeights, fixedTermLease: 4 },
      featurePreferences: { ...DEFAULT_CONFIG.featurePreferences, fixedTermLease: "avoid" as const },
    };
    expect(scoreListing(l, enabled).parts.find((p) => p.key === "fixedTermLease")!.score).toBe(100);
  });
});

describe("scoreListing", () => {
  it("computes the weighted average across all parameters", () => {
    const listing: EnrichedListing = {
      ...baseListing,
      rent: 125_000, // → 50
      sizeM2: 44, // → 50
      builtYear: new Date().getFullYear(), // → age 0 → 100
      stationWalkMin: 10, // → walkScore(10, 20) = 50
      poi1: prox("Al Sanad", 6), // → 50
      poi2: prox("Masjid", 12), // → 0
      busStop: prox("Bus", 5), // → 50
      kindergarten: prox("Yochien", 7.5), // → 50
      school: prox("Shogakko", 15), // → 0
    };
    // Isolate the nine location/property parameters from the move-in one,
    // which has its own dedicated tests below.
    const config = {
      ...DEFAULT_CONFIG,
      weights: { ...DEFAULT_CONFIG.weights, rentPerM2: 0, moveInCost: 0 },
    };
    const { total, parts } = scoreListing(listing, config);
    expect(parts.filter((p) => p.weight > 0).every((p) => p.score != null)).toBe(true);
    // Σ(score×w) = 350+250+300+400+0+450+200+300+0 = 2250; Σw = 56
    expect(total).toBeCloseTo(2250 / 56, 6);
  });

  it("excludes missing parameters from the denominator", () => {
    const listing: EnrichedListing = {
      ...baseListing,
      rent: 50_000, // → 100, the only scoreable parameter
      sizeM2: null,
      builtYear: null,
    };
    // Move-in cost is always computable (it falls back to assumptions), so
    // zero its weight to leave rent as the single contributor.
    const config = {
      ...DEFAULT_CONFIG,
      weights: { ...DEFAULT_CONFIG.weights, rentPerM2: 0, moveInCost: 0 },
    };
    expect(scoreListing(listing, config).total).toBe(100);
  });

  it("returns null total when nothing is scoreable", () => {
    const listing: EnrichedListing = {
      ...baseListing,
      rent: NaN,
      sizeM2: null,
      builtYear: null,
    };
    const config: ScoringConfig = { ...DEFAULT_CONFIG };
    // NaN rent produces a NaN score rather than null; assert null-path via weights instead
    const zeroWeights = {
      ...config,
      weights: Object.fromEntries(Object.keys(config.weights).map((k) => [k, 0])) as typeof config.weights,
    };
    expect(scoreListing(baseListing, zeroWeights).total).toBeNull();
    expect(Number.isNaN(scoreListing(listing, config).total)).toBe(true);
  });

  it("prefers the agent-listed 徒歩分 over the coordinate estimate", () => {
    const listing: EnrichedListing = {
      ...baseListing,
      stationWalkMin: 20, // → 0
      station: prox("Soka", 0), // would be 100
    };
    const part = scoreListing(listing, DEFAULT_CONFIG).parts.find((p) => p.key === "station");
    expect(part?.value).toBe(20);
    expect(part?.score).toBe(0);
  });

  it("ignores the advertised 徒歩分 when a different station is being measured", () => {
    // The ad quotes 3 min to 新田, but the dashboard now measures 草加 — the
    // advertised figure describes the wrong walk, so the estimate must win.
    const listing: EnrichedListing = {
      ...baseListing,
      advertisedStation: "新田駅",
      stationWalkMin: 3,
      station: prox("草加", 18),
    };
    const part = scoreListing(listing, DEFAULT_CONFIG).parts.find((p) => p.key === "station");
    expect(part?.value).toBeCloseTo(18, 4);
    expect(part?.detail).toBe("草加");
  });

  it("keeps the advertised 徒歩分 when it matches the measured station", () => {
    const listing: EnrichedListing = {
      ...baseListing,
      advertisedStation: "新田駅",
      stationWalkMin: 3,
      station: prox("新田", 18),
    };
    const part = scoreListing(listing, DEFAULT_CONFIG).parts.find((p) => p.key === "station");
    expect(part?.value).toBe(3);
  });

  it("falls back to the coordinate estimate when 徒歩分 is missing", () => {
    const listing: EnrichedListing = { ...baseListing, station: prox("Soka", 10) };
    const part = scoreListing(listing, DEFAULT_CONFIG).parts.find((p) => p.key === "station");
    expect(part?.value).toBe(10);
    expect(part?.score).toBe(50);
    expect(part?.detail).toBe("Soka");
  });

  it("honours the includeHoikuen toggle for the kindergarten parameter", () => {
    const listing: EnrichedListing = { ...baseListing, childcareAny: prox("Hoikuen", 5) };
    const off = scoreListing(listing, DEFAULT_CONFIG).parts.find((p) => p.key === "kindergarten");
    expect(off?.score).toBeNull();

    const on = scoreListing(listing, { ...DEFAULT_CONFIG, includeHoikuen: true }).parts.find(
      (p) => p.key === "kindergarten",
    );
    expect(on?.score).toBe(walkScore(5, DEFAULT_CONFIG.walkZeroMinutes.kindergarten));
    expect(on?.detail).toBe("Hoikuen");
  });

  it("recomputes walk scores live from the walk-speed and detour knobs", () => {
    const listing: EnrichedListing = { ...baseListing, poi1: prox("Al Sanad", 6) };
    const at = (config: ScoringConfig) =>
      scoreListing(listing, config).parts.find((p) => p.key === "poi1");

    // Default knobs reproduce 6 min → walkScore(6, 12) = 50.
    expect(at(DEFAULT_CONFIG)?.value).toBeCloseTo(6, 6);
    expect(at(DEFAULT_CONFIG)?.score).toBeCloseTo(50, 6);

    // Halving the walk speed doubles the minutes → 12 min → score 0.
    const slow = { ...DEFAULT_CONFIG, walkSpeedMPerMin: 40 };
    expect(at(slow)?.value).toBeCloseTo(12, 6);
    expect(at(slow)?.score).toBeCloseTo(0, 6);

    // A bigger detour factor also lengthens the walk.
    const winding = { ...DEFAULT_CONFIG, detourFactor: 2.6 };
    expect(at(winding)?.value).toBeCloseTo(12, 6);
    expect(at(winding)?.score).toBeCloseTo(0, 6);
  });

  it("scores distances faster in bicycle mode", () => {
    // 30 min on foot (2,400 m walk-equivalent → ~1,846 m straight line).
    const listing: EnrichedListing = { ...baseListing, poi1: prox("Al Sanad", 30) };
    const walk = scoreListing(listing, DEFAULT_CONFIG).parts.find((p) => p.key === "poi1");
    expect(walk?.value).toBeCloseTo(30, 4);
    expect(walk?.score).toBe(0); // beyond the 12-min anchor

    // At 250 m/min the same trip is ~9.6 min → inside the anchor, so it scores.
    const bike = scoreListing(
      { ...listing },
      { ...DEFAULT_CONFIG, travelMode: "bicycle" },
    ).parts.find((p) => p.key === "poi1");
    expect(bike?.value).toBeCloseTo(30 * (80 / 250), 1);
    expect(bike?.score).toBeGreaterThan(0);
  });

  it("rescales the advertised 徒歩分 when cycling", () => {
    const listing: EnrichedListing = { ...baseListing, stationWalkMin: 20 };
    const walk = scoreListing(listing, DEFAULT_CONFIG).parts.find((p) => p.key === "station");
    expect(walk?.value).toBe(20);

    const bike = scoreListing(listing, {
      ...DEFAULT_CONFIG,
      travelMode: "bicycle",
    }).parts.find((p) => p.key === "station");
    // 20 min walking ≈ 6.4 min cycling at 250 vs 80 m/min.
    expect(bike?.value).toBeCloseTo(6.4, 1);
    expect(bike?.score).toBeGreaterThan(walk?.score ?? 0);
  });

  it("ignores zero-weighted parameters in the total", () => {
    const config: ScoringConfig = {
      ...DEFAULT_CONFIG,
      weights: { ...DEFAULT_CONFIG.weights, station: 0, moveInCost: 0 },
    };
    const listing: EnrichedListing = {
      ...baseListing,
      rent: 50_000,
      sizeM2: null,
      builtYear: null,
      stationWalkMin: 20,
    };
    expect(scoreListing(listing, config).total).toBe(100); // rent only
  });
});
