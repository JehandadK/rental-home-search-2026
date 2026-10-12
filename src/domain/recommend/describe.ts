/**
 * The self-describing side of the API: what can be asked, and what was used.
 *
 *   describeCriteria  every field a request may set, with labels, units,
 *                     ranges, defaults and the values the data allows
 *   findPlaces        place ids for the `places.*` fields
 *   scoringSummary    the scoring a response used, per criterion, with the
 *                     request path that changes each value
 */
import { haversineM } from "../geo";
import { categoryLabel, DISTANCE_PARAMETERS, PARAMETER_SOURCES, type CatalogPlace, type PlaceCatalog } from "../places";
import { describeSelection } from "../placeSelection";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS, travelSpeed } from "../scoringConfig";
import { BUILT_IN_PRESETS } from "../weightPresets";
import {
  CRITERION_KEYS,
  defaultCriteria,
  FIELD_BY_PATH,
  FIELD_SPECS,
  GROUP_DESCRIPTIONS,
  MAX_WEIGHT,
  PARAMETER_ANCHORS,
  PARAMETER_LABELS_JA,
  parameterDirection,
  type DataValues,
  type FieldGroup,
  type FieldSpec,
} from "./criteriaSchema";
import type { DecodedRequest, ValueSource } from "./request";

/** The data a catalogue is described against. */
export interface CatalogueContext {
  values: Record<DataValues, readonly string[]>;
  catalog: PlaceCatalog;
}

export interface FieldDescription {
  path: string;
  label: string;
  labelJa?: string;
  unit?: string;
  description: string;
  type: "number" | "integer" | "number|null" | "boolean" | "enum" | "string[]" | "placeIds|null" | "object";
  min?: number;
  max?: number;
  step?: number;
  /** Every allowed value, when there are few enough to list. */
  allowed?: readonly string[];
  /** How many values the data allows, when they are not all listed. */
  allowedCount?: number;
  /** For `places.*`: the catalog category to look ids up in. */
  placeCategory?: string;
  default: unknown;
}

/** Data-derived value lists longer than this are cut to their most frequent entries. */
const MAX_LISTED_VALUES = 100;

export function describeCriteria(context: CatalogueContext) {
  const defaults = defaultCriteria();
  const groups = (Object.keys(GROUP_DESCRIPTIONS) as FieldGroup[]).map((group) => ({
    group,
    description: GROUP_DESCRIPTIONS[group],
    fields: FIELD_SPECS.filter((spec) => spec.group === group).map((spec) => describeField(spec, defaults, context)),
  }));
  return {
    summary:
      "Rank rental homes in Saitama/Tokyo by your own weighted criteria. Every field below is optional: " +
      "omitted fields keep their default (or the preset's value). Send the fields as a nested JSON body " +
      '(POST) or as dotted query keys (GET), e.g. {"weights": {"station": 12}} or ?weights.station=12.',
    howToUse: [
      "Pick a preset that fits, or keep the defaults.",
      "Set weights.* (0–20, relative) for what matters and features.*.weight for yes/no features.",
      "Use filters.* for hard limits (rent, size, layout, city, parking).",
      "Look up place ids with find_places to measure to specific schools, mosques or stations (places.*).",
      "Rank. Each response returns `scoring` (what was used, with the path to change each value) and `request` (the full resolved request).",
      "To tweak, change one path in `request` and send it again; compare the new ranking.",
    ],
    groups,
    presets: BUILT_IN_PRESETS.map(({ id, label, description, weights }) => ({ id, label, description, weights: { ...weights } })),
    placeCategories: DISTANCE_PARAMETERS.map((key) => {
      const { category } = PARAMETER_SOURCES[key];
      return { parameter: key, set: `places.${key}`, category, label: categoryLabel(category), count: context.catalog.inCategory(category).length };
    }),
    criterionKeys: CRITERION_KEYS,
  };
}

function describeField(spec: FieldSpec, defaults: ReturnType<typeof defaultCriteria>, context: CatalogueContext): FieldDescription {
  const base = {
    path: spec.path,
    label: spec.label,
    ...(spec.labelJa ? { labelJa: spec.labelJa } : {}),
    ...(spec.unit ? { unit: spec.unit } : {}),
    description: spec.description,
    default: spec.read(defaults),
  };
  const { type } = spec;
  switch (type.kind) {
    case "number":
      return { ...base, type: type.integer ? "integer" : "number", min: type.min, max: type.max, ...(type.step ? { step: type.step } : {}) };
    case "nullableNumber":
      return { ...base, type: "number|null", min: type.min, max: type.max };
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
      return { ...base, type: "enum", allowed: type.values };
    case "stringList": {
      const values = type.values ? context.values[type.values] : undefined;
      if (!values) return { ...base, type: "string[]" };
      return values.length <= MAX_LISTED_VALUES
        ? { ...base, type: "string[]", allowed: values }
        : { ...base, type: "string[]", allowed: values.slice(0, MAX_LISTED_VALUES), allowedCount: values.length };
    }
    case "placeIds":
      return { ...base, type: "placeIds|null", placeCategory: type.category, allowedCount: context.catalog.inCategory(type.category).length };
    default:
      return { ...base, type: "object" };
  }
}

