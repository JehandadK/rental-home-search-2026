/**
 * Every criterion a caller can set, described once.
 *
 * Each field is a dotted request path ("weights.station", "filters.rentMax")
 * with its labels, unit, type and range, and how to read and write it on a
 * resolved `Criteria`. The request decoder, the query-string form, the
 * self-describing catalogue, the canonical request echo and the JSON Schema
 * all come from this one list, so they cannot disagree.
 */
import type { AvailabilityMap } from "../availability";
import { EMPTY_FILTERS, type ListingFilters } from "../filters";
import { MAX_NEW_WINDOW_DAYS, MIN_NEW_WINDOW_DAYS } from "../lifecycle";
import { MARK_FILTERS, LISTING_MARKS, type MarkMap } from "../marks";
import { DISTANCE_PARAMETERS, PARAMETER_SOURCES, type DistanceParameterKey } from "../places";
import { defaultSelection, type PlaceSelection } from "../placeSelection";
import type { DuplicateDecision } from "../possibleDuplicates";
import {
  DEFAULT_CONFIG,
  FEATURE_PARAMETERS,
  SCORE_PARAMETERS,
  type ScoringConfig,
} from "../scoringConfig";
import type { ListingFeatureKey, ScoreParameterKey, ScoringCriterionKey } from "../types";
import { BUILT_IN_PRESETS } from "../weightPresets";

/** What ranks first: the weighted total, or one criterion's 0–100 score. */
export type SortKey = "score" | ScoringCriterionKey;

/** One caller's complete, resolved criteria: defaults, then the preset, then the request. */
export interface Criteria {
  presetId: string | null;
  config: ScoringConfig;
  /** `filters.minScore` is exposed as `ranking.minScore`. */
  filters: ListingFilters;
  selection: PlaceSelection;
  ranking: {
    sortBy: SortKey;
    order: "desc" | "asc";
    /** Per criterion, the lowest 0–100 score a home may have; a home with no data for it fails. */
    minPartScores: Partial<Record<ScoringCriterionKey, number>>;
  };
  page: { limit: number; offset: number };
  view: "summary" | "full";
  /** Caller-held state, sent with each request and never stored. */
  state: {
    excludeKeys: string[];
    marks: MarkMap;
    duplicateDecisions: Record<string, DuplicateDecision>;
    availabilityMarks: AvailabilityMap;
  };
}

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 10;

export function defaultCriteria(): Criteria {
  return {
    presetId: null,
    config: structuredClone(DEFAULT_CONFIG),
    filters: structuredClone(EMPTY_FILTERS),
    selection: defaultSelection(),
    ranking: { sortBy: "score", order: "desc", minPartScores: {} },
    page: { limit: DEFAULT_PAGE_LIMIT, offset: 0 },
    view: "summary",
    state: { excludeKeys: [], marks: {}, duplicateDecisions: {}, availabilityMarks: {} },
  };
}

/** Values that come from the data rather than the code. */
export type DataValues = "cities" | "layouts" | "areas" | "agencies";

export type FieldType =
  | { kind: "number"; min: number; max: number; step?: number; integer?: boolean }
  /** A bound; null means unbounded. */
  | { kind: "nullableNumber"; min: number; max: number }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  /** An empty list means "any". `values` names where the allowed values come from. */
  | { kind: "stringList"; values?: DataValues }
  /** Place ids in one catalog category; null means every place in it. */
  | { kind: "placeIds"; category: string }
  /** Criterion key → lowest 0–100 score. */
  | { kind: "criterionScores" }
  | { kind: "markMap" }
  | { kind: "duplicateDecisions" }
  | { kind: "availabilityMarks" };

export type FieldGroup =
  | "preset" | "weights" | "features" | "anchors" | "travel" | "moveIn"
  | "places" | "filters" | "ranking" | "page" | "view" | "state";

export interface FieldSpec {
  path: string;
  group: FieldGroup;
  label: string;
  labelJa?: string;
  unit?: string;
  description: string;
  type: FieldType;
  read(criteria: Criteria): unknown;
  /** `value` has already been validated against `type`. */
  write(criteria: Criteria, value: unknown): void;
}

