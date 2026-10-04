/**
 * The place catalog: every reference location the tool can measure against,
 * flattened into one addressable list with stable ids.
 *
 * This is what makes the dashboard's "which places matter?" controls
 * possible — nothing is baked into the listing data, so any subset can be
 * selected at runtime without re-running the enrichment pipeline.
 *
 * The catalog is built from whatever reference places were loaded; the number
 * of places, and which categories exist, are data rather than constants.
 */
import type { GeoPoint, NamedPlace, ScoreParameterKey } from "./types";

/** Which kind of place this is; drives grouping in the UI. Categories are data. */
export type PlaceCategory = string;

/** Categories the scoring parameters and UI know how to use. */
export type KnownPlaceCategory = "poi" | "mosque" | "station" | "school" | "childcare" | "busStop" | "railStation";

type PlaceAttributes = Readonly<Record<string, string | number | boolean | null>>;

/**
 * One reference place as loaded from a reference snapshot. Structurally
 * compatible with the data layer's `ReferencePlaceRecord`, so a snapshot's
 * records can be passed in directly.
 */
export interface ReferencePlace extends NamedPlace {
  id: string;
  category: string;
  subtitle?: string;
  attributes?: PlaceAttributes;
  status?: "active" | "retired";
}

export interface CatalogPlace extends NamedPlace {
  /**
   * Stable, unique across the whole catalog: `${category}:${name}`, with `#n`
   * for repeated names. Saved place selections store these ids.
   */
  id: string;
  /** The reference record's own id (distinct from the app-facing id). */
  recordId: string;
  category: PlaceCategory;
  /** Extra qualifier shown in the UI (operator, facility type…). */
  subtitle?: string;
  /** Scoring role carried by the record (for example the `poi1` target). */
  role?: string;
  attributes?: PlaceAttributes;
}

/** An immutable, indexed catalog built from one reference snapshot. */
export interface PlaceCatalog {
  readonly places: readonly CatalogPlace[];
  readonly byId: ReadonlyMap<string, CatalogPlace>;
  /** Categories present, in catalog order. */
  readonly categories: readonly PlaceCategory[];
  inCategory(category: PlaceCategory): readonly CatalogPlace[];
  /** The first place carrying a scoring role, if any. */
  withRole(role: string): CatalogPlace | undefined;
}

/**
 * Record attributes that pin the app-facing identity and order. Saved
 * selections predate the managed catalog, so records migrated from the old
 * files carry the id and position the app derived from them.
 */
export const APP_PLACE_ID_ATTRIBUTE = "appPlaceId";
export const APP_ORDER_ATTRIBUTE = "appOrder";
const ROLE_ATTRIBUTE = "legacyRole";

const EMPTY: readonly CatalogPlace[] = [];

/**
 * Build the catalog from reference places. Retired places are skipped, but
 * their pinned ids stay reserved so a saved selection never silently moves to
 * a different place. Places with an explicit app order come first, in that
 * order; the rest follow in input order. Places without a pinned id get
 * `${category}:${name}`, suffixed with `#n` when that id is already taken.
 *
 * Unpinned ids are only as stable as the set of unpinned places, so every
 * published catalog place should be pinned (`npm run data:reference:app-ids`).
 */
