/**
 * How far a UR estate is from the places that matter: the nearest mosque,
 * private school, station, school, kindergarten and bus stop.
 *
 * An estate is not scored: its rooms differ in size and rent, so only the
 * estate's surroundings are measured, at the default walking speed and detour
 * (the same figures the listings' baked proximities use).
 */
import { nearestPlace, toProximity } from "./geo";
import { isKindergarten, type CatalogPlace, type PlaceCatalog } from "./places";
import type { GeoPoint, Proximity } from "./types";

/** A nearest place, as the UR rooms page shows it. */
export interface UrNearbyPlace extends Proximity {
  /** English name when the catalog has one (the curated stations). */
  nameEn?: string;
}

export interface UrEstateNearby {
  mosque: UrNearbyPlace | null;
  /** The private schools list (Al Sanad School Japan, Tokyo IQRA Int'l School). */
  privateSchool: UrNearbyPlace | null;
  station: UrNearbyPlace | null;
  school: UrNearbyPlace | null;
  kindergarten: UrNearbyPlace | null;
  busStop: UrNearbyPlace | null;
}

const WALK_SPEED_M_PER_MIN = 80;
const DETOUR_FACTOR = 1.3;

/**
 * Schools, kindergartens and bus stops are collected for the target cities
 * only, so beyond this the nearest one is not the nearest there is.
 */
const LOCAL_DATA_RADIUS_M = 3000;

const nameEnOf = (place: CatalogPlace): string | undefined => {
  const value = place.attributes?.nameEn;
  return typeof value === "string" && value !== "" ? value : undefined;
};

export function urEstateNearby(from: GeoPoint, catalog: PlaceCatalog): UrEstateNearby {
  // A curated station's English name also names its rail-station twin (same Japanese name).
  const englishByName = new Map(catalog.inCategory("station").flatMap((place) => {
    const nameEn = nameEnOf(place);
    return nameEn ? [[place.name, nameEn] as const] : [];
  }));
  const nearest = (places: readonly CatalogPlace[], radiusM = Infinity): UrNearbyPlace | null => {
    const found = nearestPlace(from, places);
    if (!found || found.distM > radiusM) return null;
    const nameEn = nameEnOf(found.place) ?? (found.place.category === "railStation" ? englishByName.get(found.place.name) : undefined);
    return { ...toProximity(from, found.place, WALK_SPEED_M_PER_MIN, DETOUR_FACTOR), ...(nameEn ? { nameEn } : {}) };
  };
  // The curated stations name their English; the rest of Kanto's stations are Japanese only.
  const stations = [...catalog.inCategory("station"), ...catalog.inCategory("railStation")];
  return {
    mosque: nearest(catalog.inCategory("mosque")),
    privateSchool: nearest(catalog.inCategory("poi")),
    station: nearest(stations),
    school: nearest(catalog.inCategory("school"), LOCAL_DATA_RADIUS_M),
    kindergarten: nearest(catalog.inCategory("childcare").filter(isKindergarten), LOCAL_DATA_RADIUS_M),
    busStop: nearest(catalog.inCategory("busStop"), LOCAL_DATA_RADIUS_M),
  };
}

const ROW_LABELS: readonly (readonly [keyof UrEstateNearby, string])[] = [
  ["mosque", "Mosque"], ["privateSchool", "Private school"], ["station", "Station"],
  ["school", "School"], ["kindergarten", "Kindergarten"], ["busStop", "Bus stop"],
];

/** One line per place found: "Mosque 0.8 km · 13 min walk · Baitul Aman Masjid". */
export function describeNearby(nearby: UrEstateNearby): string[] {
  return ROW_LABELS.flatMap(([key, label]) => {
    const place = nearby[key];
    return place ? [`${label} ${(place.distM / 1000).toFixed(1)} km · ${Math.round(place.walkMin)} min walk · ${place.nameEn ?? place.name}`] : [];
  });
}