export const GROUP_DESCRIPTIONS: Record<FieldGroup, string> = {
  preset: "Start from a named set of weights; any field you also send overrides it",
  weights: "How much each numeric criterion counts (0 = ignore). Weights are relative: only their ratios matter",
  features: "Optional yes/no property features; weight 0 shows them without scoring. A home that does not say is skipped, never scored as No",
  anchors: "The values that score 100 and 0 for each numeric criterion",
  travel: "How distances become minutes, and what counts as monthly cost",
  moveIn: "What the move-in estimate assumes when an ad leaves a figure out",
  places: "Which places each distance criterion measures to (null = the nearest of every place in the category)",
  filters: "Hard filters applied before scoring",
  ranking: "Ordering and score cut-offs",
  page: "Paging through the ranked results",
  view: "How much detail each result carries",
  state: "Your own state, sent with each request and never stored",
};

const LOWER_IS_BETTER = new Set<ScoreParameterKey>([
  "rent", "rentPerM2", "moveInCost", "yearBuilt", "poi1", "poi2", "carAuction", "station", "busStop", "kindergarten", "school",
]);

/** "lower-is-better" for costs, age and travel times; "higher-is-better" for size. */
export const parameterDirection = (key: ScoreParameterKey): "lower-is-better" | "higher-is-better" =>
  LOWER_IS_BETTER.has(key) ? "lower-is-better" : "higher-is-better";

/** Japanese labels for the numeric criteria (features carry their own). */
export const PARAMETER_LABELS_JA: Record<ScoreParameterKey, string> = {
  rent: "家賃",
  rentPerM2: "㎡単価",
  moveInCost: "初期費用",
  size: "専有面積",
  yearBuilt: "築年数",
  poi1: "最寄りの私立学校",
  poi2: "最寄りのモスク",
  carAuction: "最寄りの自動車オークション会場",
  station: "最寄駅",
  busStop: "最寄りバス停",
  kindergarten: "最寄りの幼稚園",
  school: "最寄りの小学校",
};

/** The anchor fields of each numeric criterion: the value scoring 100, and the value scoring 0. */
export const PARAMETER_ANCHORS: Record<ScoreParameterKey, { full: string | number; zero: string }> = {
  rent: { full: "anchors.rentFullScoreBelow", zero: "anchors.rentZeroScoreAbove" },
  rentPerM2: { full: "anchors.rentPerM2FullScoreBelow", zero: "anchors.rentPerM2ZeroScoreAbove" },
  moveInCost: { full: "anchors.moveInFullScoreBelowMonths", zero: "anchors.moveInZeroScoreAboveMonths" },
  size: { full: "anchors.sizeFullScoreAbove", zero: "anchors.sizeZeroScoreBelow" },
  // A new building scores 100; the full-score end is fixed.
  yearBuilt: { full: 0, zero: "anchors.buildingAgeZeroAt" },
  // A doorstep scores 100; only the zero end moves.
  poi1: { full: 0, zero: "anchors.walkZeroMinutes.poi1" },
  poi2: { full: 0, zero: "anchors.walkZeroMinutes.poi2" },
  carAuction: { full: 0, zero: "anchors.walkZeroMinutes.carAuction" },
  station: { full: 0, zero: "anchors.walkZeroMinutes.station" },
  busStop: { full: 0, zero: "anchors.walkZeroMinutes.busStop" },
  kindergarten: { full: 0, zero: "anchors.walkZeroMinutes.kindergarten" },
  school: { full: 0, zero: "anchors.walkZeroMinutes.school" },
};

export const MAX_WEIGHT = 20;
const SCORE_KEYS: readonly ScoreParameterKey[] = SCORE_PARAMETERS.map((meta) => meta.key);
const FEATURE_KEYS: readonly ListingFeatureKey[] = FEATURE_PARAMETERS.map((meta) => meta.key);
export const CRITERION_KEYS: readonly ScoringCriterionKey[] = [...SCORE_KEYS, ...FEATURE_KEYS];

type ConfigNumberKey = {
  [K in keyof ScoringConfig]: ScoringConfig[K] extends number ? K : never;
}[keyof ScoringConfig];