export interface PlaceQuery {
  category?: string;
  /** Case- and width-insensitive part of the name. */
  q?: string;
  /** Nearest first from here. */
  near?: { lat: number; lon: number };
  limit?: number;
}

export interface FoundPlace {
  id: string;
  name: string;
  category: string;
  subtitle?: string;
  lat: number;
  lon: number;
  /** Straight-line metres from `near`, when given. */
  distM?: number;
}

const fold = (text: string) => text.normalize("NFKC").toLowerCase();

export function findPlaces(catalog: PlaceCatalog, query: PlaceQuery): FoundPlace[] {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
  const needle = query.q ? fold(query.q) : null;
  const pool: readonly CatalogPlace[] = query.category ? catalog.inCategory(query.category) : catalog.places;
  const matches = needle
    ? pool.filter((place) => fold(place.name).includes(needle) || (place.subtitle != null && fold(place.subtitle).includes(needle)))
    : pool;
  const found = matches.map((place): FoundPlace => ({
    id: place.id, name: place.name, category: place.category,
    ...(place.subtitle ? { subtitle: place.subtitle } : {}),
    lat: place.lat, lon: place.lon,
    ...(query.near ? { distM: Math.round(haversineM(query.near, place)) } : {}),
  }));
  if (query.near) found.sort((a, b) => a.distM! - b.distM!);
  return found.slice(0, limit);
}

/**
 * The scoring a response used: per criterion its weight, its share of all the
 * weight, where the value came from, and the request path that changes it.
 * Weight-0 criteria are included, so the caller sees what it could turn on.
 */
export function scoringSummary(decoded: DecodedRequest, catalog: PlaceCatalog) {
  const { criteria, sources } = decoded;
  const { config } = criteria;
  const totalWeight = [...Object.values(config.weights), ...Object.values(config.featureWeights)].reduce((sum, w) => sum + w, 0);
  const shareOf = (weight: number) => (totalWeight > 0 ? Math.round((weight / totalWeight) * 1000) / 1000 : 0);
  const source = (path: string): ValueSource => sources[path] ?? "default";
  const anchorValue = (end: string | number) => (typeof end === "number" ? end : FIELD_BY_PATH.get(end)!.read(criteria) as number);

  return {
    parameters: SCORE_PARAMETERS.map((meta) => {
      const set = `weights.${meta.key}`;
      const { full, zero } = PARAMETER_ANCHORS[meta.key];
      const distance = (DISTANCE_PARAMETERS as readonly string[]).includes(meta.key)
        ? meta.key as (typeof DISTANCE_PARAMETERS)[number]
        : null;
      return {
        key: meta.key,
        label: meta.label,
        labelJa: PARAMETER_LABELS_JA[meta.key],
        unit: meta.unit,
        weight: config.weights[meta.key],
        share: shareOf(config.weights[meta.key]),
        source: source(set),
        set,
        range: { min: 0, max: MAX_WEIGHT },
        direction: parameterDirection(meta.key),
        anchors: {
          fullScoreAt: anchorValue(full),
          zeroScoreAt: anchorValue(zero),
          set: { ...(typeof full === "string" ? { fullScoreAt: full } : {}), zeroScoreAt: zero },
          source: typeof full === "string" && source(full) === "request" ? "request" as const : source(zero),
        },
        ...(distance ? {
          places: {
            selection: describeSelection(criteria.selection, distance, catalog),
            ids: criteria.selection.byParameter[distance],
            set: `places.${distance}`,
            source: source(`places.${distance}`),
          },
        } : {}),
      };
    }),
    features: FEATURE_PARAMETERS.map((meta) => {
      const set = `features.${meta.key}.weight`;
      return {
        key: meta.key,
        label: meta.label,
        labelJa: meta.labelJa,
        category: meta.category,
        weight: config.featureWeights[meta.key],
        share: shareOf(config.featureWeights[meta.key]),
        prefer: config.featurePreferences[meta.key],
        source: source(set),
        set,
        setPrefer: `features.${meta.key}.prefer`,
      };
    }),
    travel: {
      mode: config.travelMode,
      speedMPerMin: travelSpeed(config),
      detourFactor: config.detourFactor,
      includeParking: config.includeParking,
      includeHoikuen: config.includeHoikuen,
    },
    moveIn: config.moveIn,
    preset: criteria.presetId,
  };
}

export type ScoringSummary = ReturnType<typeof scoringSummary>;
export type CriteriaCatalogue = ReturnType<typeof describeCriteria>;
