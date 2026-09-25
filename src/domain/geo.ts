/**
 * Geographic primitives: straight-line distance, walking-time estimation,
 * and nearest-place lookup. Pure functions with no I/O.
 */
import type { GeoPoint, NamedPlace, Proximity } from "../types";

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two coordinates, in metres. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const chord =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(chord));
}

/**
 * Convert straight-line metres to estimated walking minutes.
 * Roads are never straight, so a detour factor inflates the distance;
 * 80 m/min is the convention Japanese real-estate listings use for 徒歩分.
 */
export function estimateWalkMinutes(
  distM: number,
  walkSpeedMPerMin: number,
  detourFactor: number,
): number {
  return (distM * detourFactor) / walkSpeedMPerMin;
}

/** Find the closest place to a point. Returns null for an empty list. */
export function nearestPlace<T extends NamedPlace>(
  from: GeoPoint,
  places: readonly T[],
): { place: T; distM: number } | null {
  let best: { place: T; distM: number } | null = null;
  for (const place of places) {
    const distM = haversineM(from, place);
    if (!best || distM < best.distM) best = { place, distM };
  }
  return best;
}

/** Build a Proximity record from a listing to a named place. */
export function toProximity(
  from: GeoPoint,
  place: NamedPlace,
  walkSpeedMPerMin: number,
  detourFactor: number,
): Proximity {
  const distM = Math.round(haversineM(from, place));
  const walkMin = round1(estimateWalkMinutes(distM, walkSpeedMPerMin, detourFactor));
  return { name: place.name, distM, walkMin };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