function anchor(key: ConfigNumberKey, label: string, unit: string, description: string, max: number, min = 0): FieldSpec {
  return {
    path: `anchors.${key}`, group: "anchors", label, unit, description,
    type: { kind: "number", min, max },
    read: (c) => c.config[key],
    write: (c, v) => { (c.config[key] as number) = v as number; },
  };
}

function travel<K extends "walkSpeedMPerMin" | "bicycleSpeedMPerMin" | "detourFactor">(
  key: K, label: string, unit: string, description: string, min: number, max: number, step?: number,
): FieldSpec {
  return {
    path: `travel.${key}`, group: "travel", label, unit, description,
    type: { kind: "number", min, max, step },
    read: (c) => c.config[key],
    write: (c, v) => { c.config[key] = v as number; },
  };
}

type MoveInKey = keyof ScoringConfig["moveIn"];

function moveIn(key: MoveInKey, label: string, unit: string, description: string, type: FieldType): FieldSpec {
  return {
    path: `moveIn.${key}`, group: "moveIn", label, unit, description, type,
    read: (c) => c.config.moveIn[key],
    write: (c, v) => { (c.config.moveIn[key] as unknown) = v; },
  };
}

type FilterKey = Exclude<keyof ListingFilters, "minScore">;

function filter(key: FilterKey, label: string, description: string, type: FieldType, unit?: string): FieldSpec {
  return {
    path: `filters.${key}`, group: "filters", label, unit, description, type,
    read: (c) => c.filters[key],
    write: (c, v) => { (c.filters[key] as unknown) = v; },
  };
}

const enumOf = (values: readonly string[]): FieldType => ({ kind: "enum", values });
const AREA_MODES = ["include", "exclude"] as const;

