import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./scoringConfig";
import {
  applyPreset,
  BUILT_IN_PRESETS,
  matchesPreset,
  presetFromConfig,
  withSavedPreset,
} from "./weightPresets";

const commuter = BUILT_IN_PRESETS.find((preset) => preset.id === "commuter")!;

describe("weight presets", () => {
  it("changes only the weights, keeping anchors and the user's feature weights", () => {
    const tuned = {
      ...DEFAULT_CONFIG,
      rentZeroScoreAbove: 120_000,
      featureWeights: { ...DEFAULT_CONFIG.featureWeights, petAllowed: 9 },
    };
    const applied = applyPreset(tuned, commuter);
    expect(applied.weights).toEqual(commuter.weights);
    expect(applied.rentZeroScoreAbove).toBe(120_000);
    expect(applied.featureWeights.petAllowed).toBe(9);
    expect(matchesPreset(applied, commuter)).toBe(true);
    expect(matchesPreset(applied, BUILT_IN_PRESETS[0])).toBe(false);
  });

  it("restores feature weights and preferences from a saved preset", () => {
    const tuned = {
      ...DEFAULT_CONFIG,
      featureWeights: { ...DEFAULT_CONFIG.featureWeights, cityGas: 5 },
      featurePreferences: { ...DEFAULT_CONFIG.featurePreferences, elevator: "avoid" as const },
    };
    const saved = presetFromConfig(tuned, "Mine", "custom:1");
    const restored = applyPreset(DEFAULT_CONFIG, saved);
    expect(restored.featureWeights.cityGas).toBe(5);
    expect(restored.featurePreferences.elevator).toBe("avoid");
    expect(matchesPreset(DEFAULT_CONFIG, saved)).toBe(false);
    expect(matchesPreset(restored, saved)).toBe(true);
  });

  it("overwrites a saved preset of the same name in place", () => {
    const first = presetFromConfig(DEFAULT_CONFIG, "Mine", "custom:1");
    const other = presetFromConfig(DEFAULT_CONFIG, "Other", "custom:2");
    const again = presetFromConfig(applyPreset(DEFAULT_CONFIG, commuter), " mine ", "custom:3");
    const saved = withSavedPreset([first, other], again);
    expect(saved.map((preset) => preset.id)).toEqual(["custom:1", "custom:2"]);
    expect(saved[0].weights).toEqual(commuter.weights);
  });
});