export function buildPlaceCatalog(input: readonly ReferencePlace[]): PlaceCatalog {
  const used = new Set<string>();
  for (const place of input) {
    const pinned = stringAttribute(place, APP_PLACE_ID_ATTRIBUTE);
    if (pinned == null) continue;
    if (used.has(pinned)) throw new Error(`Duplicate app place id: ${pinned}`);
    used.add(pinned);
  }

  const active = input
    .map((place, position) => ({ place, position, order: numberAttribute(place, APP_ORDER_ATTRIBUTE) }))
    .filter(({ place }) => place.status !== "retired")
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.position - b.position)
    .map(({ place }) => place);
  const suffixes = new Map<string, number>();
  const places = active.map((place): CatalogPlace => {
    let id = stringAttribute(place, APP_PLACE_ID_ATTRIBUTE);
    if (id == null) {
      const base = `${place.category}:${place.name}`;
      let seen = suffixes.get(base) ?? 0;
      id = seen === 0 ? base : `${base}#${seen}`;
      while (used.has(id)) id = `${base}#${++seen}`;
      suffixes.set(base, seen + 1);
      used.add(id);
    }
    const role = stringAttribute(place, ROLE_ATTRIBUTE);
    return {
      id,
      recordId: place.id,
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      category: place.category,
      ...(place.subtitle ? { subtitle: place.subtitle } : {}),
      ...(role ? { role } : {}),
      ...(place.attributes ? { attributes: place.attributes } : {}),
    };
  });

  const byId = new Map(places.map((place) => [place.id, place]));
  const byCategory = new Map<PlaceCategory, CatalogPlace[]>();
  for (const place of places) {
    const list = byCategory.get(place.category) ?? [];
    list.push(place);
    byCategory.set(place.category, list);
  }
  return {
    places,
    byId,
    categories: [...byCategory.keys()],
    inCategory: (category) => byCategory.get(category) ?? EMPTY,
    withRole: (role) => places.find((place) => place.role === role),
  };
}

function stringAttribute(place: ReferencePlace, key: string): string | undefined {
  const value = place.attributes?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberAttribute(place: ReferencePlace, key: string): number | undefined {
  const value = place.attributes?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Childcare facilities that are 幼稚園/認定こども園, not daycares (保育園).
 * `facilityType` is "kindergarten" (幼稚園), "kodomoen" (認定こども園), or
 * "hoikuen" (保育園/保育所); OSM tags all three as amenity=kindergarten.
 */
export function isKindergarten(place: CatalogPlace): boolean {
  const type = place.attributes?.facilityType ?? place.subtitle;
  return type !== "hoikuen";
}

/** Score parameters that resolve to "distance to a place". */
export const DISTANCE_PARAMETERS = [
  "poi1",
  "poi2",
  "station",
  "busStop",
  "kindergarten",
  "school",
] as const satisfies readonly ScoreParameterKey[];

export type DistanceParameterKey = (typeof DISTANCE_PARAMETERS)[number];

/** Human labels for the category headings. */
export const CATEGORY_LABELS: Record<KnownPlaceCategory, string> = {
  poi: "Private schools",
  mosque: "Mosques / Masjids / Musallas",
  station: "Stations",
  school: "Elementary schools",
  childcare: "Childcare",
  busStop: "Bus stops",
  railStation: "Rail stations",
};

/** Label for any category, including ones added to the data later. */
export const categoryLabel = (category: PlaceCategory): string =>
  (CATEGORY_LABELS as Record<string, string>)[category] ?? category;

/**
 * Which catalog category each distance parameter draws candidates from,
 * and whether the user picks one specific place ("target") or the nearest
 * of a selected set ("nearest").
 */
export interface ParameterSource {
  category: KnownPlaceCategory;
  mode: "target" | "nearest";
}

export const PARAMETER_SOURCES: Record<DistanceParameterKey, ParameterSource> = {
  poi1: { category: "poi", mode: "target" },
  // Mosque score is always the nearest of the chosen mosque set. By default
  // all bundled mosques count; users may curate the set but cannot accidentally
  // turn this back into a single hard-coded mosque unless they explicitly select one.
  poi2: { category: "mosque", mode: "nearest" },
  station: { category: "station", mode: "nearest" },
  busStop: { category: "busStop", mode: "nearest" },
  kindergarten: { category: "childcare", mode: "nearest" },
  school: { category: "school", mode: "nearest" },
};

/**
 * Categories the scoring measures distances to. Other categories (the
 * region-wide rail stations) are map context only, so the browser never
 * builds a listing × place distance matrix for them.
 */
export const SCORED_CATEGORIES: readonly KnownPlaceCategory[] = [
  ...new Set(Object.values(PARAMETER_SOURCES).map((source) => source.category)),
];

/** A geo point paired with its catalog entry, for distance computations. */
export const asGeoPoint = (place: CatalogPlace): GeoPoint => ({ lat: place.lat, lon: place.lon });
