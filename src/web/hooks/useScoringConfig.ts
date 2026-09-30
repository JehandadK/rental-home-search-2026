/**
 * Scoring-config state with localStorage persistence, so a tuned
 * weighting scheme survives page reloads.
 */
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_CONFIG,
  DEFAULT_FEATURE_PREFERENCES,
  DEFAULT_FEATURE_WEIGHTS,
  type ScoringConfig,
} from "../../config/scoring";
import type { ListingFeatureKey, ScoreParameterKey } from "../../types";

const STORAGE_KEY = "soka-scorer-config-v1";

export function withAllWeightsZero(config: ScoringConfig): ScoringConfig {
  return {
    ...config,
    weights: Object.fromEntries(
      Object.keys(config.weights).map((key) => [key, 0]),
    ) as typeof config.weights,
    featureWeights: Object.fromEntries(
      Object.keys(config.featureWeights).map((key) => [key, 0]),
    ) as typeof config.featureWeights,
  };
}

function loadConfig(): ScoringConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<ScoringConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        weights: { ...DEFAULT_CONFIG.weights, ...parsed.weights },
        featureWeights: { ...DEFAULT_FEATURE_WEIGHTS, ...parsed.featureWeights },
        featurePreferences: { ...DEFAULT_FEATURE_PREFERENCES, ...parsed.featurePreferences },
        walkZeroMinutes: { ...DEFAULT_CONFIG.walkZeroMinutes, ...parsed.walkZeroMinutes },
        moveIn: { ...DEFAULT_CONFIG.moveIn, ...parsed.moveIn },
      };
    }
  } catch {
    // Corrupt or unavailable storage: fall back to defaults.
  }
  return DEFAULT_CONFIG;
}

export function useScoringConfig() {
  const [config, setConfig] = useState<ScoringConfig>(loadConfig);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const setWeight = useCallback((key: ScoreParameterKey, weight: number) => {
    setConfig((c) => ({ ...c, weights: { ...c.weights, [key]: weight } }));
  }, []);

  const setFeatureWeight = useCallback((key: ListingFeatureKey, weight: number) => {
    setConfig((c) => ({ ...c, featureWeights: { ...c.featureWeights, [key]: weight } }));
  }, []);

  const setFeaturePreference = useCallback(
    (key: ListingFeatureKey, preference: "prefer" | "avoid") => {
      setConfig((c) => ({
        ...c,
        featurePreferences: { ...c.featurePreferences, [key]: preference },
      }));
    },
    [],
  );

  const update = useCallback((patch: Partial<ScoringConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  const setWalkZero = useCallback(
    (key: keyof ScoringConfig["walkZeroMinutes"], minutes: number) => {
      setConfig((c) => ({ ...c, walkZeroMinutes: { ...c.walkZeroMinutes, [key]: minutes } }));
    },
    [],
  );

  /** Disable every numeric and qualitative scoring criterion in one action. */
  const zeroAllWeights = useCallback(() => {
    setConfig(withAllWeightsZero);
  }, []);

  const reset = useCallback(() => setConfig(DEFAULT_CONFIG), []);

  return {
    config,
    setWeight,
    setFeatureWeight,
    setFeaturePreference,
    update,
    setWalkZero,
    zeroAllWeights,
    reset,
  };
}
