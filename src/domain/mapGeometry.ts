/**
 * Pure geometry for drawing reference boundaries: flattening polygon and
 * multipolygon boundaries, choosing a label point, and fitting an extent.
 */
import type { BoundaryGeometry, PolygonCoordinates, Position, ReferenceBoundary } from "./referenceData";
import type { GeoPoint } from "./types";

export interface Extent {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** Every polygon of a boundary: one for a Polygon, several for a MultiPolygon. */
export function polygonsOf(geometry: BoundaryGeometry): readonly PolygonCoordinates[] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

/** Simple average-of-vertices centroid, good enough for label placement. */
export function ringCentroid(ring: readonly Position[]): Position {
  let sx = 0;
  let sy = 0;
  for (const [lon, lat] of ring) {
    sx += lon;
    sy += lat;
  }
  return [sx / ring.length, sy / ring.length];
}

/** Label point for a city: the centroid of the outer ring of its largest polygon. */
export function labelPosition(boundaries: readonly ReferenceBoundary[]): Position | null {
  let best: readonly Position[] | null = null;
  let bestArea = -1;
  for (const boundary of boundaries) {
    for (const polygon of polygonsOf(boundary.geometry)) {
      const outer = polygon[0];
      if (!outer?.length) continue;
      const area = Math.abs(ringArea(outer));
      if (area > bestArea) {
        best = outer;
        bestArea = area;
      }
    }
  }
  return best ? ringCentroid(best) : null;
}

function ringArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/** Bounding box of the boundaries' outer rings; null when there are none. */
export function boundaryExtent(boundaries: readonly ReferenceBoundary[]): Extent | null {
  const positions = boundaries.flatMap((boundary) =>
    polygonsOf(boundary.geometry).flatMap((polygon) => polygon[0] ?? []));
  return extentOf(positions.map(([lon, lat]) => ({ lat, lon })));
}

/** Bounding box of points; null for an empty list. */
export function extentOf(points: readonly GeoPoint[]): Extent | null {
  if (points.length === 0) return null;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const { lat, lon } of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

/** Grow a degenerate (single-point or single-line) extent so it can be projected. */
export function padExtent(extent: Extent, minimumSpan = 0.01): Extent {
  const lonPad = Math.max(0, minimumSpan - (extent.maxLon - extent.minLon)) / 2;
  const latPad = Math.max(0, minimumSpan - (extent.maxLat - extent.minLat)) / 2;
  return {
    minLon: extent.minLon - lonPad,
    maxLon: extent.maxLon + lonPad,
    minLat: extent.minLat - latPad,
    maxLat: extent.maxLat + latPad,
  };
}

/** Kilometres per degree of latitude (and of longitude at the equator). */
export const KM_PER_DEGREE = 111.32;

/**
 * Horizontal shrink for an equirectangular map centred on `latitude`: a degree
 * of longitude is only cos(latitude) as long as a degree of latitude, so
 * without it the map is stretched east–west (by ~23% around Soka).
 */
export function longitudeScale(extent: Extent): number {
  return Math.cos((((extent.minLat + extent.maxLat) / 2) * Math.PI) / 180);
}

const SCALE_BAR_STEPS_KM = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20];

/** The longest round distance whose bar fits in `maxPx`, for a map scale bar. */
export function scaleBarLength(pxPerKm: number, maxPx: number): { km: number; px: number } {
  const km = [...SCALE_BAR_STEPS_KM].reverse().find((step) => step * pxPerKm <= maxPx) ?? SCALE_BAR_STEPS_KM[0];
  return { km, px: km * pxPerKm };
}
