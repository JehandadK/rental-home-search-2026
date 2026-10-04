/**
 * How far a listing is from the places that matter, for the map's selection
 * card: every point of interest (the scored target first), then the nearest
 * mosque, station, school, childcare and bus stop as the scoring measures them.
 *
 * Distances are straight-line kilometres; walking minutes always use the walk
 * speed and detour factor, whatever travel mode the scoring is set to.
 */
import { estimateWalkMinutes, haversineM } from "./geo";
import type { CatalogPlace } from "./places";
import type { EnrichedListing, Proximity } from "./types";

export interface ListingDistance {
  /** Stable row key. */
  key: string;
  /** What the row measures to: a POI's name, or the kind of place. */
  label: string;
  /** The specific place, for nearest-of rows; omitted when the label already names it. */
  place?: string;
  distM: number;
  walkMin: number;
  /** True when the minutes are the listing's advertised 徒歩分 rather than an estimate. */
  advertised?: boolean;
}

export interface DistanceOptions {
  /** Points of interest to measure to directly; the target is listed first. */
  pois: readonly CatalogPlace[];
  targetPoiId?: string | null;
  walkSpeedMPerMin: number;
  detourFactor: number;
  /** Measure childcare to any facility (including 保育園), as the scoring does. */
  includeHoikuen?: boolean;
}

export function listingDistances(listing: EnrichedListing, options: DistanceOptions): ListingDistance[] {
  if (listing.lat == null || listing.lon == null) return [];
  const from = { lat: listing.lat, lon: listing.lon };
  const walk = (distM: number) => estimateWalkMinutes(distM, options.walkSpeedMPerMin, options.detourFactor);

  const pois = [...options.pois].sort((a, b) =>
    Number(b.id === options.targetPoiId) - Number(a.id === options.targetPoiId));
  const rows: ListingDistance[] = pois.map((poi) => {
    const distM = haversineM(from, poi);
    return { key: poi.id, label: poi.name, distM, walkMin: walk(distM) };
  });

  const named = new Set(pois.map((poi) => poi.name));
  const nearest = (key: string, label: string, proximity: Proximity | undefined) => {
    if (!proximity || named.has(proximity.name)) return null;
    const row: ListingDistance = { key, label, place: proximity.name, distM: proximity.distM, walkMin: walk(proximity.distM) };
    rows.push(row);
    return row;
  };
  nearest("mosque", "Mosque", listing.poi2);
  // A measured 徒歩分 from the ad beats the estimate when it describes this station.
  const station = nearest("station", "Station", listing.station);
  if (station && listing.stationWalkMin != null && advertisesStation(listing, station.place!)) {
    station.walkMin = listing.stationWalkMin;
    station.advertised = true;
  }
  nearest("school", "School", listing.school);
  nearest("childcare", options.includeHoikuen ? "Childcare" : "Kindergarten",
    options.includeHoikuen ? listing.childcareAny : listing.kindergarten);
  nearest("busStop", "Bus stop", listing.busStop);
  return rows;
}

/** True unless the ad names a different station than the one measured (as the scoring decides). */
function advertisesStation(listing: EnrichedListing, measured: string): boolean {
  return listing.advertisedStation == null || listing.advertisedStation.replace(/駅$/, "") === measured;
}

/** "0.4 km", "2.3 km". */
export const formatKm = (distM: number): string => `${(distM / 1000).toFixed(1)} km`;
