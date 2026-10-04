/**
 * Railway stations from MLIT 国土数値情報 N02 (鉄道), `N02-xx_Station.geojson`.
 *
 * N02 draws each station once per line as a short platform LineString, and
 * gives every station a group code (N02_005g) shared by the lines that meet
 * there under one name: 北千住 is one group of five lines and four operators.
 * One group becomes one station, placed at the mean of its platforms'
 * midpoints and kept only when that point lies inside one of the given
 * municipalities (so stations just over the region's edge drop out). A station
 * over water just off a boundary (a monorail over a canal) joins the nearest
 * municipality within `SNAP_METRES`.
 */
import type { BoundaryGeometry, Position } from "../../domain/referenceData";
import { pointInGeometry } from "../../domain/mapGeometry";

export interface N02StationProperties {
  N02_001: string; // railway type code
  N02_002: string; // operator type code
  N02_003: string; // line name
  N02_004: string; // operator name
  N02_005: string; // station name
  N02_005c?: string; // station code
  N02_005g?: string; // station group code
}

export interface N02StationFeature {
  type: "Feature";
  properties: N02StationProperties;
  geometry: { type: "LineString"; coordinates: Position[] } | null;
}

export interface N02StationCollection {
  type: "FeatureCollection";
  features: N02StationFeature[];
}

/** How far outside every boundary a station may be and still join the nearest one. */
const SNAP_METRES = 300;
const METRES_PER_DEGREE = 111_320;

export interface StationArea<K> {
  key: K;
  geometry: BoundaryGeometry;
}

export interface RailStation<K> {
  /** N02 station group code; one station per group. */
  groupCode: string;
  name: string;
  lat: number;
  lon: number;
  /** Operators and lines in first-seen order, without repeats. */
  operators: string[];
  lines: { operator: string; line: string }[];
  /** The area (municipality) the station lies in. */
  area: K;
}

/** Group the N02 platforms into stations and keep those inside `areas`. */
export function importStations<K>(collection: N02StationCollection, areas: readonly StationArea<K>[]): RailStation<K>[] {
  const groups = new Map<string, N02StationFeature[]>();
  for (const feature of collection.features) {
    if (!feature.geometry?.coordinates.length) continue;
    const { N02_005g, N02_005c, N02_005 } = feature.properties;
    const code = N02_005g || N02_005c || `${N02_005}@${feature.geometry.coordinates[0].join(",")}`;
    const group = groups.get(code) ?? [];
    group.push(feature);
    groups.set(code, group);
  }

  const boxes = areas.map((area) => ({ area, box: boxOf(area.geometry) }));
  const stations: RailStation<K>[] = [];
  for (const [groupCode, features] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const midpoints = features.map((feature) => midpoint(feature.geometry!.coordinates));
    const lon = round(mean(midpoints.map((p) => p[0])), 6);
    const lat = round(mean(midpoints.map((p) => p[1])), 6);
    const inside = boxes.find(({ area, box }) =>
      lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat &&
      pointInGeometry([lon, lat], area.geometry)) ?? nearestWithin(boxes, [lon, lat], SNAP_METRES);
    if (!inside) continue;

    const operators: string[] = [];
    const lines: RailStation<K>["lines"] = [];
    for (const { properties } of features) {
      if (!operators.includes(properties.N02_004)) operators.push(properties.N02_004);
      if (!lines.some((line) => line.operator === properties.N02_004 && line.line === properties.N02_003)) {
        lines.push({ operator: properties.N02_004, line: properties.N02_003 });
      }
    }
    stations.push({ groupCode, name: features[0].properties.N02_005, lat, lon, operators, lines, area: inside.area.key });
  }
  return stations;
}

/** The area whose boundary passes closest to the point, if within `metres`. */
function nearestWithin<K>(
  boxes: readonly { area: StationArea<K>; box: ReturnType<typeof boxOf> }[],
  [lon, lat]: Position,
  metres: number,
): { area: StationArea<K> } | undefined {
  const margin = metres / METRES_PER_DEGREE;
  const kx = Math.cos((lat * Math.PI) / 180);
  let best: { area: StationArea<K> } | undefined;
  let bestDistance = metres;
  for (const entry of boxes) {
    const { box } = entry;
    if (lon < box.minLon - margin / kx || lon > box.maxLon + margin / kx || lat < box.minLat - margin || lat > box.maxLat + margin) continue;
    const polygons = entry.area.geometry.type === "Polygon" ? [entry.area.geometry.coordinates] : entry.area.geometry.coordinates;
    for (const ring of polygons.flat()) {
      for (let i = 0; i < ring.length - 1; i++) {
        const d = segmentMetres([lon, lat], ring[i], ring[i + 1], kx);
        if (d < bestDistance) [best, bestDistance] = [entry, d];
      }
    }
  }
  return best;
}

function segmentMetres(p: Position, a: Position, b: Position, kx: number): number {
  const [px, py] = [p[0] * kx, p[1]];
  const [ax, ay] = [a[0] * kx, a[1]];
  const [bx, by] = [b[0] * kx, b[1]];
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * METRES_PER_DEGREE;
}

/** Midpoint along a polyline (by length), so a long platform is placed at its centre. */
function midpoint(coordinates: readonly Position[]): Position {
  if (coordinates.length === 1) return coordinates[0];
  const lengths = coordinates.slice(1).map((p, i) => Math.hypot(p[0] - coordinates[i][0], p[1] - coordinates[i][1]));
  const half = lengths.reduce((sum, length) => sum + length, 0) / 2;
  let walked = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (walked + lengths[i] >= half && lengths[i] > 0) {
      const t = (half - walked) / lengths[i];
      const [a, b] = [coordinates[i], coordinates[i + 1]];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += lengths[i];
  }
  return coordinates[0];
}

function boxOf(geometry: BoundaryGeometry) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    for (const [lon, lat] of polygon[0] ?? []) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
