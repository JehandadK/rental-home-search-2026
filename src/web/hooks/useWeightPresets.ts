/**
 * The weight presets: the built-ins plus any the user saved, which are
 * persisted through the user-state store.
 */
import { useCallback, useMemo } from "react";
import type { ScoringConfig } from "../../domain/scoringConfig";
import {
  BUILT_IN_PRESETS,
  presetFromConfig,
  withSavedPreset,
  type WeightPreset,
} from "../../domain/weightPresets";
import { decodeWeightPresets } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useWeightPresets() {
  const [saved, setSaved] = usePersistentState<WeightPreset[]>(USER_STATE_KEYS.weightPresets, decodeWeightPresets);

  const presets = useMemo(() => [...BUILT_IN_PRESETS, ...saved], [saved]);

  /** Save the current weights under a name; an existing name is overwritten. */
  const savePreset = useCallback((config: ScoringConfig, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    // Two chips named "Commuter" would be indistinguishable.
    const clashes = BUILT_IN_PRESETS.some((preset) => preset.label.toLowerCase() === trimmed.toLowerCase());
    const name = clashes ? `${trimmed} (mine)` : trimmed;
    setSaved((current) => withSavedPreset(current, presetFromConfig(config, name, `custom:${Date.now()}`)));
  }, [setSaved]);

  const deletePreset = useCallback((id: string) => {
    setSaved((current) => current.filter((preset) => preset.id !== id));
  }, [setSaved]);

  return { presets, savePreset, deletePreset };
}
