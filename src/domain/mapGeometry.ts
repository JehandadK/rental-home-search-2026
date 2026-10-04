/**
 * Pure geometry for drawing reference boundaries: flattening polygon and
 * multipolygon boundaries, choosing a label point, fitting an extent, testing
 * points against a boundary, and tracing the borders between groups of
 * boundaries (prefectures).
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

/** Centroid of the boundaries' outer rings taken together (by area), for labelling a group of them; null when empty. */
export function areaCentroid(boundaries: readonly ReferenceBoundary[]): Position | null {
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (const boundary of boundaries) {
    for (const polygon of polygonsOf(boundary.geometry)) {
      const ring = polygon[0];
      if (!ring?.length) continue;
      // Shoelace centroid, with the ring's orientation normalised so every piece adds.
      const sign = ringArea(ring) < 0 ? -1 : 1;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[i + 1];
        const cross = (x0 * y1 - x1 * y0) * sign;
        area += cross / 2;
        sx += (x0 + x1) * cross;
        sy += (y0 + y1) * cross;
      }
    }
  }
  return area > 0 ? [sx / (6 * area), sy / (6 * area)] : null;
}

/** True when the point lies inside the geometry: inside an outer ring and not in one of its holes. */
export function pointInGeometry(point: Position, geometry: BoundaryGeometry): boolean {
  return polygonsOf(geometry).some((polygon) =>
    polygon.length > 0 && insideRing(point, polygon[0]) && !polygon.slice(1).some((hole) => insideRing(point, hole)));
}

function insideRing([x, y]: Position, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** One edge of a group border, with the boundaries (owners) on either side. */
export interface BorderSegment {
  a: Position;
  b: Position;
  owners: readonly string[];
}

/**
 * The borders between groups of boundaries (prefectures, given each city's
 * prefecture as its group), as polylines: every edge whose two sides belong to
 * different groups, plus every edge only one boundary uses (a coast, or the
 * edge of the data). Neighbours must share identical vertices along a common
 * border, as the topology-preserving import guarantees; edges are matched by
 * their exact coordinates.
 */
export function groupBorders(
  boundaries: readonly { geometry: BoundaryGeometry; group: string; owner?: string }[],
): Position[][] {
  return joinSegments(borderSegments(boundaries));
}

/** The edges `groupBorders` draws, each with its owners, so a caller can keep only some before joining. */
export function borderSegments(
  boundaries: readonly { geometry: BoundaryGeometry; group: string; owner?: string }[],
): BorderSegment[] {
  const edges = new Map<string, { a: Position; b: Position; group: string; owners: string[]; mixed: boolean }>();
  for (const { geometry, group, owner = "" } of boundaries) {
    for (const polygon of polygonsOf(geometry)) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i];
          const b = ring[i + 1];
          const ka = pointKey(a);
          const kb = pointKey(b);
          if (ka === kb) continue;
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const edge = edges.get(key);
          if (edge) {
            edge.owners.push(owner);
            if (edge.group !== group) edge.mixed = true;
          } else {
            edges.set(key, { a, b, group, owners: [owner], mixed: false });
          }
        }
      }
    }
  }
  return [...edges.values()]
    .filter((edge) => edge.owners.length === 1 || edge.mixed)
    .map(({ a, b, owners }) => ({ a, b, owners }));
}

/** Link segments that share endpoints into as few polylines as possible. */
export function joinSegments(segments: readonly { a: Position; b: Position }[]): Position[][] {
  const at = new Map<string, number[]>();
  segments.forEach(({ a, b }, index) => {
    for (const key of [pointKey(a), pointKey(b)]) {
      const list = at.get(key);
      if (list) list.push(index);
      else at.set(key, [index]);
    }
  });
  const used = new Uint8Array(segments.length);
  const walk = (start: Position): Position[] => {
    const line: Position[] = [start];
    let current = start;
    for (;;) {
      const next = (at.get(pointKey(current)) ?? []).find((index) => !used[index]);
      if (next == null) return line;
      used[next] = 1;
      const { a, b } = segments[next];
      current = pointKey(a) === pointKey(current) ? b : a;
      line.push(current);
    }
  };
  const lines: Position[][] = [];
  // Open polylines first (from endpoints that are not on a through-line), then closed loops.
  for (const [key, list] of at) {
    if (list.length === 2) continue;
    for (const index of list) {
      if (used[index]) continue;
      const { a, b } = segments[index];
      used[index] = 1;
      const from = pointKey(a) === key ? a : b;
      const to = from === a ? b : a;
      lines.push([from, ...walk(to)]);
    }
  }
  segments.forEach(({ a, b }, index) => {
    if (used[index]) return;
    used[index] = 1;
    lines.push([a, ...walk(b)]);
  });
  return lines;
}

const pointKey = ([lon, lat]: Position) => `${lon},${lat}`;

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

const SCALE_BAR_STEPS_KM = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

/** The longest round distance whose bar fits in `maxPx`, for a map scale bar. */
export function scaleBarLength(pxPerKm: number, maxPx: number): { km: number; px: number } {
  const km = [...SCALE_BAR_STEPS_KM].reverse().find((step) => step * pxPerKm <= maxPx) ?? SCALE_BAR_STEPS_KM[0];
  return { km, px: km * pxPerKm };
}

/** Screen radius of a travel-time ring: straight-line metres covered in `minutes`, at `pxPerKm`. */
export function ringRadiusPx(minutes: number, metresPerMinute: number, pxPerKm: number): number {
  return ((minutes * metresPerMinute) / 1000) * pxPerKm;
}

/** True when a circle's bounding box lies fully outside a width×height canvas, so it can be skipped. */
export function circleOffCanvas(x: number, y: number, radius: number, width: number, height: number): boolean {
  return x + radius < 0 || y + radius < 0 || x - radius > width || y - radius > height;
}
