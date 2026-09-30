import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../domain/scoringConfig";
import { withAllWeightsZero } from "./useScoringConfig";

describe("withAllWeightsZero", () => {
  it("sets numeric and property-feature weights to zero without changing preferences", () => {
    const result = withAllWeightsZero(DEFAULT_CONFIG);
    expect(Object.values(result.weights).every((weight) => weight === 0)).toBe(true);
    expect(Object.values(result.featureWeights).every((weight) => weight === 0)).toBe(true);
    expect(result.featurePreferences).toEqual(DEFAULT_CONFIG.featurePreferences);
    expect(result.travelMode).toBe(DEFAULT_CONFIG.travelMode);
  });

  it("does not mutate the defaults", () => {
    withAllWeightsZero(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.weights.rent).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.weights.rentPerM2).toBeGreaterThan(0);
  });
});
