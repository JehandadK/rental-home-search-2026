/**
 * The scoring engine. Pure functions: a listing plus a config goes in,
 * a per-parameter breakdown and weighted total come out. No I/O, no React —
 * this module is the testable heart of the tool.
 */
import { FEATURE_PARAMETERS, travelSpeed, type ScoringConfig } from "./scoringConfig";
import type { EnrichedListing, Proximity, ScoringCriterionKey } from "./types";
import { featureState } from "./listingAttributes";
import { estimateWalkMinutes, round1 } from "./geo";
import {
  computeMoveInCosts,
  effectiveMonthlyCost,
  parkingMonthlyYen,
  sunkCostInMonths,
} from "./moveInCost";

/** One parameter's contribution to the total. */
export interface ScorePart {
  key: ScoringCriterionKey;
  /** The measured value in its natural unit (¥, ㎡, years, minutes). */
  value: number | null;
  /** Normalised 0–100; null when the underlying data is missing. */
  score: number | null;
  weight: number;
  /** Extra context for display, e.g. the name of the nearest place. */
  detail?: string;
}

export interface ListingScore {
  /** Weighted average of available parts, 0–100. Null if nothing is scoreable. */
  total: number | null;
  parts: ScorePart[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Map a value onto 0–100 where lower raw values are better. */
export function lowerIsBetter(value: number, fullAtOrBelow: number, zeroAtOrAbove: number): number {
  return clamp((100 * (zeroAtOrAbove - value)) / (zeroAtOrAbove - fullAtOrBelow), 0, 100);
}

/** Map a value onto 0–100 where higher raw values are better. */
export function higherIsBetter(value: number, fullAtOrAbove: number, zeroAtOrBelow: number): number {
  return clamp((100 * (value - zeroAtOrBelow)) / (fullAtOrAbove - zeroAtOrBelow), 0, 100);
}

/** Walking-time score: 0 minutes → 100, `zeroAtMin` minutes → 0. */
export function walkScore(walkMin: number, zeroAtMin: number): number {
  return lowerIsBetter(walkMin, 0, zeroAtMin);
}

/**
 * Travel minutes for a proximity, recomputed live from its straight-line
 * distance using the config's travel mode, speed and detour knobs. This is
 * what lets the panel's mode/speed/detour controls change the scores without
 * re-running the enrichment pipeline.
 */
function travelMinutesOf(prox: Proximity | undefined, config: ScoringConfig): number | null {
  if (!prox) return null;
  return round1(estimateWalkMinutes(prox.distM, travelSpeed(config), config.detourFactor));
}

const CURRENT_YEAR = new Date().getFullYear();

/**
 * The station time prefers the agent-listed 徒歩分 (a real measured route)
 * over the coordinate estimate — but only when the advertised station is the
 * one being measured. If the dashboard has narrowed the station set to a
 * different station, the advertised figure describes the wrong walk and the
 * coordinate estimate is the honest answer.
 */
function effectiveStationMinutes(listing: EnrichedListing, config: ScoringConfig): number | null {
  // Only distrust the advertised figure when we can *prove* it describes a
  // different station than the one now being measured. If the ad's station
  // is unknown, the measured route is still the best evidence we have.
  const advertisedMismatch =
    listing.advertisedStation != null &&
    listing.station?.name != null &&
    listing.advertisedStation.replace(/駅$/, "") !== listing.station.name;

  if (listing.stationWalkMin != null && !advertisedMismatch) {
    // The advertised 徒歩分 is a walking figure; rescale it when cycling so
    // every parameter is expressed in the same travel mode.
    const ratio = config.walkSpeedMPerMin / travelSpeed(config);
    return round1(listing.stationWalkMin * ratio);
  }
  return travelMinutesOf(listing.station, config);
}

/** Building age in years; null when the construction year is unknown. */
function buildingAge(listing: EnrichedListing): number | null {
  return listing.builtYear != null ? CURRENT_YEAR - listing.builtYear : null;
}

/** Score every parameter of one listing. */
export function scoreListing(listing: EnrichedListing, config: ScoringConfig): ListingScore {
  const { weights, walkZeroMinutes: zero } = config;
  const age = buildingAge(listing);
  const childcare = config.includeHoikuen ? listing.childcareAny : listing.kindergarten;
  const stationMin = effectiveStationMinutes(listing, config);
  const poi1Min = travelMinutesOf(listing.poi1, config);
  const poi2Min = travelMinutesOf(listing.poi2, config);
  const busMin = travelMinutesOf(listing.busStop, config);
  const childcareMin = travelMinutesOf(childcare, config);
  const schoolMin = travelMinutesOf(listing.school, config);

  const moveIn = computeMoveInCosts(listing, config.moveIn);
  const sunkMonths = round1(sunkCostInMonths(moveIn, listing.rent));

  const monthly = effectiveMonthlyCost(listing, config.includeParking);
  const parking = parkingMonthlyYen(listing);
  const rentPerM2 = listing.sizeM2 != null && listing.sizeM2 > 0
    ? Math.round(monthly / listing.sizeM2)
    : null;

  const parts: ScorePart[] = [
    {
      key: "rent",
      value: monthly,
      score: lowerIsBetter(monthly, config.rentFullScoreBelow, config.rentZeroScoreAbove),
      weight: weights.rent,
      detail:
        config.includeParking && parking
          ? `¥${listing.rent.toLocaleString()} rent + ¥${parking.toLocaleString()} parking`
          : undefined,
    },
    {
      key: "rentPerM2",
      value: rentPerM2,
      score: rentPerM2 != null
        ? lowerIsBetter(
            rentPerM2,
            config.rentPerM2FullScoreBelow,
            config.rentPerM2ZeroScoreAbove,
          )
        : null,
      weight: weights.rentPerM2,
      detail: listing.sizeM2 != null
        ? `¥${monthly.toLocaleString()} ÷ ${listing.sizeM2}㎡ exclusive area`
        : undefined,
    },
    {
      key: "moveInCost",
      value: sunkMonths,
      score: lowerIsBetter(
        sunkMonths,
        config.moveInFullScoreBelowMonths,
        config.moveInZeroScoreAboveMonths,
      ),
      weight: weights.moveInCost,
      detail:
        `¥${moveIn.sunkCost.toLocaleString()} sunk of ` +
        `¥${moveIn.totalUpfront.toLocaleString()} upfront` +
        (moveIn.estimated.keyMoney || moveIn.estimated.deposit ? " (est.)" : ""),
    },
    {
      key: "size",
      value: listing.sizeM2,
      score: listing.sizeM2 != null
        ? higherIsBetter(listing.sizeM2, config.sizeFullScoreAbove, config.sizeZeroScoreBelow)
        : null,
      weight: weights.size,
    },
    {
      key: "yearBuilt",
      value: age,
      score: age != null ? lowerIsBetter(age, 0, config.buildingAgeZeroAt) : null,
      weight: weights.yearBuilt,
    },
    {
      key: "poi1",
      value: poi1Min,
      score: poi1Min != null ? walkScore(poi1Min, zero.poi1) : null,
      weight: weights.poi1,
      detail: listing.poi1?.name,
    },
    {
      key: "poi2",
      value: poi2Min,
      score: poi2Min != null ? walkScore(poi2Min, zero.poi2) : null,
      weight: weights.poi2,
      detail: listing.poi2?.name,
    },
    {
      key: "station",
      value: stationMin,
      score: stationMin != null ? walkScore(stationMin, zero.station) : null,
      weight: weights.station,
      detail: listing.station?.name,
    },
    {
      key: "busStop",
      value: busMin,
      score: busMin != null ? walkScore(busMin, zero.busStop) : null,
      weight: weights.busStop,
      detail: listing.busStop?.name,
    },
    {
      key: "kindergarten",
      value: childcareMin,
      score: childcareMin != null ? walkScore(childcareMin, zero.kindergarten) : null,
      weight: weights.kindergarten,
      detail: childcare?.name,
    },
    {
      key: "school",
      value: schoolMin,
      score: schoolMin != null ? walkScore(schoolMin, zero.school) : null,
      weight: weights.school,
      detail: listing.school?.name,
    },
  ];

  // Qualitative attributes are optional user-controlled criteria. Unknown is
  // deliberately null: a portal's silence must never be interpreted as "no".
  for (const meta of FEATURE_PARAMETERS) {
    const state = featureState(listing, meta.key);
    const preference = config.featurePreferences[meta.key];
    parts.push({
      key: meta.key,
      value: state == null ? null : state ? 1 : 0,
      score: state == null ? null : (state === (preference === "prefer") ? 100 : 0),
      weight: config.featureWeights[meta.key],
      detail: state == null ? "Not stated" : `${state ? "Yes" : "No"} · ${meta.labelJa}`,
    });
  }

  const scoreable = parts.filter(
    (p): p is ScorePart & { score: number } => p.score != null && p.weight > 0,
  );
  const totalWeight = scoreable.reduce((sum, p) => sum + p.weight, 0);
  const total = totalWeight > 0
    ? scoreable.reduce((sum, p) => sum + p.score * p.weight, 0) / totalWeight
    : null;

  return { total, parts };
}

/** Colour scale for scores: red (poor) → amber → green (excellent). */
export function scoreColor(total: number | null): string {
  if (total == null) return "#9ca3af";
  const hue = clamp(total, 0, 100) * 1.2; // 0=red, 120=green
  return `hsl(${hue}, 70%, 42%)`;
}
