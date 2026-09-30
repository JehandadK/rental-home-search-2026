/**
 * Scoring-config state, persisted through the user-state store so a tuned
 * weighting scheme survives page reloads.
 */
import { useCallback } from "react";
import { DEFAULT_CONFIG, type ScoringConfig } from "../../domain/scoringConfig";
import type { ListingFeatureKey, ScoreParameterKey } from "../../domain/types";
import { decodeScoringConfig } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

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

export function useScoringConfig() {
  const [config, setConfig] = usePersistentState<ScoringConfig>(USER_STATE_KEYS.scoringConfig, decodeScoringConfig);

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
