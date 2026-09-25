/**
 * The place catalog: every reference location the tool can measure against,
 * flattened into one addressable list with stable ids.
 *
 * This is what makes the dashboard's "which places matter?" controls
 * possible — nothing is baked into the listing data, so any subset can be
 * selected at runtime without re-running the enrichment pipeline.
 */
import type { GeoPoint, NamedPlace, ScoreParameterKey } from "../types";
import {
  BUS_STOPS,
  CHILDCARE_FACILITIES,
  ELEMENTARY_SCHOOLS,
  MOSQUES,
  POINTS_OF_INTEREST,
  STATIONS,
} from "./reference";

/** Which kind of place this is; drives grouping in the UI. */
export type PlaceCategory = "poi" | "mosque" | "station" | "school" | "childcare" | "busStop";

export interface CatalogPlace extends NamedPlace {
  /** Stable, unique across the whole catalog: `${category}:${name}`. */
  id: string;
  category: PlaceCategory;
  /** Extra qualifier shown in the UI (operator, facility type…). */
  subtitle?: string;
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

/** Deduplicate ids when two places share a name within a category. */
function withUniqueIds(places: Omit<CatalogPlace, "id">[]): CatalogPlace[] {
  const used = new Map<string, number>();
  return places.map((p) => {
    const base = `${p.category}:${p.name}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return { ...p, id: seen === 0 ? base : `${base}#${seen}` };
  });
}

export const PLACE_CATALOG: CatalogPlace[] = withUniqueIds([
  ...POINTS_OF_INTEREST.map((p) => ({
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    category: "poi" as const,
    subtitle: p.address,
  })),
  ...MOSQUES.map((m) => ({
    name: m.name,
    lat: m.lat,
    lon: m.lon,
    category: "mosque" as const,
    subtitle: m.address,
  })),
  ...STATIONS.map((s) => ({
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    category: "station" as const,
    subtitle: s.operator ?? undefined,
  })),
  ...ELEMENTARY_SCHOOLS.map((s) => ({
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    category: "school" as const,
  })),
  ...CHILDCARE_FACILITIES.map((c) => ({
    name: c.name,
    lat: c.lat,
    lon: c.lon,
    category: "childcare" as const,
    subtitle: c.type,
  })),
  ...BUS_STOPS.map((b) => ({
    name: b.name,
    lat: b.lat,
    lon: b.lon,
    category: "busStop" as const,
  })),
]);

export const PLACES_BY_ID = new Map(PLACE_CATALOG.map((p) => [p.id, p]));

export const placesInCategory = (category: PlaceCategory): CatalogPlace[] =>
  PLACE_CATALOG.filter((p) => p.category === category);

/** Human labels for the category headings. */
export const CATEGORY_LABELS: Record<PlaceCategory, string> = {
  poi: "Points of interest",
  mosque: "Mosques / Masjids / Musallas",
  station: "Stations",
  school: "Elementary schools",
  childcare: "Childcare",
  busStop: "Bus stops",
};

/**
 * Which catalog category each distance parameter draws candidates from,
 * and whether the user picks one specific place ("target") or the nearest
 * of a selected set ("nearest").
 */
export interface ParameterSource {
  category: PlaceCategory;
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

/** A geo point paired with its catalog entry, for distance computations. */
export const asGeoPoint = (place: CatalogPlace): GeoPoint => ({ lat: place.lat, lon: place.lon });
