/**
 * Why a home scored what it did, in terms a caller can act on.
 *
 * The breakdown splits the weighted total into each criterion's points, so
 * the contributions add up to the total. Reasons are the criteria that earned
 * the most points; concerns are the ones that cost the most. Each item names
 * the request path that changes its weight, which is the knob to turn.
 */
import { scoreCoverage, type ListingScore, type ScorePart } from "../scoring";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS, type ScoringConfig } from "../scoringConfig";
import type { ScoringCriterionKey } from "../types";
import { PARAMETER_LABELS_JA } from "./criteriaSchema";

export interface BreakdownItem {
  key: ScoringCriterionKey;
  label: string;
  labelJa: string;
  unit: string;
  /** In the criterion's unit: ¥, ㎡, years, minutes; 1/0 for a feature's Yes/No. */
  value: number | null;
  /** 0–100; null when the home has no data for it. */
  score: number | null;
  weight: number;
  /** Points this criterion adds to the total; the contributions sum to the total. */
  contribution: number | null;
  /** Points it cost: what a perfect score here would have added on top. */
  lost: number | null;
  detail?: string;
  /** The request path that changes this criterion's weight. */
  set: string;
}

export interface ScoreExplanation {
  /** Weighted criteria, most points first; every criterion when `all` is set. */
  breakdown: BreakdownItem[];
  /** The criteria that earned the most, as sentences. */
  reasons: string[];
  /** The criteria that cost the most, as sentences. */
  concerns: string[];
  /** Weighted criteria this home has no data for; their weight was left out of its average. */
  gaps: ScoringCriterionKey[];
}

const MAX_SENTENCES = 3;
const REASON_MIN_SCORE = 60;
const CONCERN_MAX_SCORE = 40;

interface Meta {
  label: string;
  labelJa: string;
  unit: string;
  set: string;
  feature: boolean;
}

const META = new Map<ScoringCriterionKey, Meta>([
  ...SCORE_PARAMETERS.map((meta): [ScoringCriterionKey, Meta] => [meta.key, {
    label: meta.label, labelJa: PARAMETER_LABELS_JA[meta.key], unit: meta.unit, set: `weights.${meta.key}`, feature: false,
  }]),
  ...FEATURE_PARAMETERS.map((meta): [ScoringCriterionKey, Meta] => [meta.key, {
    label: meta.label, labelJa: meta.labelJa, unit: meta.unit, set: `features.${meta.key}.weight`, feature: true,
  }]),
]);

/** What each distance criterion measures to, for sentences. */
const DESTINATIONS: Partial<Record<ScoringCriterionKey, string>> = {
  poi1: "private school",
  poi2: "mosque",
  carAuction: "car auction",
  station: "station",
  busStop: "bus stop",
  kindergarten: "kindergarten",
  school: "elementary school",
};

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
const yen = (n: number) => `¥${Math.round(n).toLocaleString("en-US")}`;

export function explainScore(score: ListingScore, config: ScoringConfig, options: { all?: boolean } = {}): ScoreExplanation {
  const counted = score.parts.filter((part) => part.score != null && part.weight > 0);
  const totalWeight = counted.reduce((sum, part) => sum + part.weight, 0);
  const share = (part: ScorePart, points: (score: number) => number) =>
    part.score != null && part.weight > 0 && totalWeight > 0 ? round((points(part.score) * part.weight) / totalWeight, 2) : null;

  const items = score.parts
    .filter((part) => options.all || part.weight > 0)
    .map((part): BreakdownItem => {
      const meta = META.get(part.key)!;
      return {
        key: part.key,
        label: meta.label,
        labelJa: meta.labelJa,
        unit: meta.unit,
        value: part.value,
        score: part.score == null ? null : round(part.score),
        weight: part.weight,
        contribution: share(part, (s) => s),
        lost: share(part, (s) => 100 - s),
        ...(part.detail ? { detail: part.detail } : {}),
        set: meta.set,
      };
    })
    .sort((a, b) => (b.contribution ?? -1) - (a.contribution ?? -1) || b.weight - a.weight);

  const reasons = items
    .filter((item) => item.contribution != null && item.score! >= REASON_MIN_SCORE)
    .slice(0, MAX_SENTENCES)
    .map((item) => `${describe(item, config)} (scores ${Math.round(item.score!)}/100, weight ${item.weight})`);
  const concerns = items
    .filter((item) => item.lost != null && item.score! <= CONCERN_MAX_SCORE)
    .sort((a, b) => (b.lost ?? 0) - (a.lost ?? 0))
    .slice(0, MAX_SENTENCES)
    .map((item) => `${describe(item, config)} (scores ${Math.round(item.score!)}/100, weight ${item.weight})`);

  return { breakdown: items, reasons, concerns, gaps: scoreCoverage(score).missing };
}

/** One criterion's measured value, as a short phrase. */
export function describe(item: Pick<BreakdownItem, "key" | "label" | "value" | "detail">, config: ScoringConfig): string {
  const { key, value, detail } = item;
  if (value == null) return `${item.label}: not stated`;
  const meta = META.get(key);
  if (meta?.feature) return `${item.label}: ${value === 1 ? "yes" : "no"}`;
  const destination = key === "kindergarten" && config.includeHoikuen ? "kindergarten or daycare" : DESTINATIONS[key];
  if (destination) {
    const how = config.travelMode === "bicycle" ? "by bicycle" : "walk";
    return detail
      ? `${round(value)} min ${how} to ${detail}, the nearest ${destination}`
      : `${round(value)} min ${how} to the nearest ${destination}`;
  }
  switch (key) {
    case "rent":
      return `${yen(value)}/mo${detail ? ` (${detail})` : ""}`;
    case "rentPerM2":
      return `${yen(value)} per ㎡ per month`;
    case "moveInCost":
      return `${round(value)} months of rent lost moving in`;
    case "size":
      return `${round(value)} ㎡`;
    case "yearBuilt":
      return `${Math.round(value)} years old`;
    default:
      return `${item.label}: ${value}`;
  }
}