export const FIELD_SPECS: readonly FieldSpec[] = [
  {
    path: "preset", group: "preset", label: "Preset",
    description: BUILT_IN_PRESETS.map((preset) => `${preset.id}: ${preset.description}`).join("; "),
    type: enumOf(BUILT_IN_PRESETS.map((preset) => preset.id)),
    read: (c) => c.presetId,
    write: (c, v) => { c.presetId = v as string; },
  },

  ...SCORE_PARAMETERS.map((meta): FieldSpec => ({
    path: `weights.${meta.key}`, group: "weights", label: meta.label, labelJa: PARAMETER_LABELS_JA[meta.key],
    unit: "weight", description: `${meta.description} (measured in ${meta.unit})`,
    type: { kind: "number", min: 0, max: MAX_WEIGHT },
    read: (c) => c.config.weights[meta.key],
    write: (c, v) => { c.config.weights[meta.key] = v as number; },
  })),

  ...FEATURE_PARAMETERS.flatMap((meta): FieldSpec[] => [
    {
      path: `features.${meta.key}.weight`, group: "features", label: meta.label, labelJa: meta.labelJa,
      unit: "weight", description: `${meta.description} (${meta.category})`,
      type: { kind: "number", min: 0, max: MAX_WEIGHT },
      read: (c) => c.config.featureWeights[meta.key],
      write: (c, v) => { c.config.featureWeights[meta.key] = v as number; },
    },
    {
      path: `features.${meta.key}.prefer`, group: "features", label: `${meta.label}: prefer or avoid`, labelJa: meta.labelJa,
      description: `"prefer" scores a Yes as 100; "avoid" scores a No as 100`,
      type: enumOf(["prefer", "avoid"]),
      read: (c) => c.config.featurePreferences[meta.key],
      write: (c, v) => { c.config.featurePreferences[meta.key] = v as "prefer" | "avoid"; },
    },
  ]),

  anchor("rentFullScoreBelow", "Rent scoring 100", "¥/mo", "Monthly cost at or below this scores 100", 2_000_000),
  anchor("rentZeroScoreAbove", "Rent scoring 0", "¥/mo", "Monthly cost at or above this scores 0", 2_000_000),
  anchor("rentPerM2FullScoreBelow", "Rent/㎡ scoring 100", "¥/㎡/mo", "Cost per exclusive ㎡ at or below this scores 100", 20_000),
  anchor("rentPerM2ZeroScoreAbove", "Rent/㎡ scoring 0", "¥/㎡/mo", "Cost per exclusive ㎡ at or above this scores 0", 20_000),
  anchor("moveInFullScoreBelowMonths", "Move-in scoring 100", "months of rent", "Sunk move-in cost at or below this scores 100", 24),
  anchor("moveInZeroScoreAboveMonths", "Move-in scoring 0", "months of rent", "Sunk move-in cost at or above this scores 0", 24),
  anchor("sizeFullScoreAbove", "Size scoring 100", "㎡", "Floor area at or above this scores 100", 500),
  anchor("sizeZeroScoreBelow", "Size scoring 0", "㎡", "Floor area at or below this scores 0", 500),
  anchor("buildingAgeZeroAt", "Age scoring 0", "years", "A building this old scores 0; a new one scores 100", 100, 1),
  ...DISTANCE_PARAMETERS.map((key): FieldSpec => {
    const meta = SCORE_PARAMETERS.find((parameter) => parameter.key === key)!;
    return {
      path: `anchors.walkZeroMinutes.${key}`, group: "anchors", label: `${meta.label} scoring 0`, unit: "min",
      description: `Travel minutes at which ${meta.label.toLowerCase()} scores 0; a doorstep scores 100`,
      type: { kind: "number", min: 1, max: 120 },
      read: (c) => c.config.walkZeroMinutes[key],
      write: (c, v) => { c.config.walkZeroMinutes[key] = v as number; },
    };
  }),

  {
    path: "travel.mode", group: "travel", label: "Travel mode",
    description: "How distances to places become minutes: on foot, or by bicycle (ママチャリ)",
    type: enumOf(["walk", "bicycle"]),
    read: (c) => c.config.travelMode,
    write: (c, v) => { c.config.travelMode = v as ScoringConfig["travelMode"]; },
  },
  travel("walkSpeedMPerMin", "Walking speed", "m/min", "Used when travel.mode is walk", 20, 200, 5),
  travel("bicycleSpeedMPerMin", "Cycling speed", "m/min", "Used when travel.mode is bicycle, door to door", 60, 600, 10),
  travel("detourFactor", "Detour factor", "×", "Straight-line distance × this ≈ the real route", 1, 3, 0.05),
  {
    path: "travel.includeParking", group: "travel", label: "Add parking to rent",
    description: "Count the monthly 駐車場 charge as rent, for a household with a car",
    type: { kind: "boolean" },
    read: (c) => c.config.includeParking,
    write: (c, v) => { c.config.includeParking = v as boolean; },
  },
  {
    path: "travel.includeHoikuen", group: "travel", label: "Count 保育園 as kindergarten",
    description: "Let daycares (保育園) count towards the kindergarten distance",
    type: { kind: "boolean" },
    read: (c) => c.config.includeHoikuen,
    write: (c, v) => { c.config.includeHoikuen = v as boolean; },
  },

  moveIn("defaultDepositMonths", "Deposit if unstated", "months", "敷金 assumed when an ad omits it", { kind: "number", min: 0, max: 12 }),
  moveIn("defaultKeyMoneyMonths", "Key money if unstated", "months", "礼金 assumed when an ad omits it", { kind: "number", min: 0, max: 12 }),
  moveIn("agencyFeeMonths", "Agency fee", "months", "仲介手数料 (1 month + tax ≈ 1.1)", { kind: "number", min: 0, max: 3 }),
  moveIn("guarantorFeeMonths", "Guarantor fee", "months", "Guarantor company's initial fee", { kind: "number", min: 0, max: 3 }),
  moveIn("fireInsuranceYen", "Fire insurance", "¥", "Premium for the contract term", { kind: "number", min: 0, max: 200_000 }),
  moveIn("cleaningFeePerM2", "Cleaning fee if unstated", "¥/㎡", "定額クリーニング費 assumed per ㎡", { kind: "number", min: 0, max: 10_000 }),
  moveIn("cleaningFeeMinimum", "Minimum cleaning fee", "¥", "Floor on the cleaning fee for small units", { kind: "number", min: 0, max: 500_000 }),
  moveIn("depositLossRate", "Deposit lost at move-out", "share 0–1", "Share of 敷金 expected to go to 原状回復", { kind: "number", min: 0, max: 1, step: 0.05 }),
  moveIn("includeFirstMonthRent", "Include first month's rent", "", "Count the first month's rent in the upfront total", { kind: "boolean" }),

  ...DISTANCE_PARAMETERS.map((key): FieldSpec => {
    const meta = SCORE_PARAMETERS.find((parameter) => parameter.key === key)!;
    const { category } = PARAMETER_SOURCES[key];
    return {
      path: `places.${key}`, group: "places", label: `Places for ${meta.label.toLowerCase()}`,
      description: `Ids of "${category}" places to measure to (look them up with find_places); ` +
        `null = the nearest of every one, [] = none (the criterion is then skipped)`,
      type: { kind: "placeIds", category },
      read: (c) => c.selection.byParameter[key],
      write: (c, v) => { c.selection.byParameter[key as DistanceParameterKey] = v as string[] | null; },
    };
  }),

  filter("cities", "Cities", "Keep only these cities ([] = all)", { kind: "stringList", values: "cities" }),
  filter("areas", "Areas (町名)", "Neighbourhoods named for filters.areaMode", { kind: "stringList", values: "areas" }),
  filter("areaMode", "Area mode", "include = only the named areas; exclude = all but them", enumOf(AREA_MODES)),
  filter("agencies", "Agencies", "Agency keys (brand:…, agency:…, store:…) for filters.agencyMode", { kind: "stringList", values: "agencies" }),
  filter("agencyMode", "Agency mode", "include = only homes known to match; exclude = all but those", enumOf(AREA_MODES)),
  filter("rentMin", "Minimum rent", "Lowest advertised rent (null = no minimum)", { kind: "nullableNumber", min: 0, max: 10_000_000 }, "¥/mo"),
  filter("rentMax", "Maximum rent", "Highest advertised rent (null = no maximum)", { kind: "nullableNumber", min: 0, max: 10_000_000 }, "¥/mo"),
  filter("sizeMin", "Minimum size", "Smallest floor area; homes with unknown size are dropped", { kind: "nullableNumber", min: 0, max: 1_000 }, "㎡"),
  filter("sizeMax", "Maximum size", "Largest floor area; homes with unknown size are dropped", { kind: "nullableNumber", min: 0, max: 1_000 }, "㎡"),
  filter("layouts", "Layouts", 'Room-count families, e.g. "3" for 3K/3DK/3LDK ([] = all)', { kind: "stringList", values: "layouts" }),
  filter("parking", "Parking", "required = a space must exist; free = at no monthly charge. Homes that do not say are kept", enumOf(["any", "required", "free"])),
  filter("parkingMaxYen", "Parking price cap", "Drop homes whose parking costs more (null = no cap)", { kind: "nullableNumber", min: 0, max: 200_000 }, "¥/mo"),
  filter("status", "Listing status", "all, only active, or only sold", enumOf(["all", "active", "sold"])),
  filter("rentedOut", "Rented out everywhere", "Homes every portal shows as gone: hide, show, or only those", enumOf(["hide", "show", "only"])),
  filter("ur", "UR rooms", "UR賃貸 rooms: show, hide, or only those", enumOf(["show", "hide", "only"])),
  filter("newOnly", "New only", "Keep only homes first seen within filters.newWithinDays", { kind: "boolean" }),
  filter("newWithinDays", "New window", "Days a home counts as new", { kind: "number", min: MIN_NEW_WINDOW_DAYS, max: MAX_NEW_WINDOW_DAYS, integer: true }, "days"),
  filter("markFilter", "Decision filter", MARK_FILTERS.map((option) => `${option.key}: ${option.hint}`).join("; ") + " (uses state.marks)",
    enumOf(MARK_FILTERS.map((option) => option.key))),

  {
    path: "ranking.sortBy", group: "ranking", label: "Sort by",
    description: '"score" (the weighted total) or any criterion key, to rank by that criterion\'s 0–100 score',
    type: enumOf(["score", ...CRITERION_KEYS]),
    read: (c) => c.ranking.sortBy,
    write: (c, v) => { c.ranking.sortBy = v as SortKey; },
  },
  {
    path: "ranking.order", group: "ranking", label: "Order", description: "desc = best first",
    type: enumOf(["desc", "asc"]),
    read: (c) => c.ranking.order,
    write: (c, v) => { c.ranking.order = v as "desc" | "asc"; },
  },
  {
    path: "ranking.minScore", group: "ranking", label: "Minimum total score", unit: "0–100",
    description: "Drop homes whose weighted total is lower",
    type: { kind: "number", min: 0, max: 100 },
    read: (c) => c.filters.minScore,
    write: (c, v) => { c.filters.minScore = v as number; },
  },
  {
    path: "ranking.minPartScores", group: "ranking", label: "Minimum criterion scores", unit: "0–100",
    description: 'Per criterion key, the lowest 0–100 score a home may have, e.g. {"station": 50}. A home with no data for it is dropped',
    type: { kind: "criterionScores" },
    read: (c) => c.ranking.minPartScores,
    write: (c, v) => { c.ranking.minPartScores = v as Criteria["ranking"]["minPartScores"]; },
  },

  {
    path: "page.limit", group: "page", label: "Results per page",
    description: `How many homes to return (at most ${MAX_PAGE_LIMIT})`,
    type: { kind: "number", min: 1, max: MAX_PAGE_LIMIT, integer: true },
    read: (c) => c.page.limit,
    write: (c, v) => { c.page.limit = v as number; },
  },
  {
    path: "page.offset", group: "page", label: "Offset",
    description: "How many ranked homes to skip; use nextOffset from the previous page",
    type: { kind: "number", min: 0, max: 1_000_000, integer: true },
    read: (c) => c.page.offset,
    write: (c, v) => { c.page.offset = v as number; },
  },
  {
    path: "view", group: "view", label: "Detail",
    description: "summary: the essentials and the weighted breakdown; full: every attribute, cost and source too",
    type: enumOf(["summary", "full"]),
    read: (c) => c.view,
    write: (c, v) => { c.view = v as Criteria["view"]; },
  },

  {
    path: "state.excludeKeys", group: "state", label: "Exclude homes",
    description: "Home keys to leave out, e.g. ones already seen", type: { kind: "stringList" },
    read: (c) => c.state.excludeKeys,
    write: (c, v) => { c.state.excludeKeys = v as string[]; },
  },
  {
    path: "state.marks", group: "state", label: "Decision marks",
    description: `Home key → one of ${LISTING_MARKS.map((mark) => mark.key).join(", ")}; used by filters.markFilter`,
    type: { kind: "markMap" },
    read: (c) => c.state.marks,
    write: (c, v) => { c.state.marks = v as MarkMap; },
  },
  {
    path: "state.duplicateDecisions", group: "state", label: "Duplicate answers",
    description: 'Id → {verdict: "same"|"different", a: ad keys, b: ad keys, decidedAt}; "same" shows two homes as one',
    type: { kind: "duplicateDecisions" },
    read: (c) => c.state.duplicateDecisions,
    write: (c, v) => { c.state.duplicateDecisions = v as Record<string, DuplicateDecision>; },
  },
  {
    path: "state.availabilityMarks", group: "state", label: "Availability marks",
    description: 'Ad key → {state: "gone"|"listed", source, url, checkedAt, evidence, method: "manual"}',
    type: { kind: "availabilityMarks" },
    read: (c) => c.state.availabilityMarks,
    write: (c, v) => { c.state.availabilityMarks = v as AvailabilityMap; },
  },
];

export const FIELD_BY_PATH: ReadonlyMap<string, FieldSpec> = new Map(FIELD_SPECS.map((spec) => [spec.path, spec]));

/** Criteria as a nested request object, one entry per field; `include` picks the fields. */
export function toRequestObject(criteria: Criteria, include: (spec: FieldSpec) => boolean = () => true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of FIELD_SPECS) {
    if (!include(spec)) continue;
    const value = spec.read(criteria);
    if (value === null && spec.path === "preset") continue;
    setPath(out, spec.path, structuredClone(value));
  }
  return out;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
  node[parts[parts.length - 1]] = value;
}
