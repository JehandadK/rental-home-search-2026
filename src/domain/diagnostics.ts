/**
 * Scoring diagnostics: does each parameter actually help you choose?
 *
 * A parameter whose score is the same for (almost) every listing carries
 * weight but conveys no information — it silently inflates the relative
 * influence of the others. The classic case here is a POI anchor set far
 * outside the data range: 98% of listings score 0, so a heavily weighted
 * criterion decides nothing.
 *
 * These helpers detect that situation and propose anchors fitted to the
 * data actually on screen.
 */
import type { ScoreParameterKey } from "./types";
import type { ScoredRow } from "../web/lib/export";

/** Share of listings at the floor/ceiling above which a parameter is "dead". */
const DEAD_SHARE = 0.9;

export type DiagnosisKind = "ok" | "allZero" | "allFull" | "noData";

export interface ParameterDiagnosis {
  key: ScoreParameterKey;
  kind: DiagnosisKind;
  /** Fraction of scored listings sitting at 0 and at 100. */
  zeroShare: number;
  fullShare: number;
  /** Spread of the raw measured values, used to propose anchors. */
  sampleCount: number;
  /** Suggested anchor fitted to the data (unit depends on the parameter). */
  suggestedAnchor: number | null;
  /** Human-readable explanation for the UI. */
  message: string;
}

const percentile = (sorted: number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)))];

/**
 * Diagnose one parameter over the currently visible listings.
 * `suggestedAnchor` is the p75 of observed values — far enough out that most
 * listings differentiate, close enough to stay meaningful.
 */
export function diagnoseParameter(
  key: ScoreParameterKey,
  rows: readonly ScoredRow[],
): ParameterDiagnosis {
  const parts = rows
    .map((r) => r.score.parts.find((p) => p.key === key))
    .filter((p): p is NonNullable<typeof p> => p != null);
  const scores = parts.map((p) => p.score).filter((s): s is number => s != null);
  const values = parts
    .map((p) => p.value)
    .filter((v): v is number => v != null && Number.isFinite(v))
    .sort((a, b) => a - b);

  const base = { key, zeroShare: 0, fullShare: 0, sampleCount: values.length };

  if (scores.length === 0) {
    return { ...base, kind: "noData", suggestedAnchor: null, message: "No data for this parameter." };
  }

  const zeroShare = scores.filter((s) => s < 0.5).length / scores.length;
  const fullShare = scores.filter((s) => s > 99.5).length / scores.length;
  const suggestedAnchor = values.length > 0 ? Math.ceil(percentile(values, 0.75)) : null;

  if (zeroShare >= DEAD_SHARE) {
    return {
      ...base,
      zeroShare,
      fullShare,
      kind: "allZero",
      suggestedAnchor,
      message:
        `${pct(zeroShare)} of listings score 0 — this criterion is not ` +
        `separating anything, yet it still takes up weight.`,
    };
  }

  if (fullShare >= DEAD_SHARE) {
    return {
      ...base,
      zeroShare,
      fullShare,
      kind: "allFull",
      suggestedAnchor,
      message:
        `${pct(fullShare)} of listings score 100 — this criterion is not ` +
        `separating anything, yet it still takes up weight.`,
    };
  }

  return { ...base, zeroShare, fullShare, kind: "ok", suggestedAnchor, message: "" };
}

/** Diagnose every parameter that currently carries weight. */
export function diagnoseAll(
  keys: readonly ScoreParameterKey[],
  rows: readonly ScoredRow[],
  weights: Record<ScoreParameterKey, number>,
): ParameterDiagnosis[] {
  return keys
    .filter((key) => weights[key] > 0)
    .map((key) => diagnoseParameter(key, rows))
    .filter((d) => d.kind !== "ok");
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
