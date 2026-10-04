/**
 * Weight presets: one-click ways of looking at the market. A preset changes
 * only the weights — anchors, travel mode and move-in assumptions stay as the
 * user tuned them, so flipping between presets compares priorities, not
 * thresholds.
 *
 * Built-in presets set the numeric criteria and leave the property-feature
 * weights alone. A preset the user saves captures the feature weights and
 * preferences too, since those are part of the scheme they are saving.
 */
import { DEFAULT_CONFIG, type ScoringConfig } from "./scoringConfig";
import type { FeaturePreferences, FeatureWeights, ParameterWeights } from "./types";

export interface WeightPreset {
  id: string;
  label: string;
  /** One line on what the preset optimises for. */
  description: string;
  weights: ParameterWeights;
  /** Absent on built-ins: applying one keeps the current feature weights. */
  featureWeights?: FeatureWeights;
  featurePreferences?: FeaturePreferences;
  /** True for presets the user saved (and may delete). */
  custom?: boolean;
}

export const BUILT_IN_PRESETS: readonly WeightPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "The default weights",
    weights: DEFAULT_CONFIG.weights,
  },
  {
    id: "school-run",
    label: "School-run family",
    description: "Al Sanad, schools and kindergartens close by, with room for the kids",
    weights: {
      rent: 6, rentPerM2: 6, moveInCost: 3, size: 8, yearBuilt: 2,
      poi1: 15, poi2: 8, station: 4, busStop: 2, kindergarten: 10, school: 10,
    },
  },
  {
    id: "commuter",
    label: "Commuter",
    description: "A short walk to the station and a bus stop",
    weights: {
      rent: 7, rentPerM2: 6, moveInCost: 4, size: 3, yearBuilt: 4,
      poi1: 3, poi2: 5, station: 16, busStop: 6, kindergarten: 1, school: 1,
    },
  },
  {
    id: "cheapest",
    label: "Cheapest viable",
    description: "Lowest rent and the least money lost moving in",
    weights: {
      rent: 16, rentPerM2: 4, moveInCost: 12, size: 2, yearBuilt: 1,
      poi1: 5, poi2: 4, station: 4, busStop: 2, kindergarten: 2, school: 2,
    },
  },
  {
    id: "space",
    label: "Most space for the money",
    description: "Large homes that are cheap for their floor area",
    weights: {
      rent: 4, rentPerM2: 16, moveInCost: 4, size: 14, yearBuilt: 2,
      poi1: 5, poi2: 4, station: 4, busStop: 2, kindergarten: 3, school: 3,
    },
  },
];

/** The config with a preset's weights applied; everything else is untouched. */
export function applyPreset(config: ScoringConfig, preset: WeightPreset): ScoringConfig {
  return {
    ...config,
    weights: { ...preset.weights },
    featureWeights: preset.featureWeights ? { ...preset.featureWeights } : config.featureWeights,
    featurePreferences: preset.featurePreferences ? { ...preset.featurePreferences } : config.featurePreferences,
  };
}

/** True when applying the preset would change nothing. */
export function matchesPreset(config: ScoringConfig, preset: WeightPreset): boolean {
  return sameValues(config.weights, preset.weights)
    && (!preset.featureWeights || sameValues(config.featureWeights, preset.featureWeights))
    && (!preset.featurePreferences || sameValues(config.featurePreferences, preset.featurePreferences));
}

/** Capture the current weights as a user preset. */
export function presetFromConfig(config: ScoringConfig, label: string, id: string): WeightPreset {
  return {
    id,
    label,
    description: "Saved by you",
    weights: { ...config.weights },
    featureWeights: { ...config.featureWeights },
    featurePreferences: { ...config.featurePreferences },
    custom: true,
  };
}

/**
 * Add a saved preset. Saving under a name that is already taken replaces
 * that preset, keeping its place in the list.
 */
export function withSavedPreset(presets: readonly WeightPreset[], preset: WeightPreset): WeightPreset[] {
  const label = preset.label.trim().toLowerCase();
  const index = presets.findIndex((existing) => existing.label.trim().toLowerCase() === label);
  if (index < 0) return [...presets, preset];
  return presets.map((existing, i) => (i === index ? { ...preset, id: existing.id } : existing));
}

/**
 * Compared over the preset's keys only, so a stale key left in a stored
 * config (a since-renamed criterion) cannot stop a preset from matching.
 */
function sameValues<T extends object>(config: T, preset: T): boolean {
  return (Object.keys(preset) as (keyof T)[]).every((key) => config[key] === preset[key]);
}
