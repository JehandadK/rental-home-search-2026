/**
 * Topology-preserving simplification for a set of adjoining polygons, such as
 * municipal boundaries.
 *
 * Simplifying each polygon on its own moves a shared border differently on
 * each side, leaving slivers and gaps between neighbours. Instead, every ring
 * is cut into chains at the vertices where the set of polygons sharing an edge
 * changes (the junctions). Each chain is simplified once, in a canonical
 * direction, and both neighbours reuse the result, so shared borders stay
 * identical vertex for vertex. The web map relies on that to find prefecture
 * borders by matching edges.
 *
 * Pure: no I/O. Coordinates are [longitude, latitude] in degrees.
 */
import type { Position } from "../../domain/referenceData";

/** One polygon: an outer ring followed by any holes, each ring closed. */
export type Polygon = Position[][];

export interface TopoFeature<K> {
  key: K;
  polygons: readonly Polygon[];
}

export interface SimplifyOptions {
  /** Douglas–Peucker tolerance, in degrees of latitude (≈ 111 km per degree). */
  tolerance: number;
  /** Decimal places kept in the output coordinates. */
  precision: number;
  /**
   * Islands (polygons, or holes, that share no edge with another feature)
   * smaller than this many km² are dropped. Shared rings are always kept.
   */
  minIslandAreaKm2?: number;
}

/** Quantisation of input vertices; N03 coordinates carry nine decimals. */
const QUANTUM = 1e7;
const KM_PER_DEGREE = 111.32;

interface PreparedRing {
  feature: number;
  polygon: number;
  ring: number;
  keys: string[];
  positions: Position[];
}

/**
 * Simplify the features together. Returns each feature's simplified polygons
 * in input order; a feature whose every polygon was dropped returns none.
 */
export function simplifyShared<K>(features: readonly TopoFeature<K>[], options: SimplifyOptions): Map<K, Polygon[]> {
  const rings = prepareRings(features);
  const edgeOwners = new Map<string, number[]>();
  const degree = new Map<string, number>();
  for (const ring of rings) {
    for (let i = 0; i < ring.keys.length - 1; i++) {
      const edge = edgeKey(ring.keys[i], ring.keys[i + 1]);
      let owners = edgeOwners.get(edge);
      if (!owners) {
        owners = [];
        edgeOwners.set(edge, owners);
        degree.set(ring.keys[i], (degree.get(ring.keys[i]) ?? 0) + 1);
        degree.set(ring.keys[i + 1], (degree.get(ring.keys[i + 1]) ?? 0) + 1);
      }
      owners.push(ring.feature);
    }
  }
  const signature = (a: string, b: string) => {
    const owners = edgeOwners.get(edgeKey(a, b))!;
    return [...new Set(owners)].sort((x, y) => x - y).join(",");
  };
  const shared = (a: string, b: string) => edgeOwners.get(edgeKey(a, b))!.length > 1;

  const cache = new Map<string, Position[]>();
  const output = new Map<K, Polygon[]>();
  const polygonsByFeature = new Map<number, Map<number, (Position[] | null)[]>>();

  for (const ring of rings) {
    const n = ring.keys.length - 1; // distinct vertices (closed ring repeats the first)
    const island = !ring.keys.slice(0, n).some((key, i) => shared(key, ring.keys[i + 1]));
    if (island && options.minIslandAreaKm2 && ringAreaKm2(ring.positions) < options.minIslandAreaKm2) {
      setRing(polygonsByFeature, ring, null);
      continue;
    }

    // Nodes: junctions of three or more edges, and vertices where the owners change.
    const nodes: number[] = [];
    for (let i = 0; i < n; i++) {
      const previous = ring.keys[(i - 1 + n) % n];
      const current = ring.keys[i];
      const next = ring.keys[i + 1];
      if ((degree.get(current) ?? 0) > 2 || signature(previous, current) !== signature(current, next)) nodes.push(i);
    }
    if (nodes.length === 0) {
      // A ring with no junctions (an island, or an enclave and its hole): start at
      // the smallest vertex so both rings around an enclave split identically.
      let start = 0;
      for (let i = 1; i < n; i++) if (ring.keys[i] < ring.keys[start]) start = i;
      nodes.push(start);
    }

    const simplified: Position[] = [];
    for (let c = 0; c < nodes.length; c++) {
      const from = nodes[c];
      const to = c + 1 < nodes.length ? nodes[c + 1] : nodes[0] + n;
      const indices: number[] = [];
      for (let i = from; i <= to; i++) indices.push(i % n);
      const chain = simplifyChain(indices.map((i) => ring.keys[i]), indices.map((i) => ring.positions[i]), cache, options);
      for (let i = simplified.length ? 1 : 0; i < chain.length; i++) simplified.push(chain[i]);
    }
    setRing(polygonsByFeature, ring, closeRing(dedupe(simplified)));
  }

  features.forEach((feature, index) => {
    const polygons: Polygon[] = [];
    const byPolygon = polygonsByFeature.get(index);
    for (const [, ringsOfPolygon] of [...(byPolygon ?? new Map())].sort((a, b) => a[0] - b[0])) {
      const [outer, ...holes] = ringsOfPolygon as (Position[] | null)[];
      if (!outer || outer.length < 4) continue;
      polygons.push([outer, ...holes.filter((hole): hole is Position[] => hole != null && hole.length >= 4)]);
    }
    output.set(feature.key, polygons);
  });
  return output;
}

function prepareRings<K>(features: readonly TopoFeature<K>[]): PreparedRing[] {
  const rings: PreparedRing[] = [];
  features.forEach((feature, featureIndex) => {
    feature.polygons.forEach((polygon, polygonIndex) => {
      polygon.forEach((input, ringIndex) => {
        const keys: string[] = [];
        const positions: Position[] = [];
        for (const position of input) {
          const key = vertexKey(position);
          if (keys.length && keys[keys.length - 1] === key) continue;
          keys.push(key);
          positions.push(position);
        }
        if (keys.length > 1 && keys[0] === keys[keys.length - 1]) {
          keys.pop();
          positions.pop();
        }
        if (keys.length < 3) return;
        keys.push(keys[0]);
        positions.push(positions[0]);
        rings.push({ feature: featureIndex, polygon: polygonIndex, ring: ringIndex, keys, positions });
      });
    });
  });
  return rings;
}

function setRing(
  target: Map<number, Map<number, (Position[] | null)[]>>,
  ring: PreparedRing,
  value: Position[] | null,
): void {
  let byPolygon = target.get(ring.feature);
  if (!byPolygon) target.set(ring.feature, (byPolygon = new Map()));
  let rings = byPolygon.get(ring.polygon);
  if (!rings) byPolygon.set(ring.polygon, (rings = []));
  rings[ring.ring] = value;
}

/**
 * Simplify one chain in its canonical direction (so the neighbour on the other
 * side gets the same vertices), then return it in the caller's direction.
 */
function simplifyChain(keys: string[], positions: Position[], cache: Map<string, Position[]>, options: SimplifyOptions): Position[] {
  const closed = keys[0] === keys[keys.length - 1];
  const reverse = closed
    ? keys.length > 2 && keys[1] > keys[keys.length - 2]
    : keys[0] > keys[keys.length - 1];
  const canonicalKeys = reverse ? [...keys].reverse() : keys;
  const id = canonicalKeys.join(";");
  let result = cache.get(id);
  if (!result) {
    const canonical = reverse ? [...positions].reverse() : positions;
    result = dedupe(douglasPeucker(canonical, options.tolerance, closed).map((p) => round(p, options.precision)));
    cache.set(id, result);
  }
  return reverse ? [...result].reverse() : result;
}

/** Douglas–Peucker on an equirectangular projection; endpoints are always kept. */
function douglasPeucker(points: readonly Position[], tolerance: number, closed: boolean): Position[] {
  if (points.length <= 2) return [...points];
  const kx = Math.cos((points[0][1] * Math.PI) / 180);
  const xy = points.map(([lon, lat]) => [lon * kx, lat] as const);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [];
  if (closed) {
    // A closed chain starts and ends on the same vertex: split at the farthest point.
    let far = 1;
    let farDist = -1;
    for (let i = 1; i < points.length - 1; i++) {
      const d = Math.hypot(xy[i][0] - xy[0][0], xy[i][1] - xy[0][1]);
      if (d > farDist) [far, farDist] = [i, d];
    }
    keep[far] = 1;
    stack.push([0, far], [far, points.length - 1]);
  } else {
    stack.push([0, points.length - 1]);
  }
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let index = -1;
    let max = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(xy[i], xy[a], xy[b]);
      if (d > max) [index, max] = [i, d];
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  let result = points.filter((_, i) => keep[i]);
  if (closed && result.length < 4) {
    // Keep a closed chain a ring: the start, two spread-out points, and the start again.
    const third = Math.floor((points.length - 1) / 3);
    result = [points[0], points[third], points[2 * third], points[points.length - 1]];
  }
  return result;
}

function segmentDistance(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Shoelace area of a ring in km² (equirectangular, fine at municipal scale). */
export function ringAreaKm2(ring: readonly Position[]): number {
  if (ring.length < 3) return 0;
  const kx = Math.cos((ring[0][1] * Math.PI) / 180) * KM_PER_DEGREE;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * kx * ring[i + 1][1] * KM_PER_DEGREE - ring[i + 1][0] * kx * ring[i][1] * KM_PER_DEGREE;
  }
  return Math.abs(sum / 2);
}

const vertexKey = ([lon, lat]: Position) => `${Math.round(lon * QUANTUM)},${Math.round(lat * QUANTUM)}`;
const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function round([lon, lat]: Position, precision: number): Position {
  const factor = 10 ** precision;
  return [Math.round(lon * factor) / factor, Math.round(lat * factor) / factor];
}

function dedupe(points: readonly Position[]): Position[] {
  const result: Position[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) result.push(point);
  }
  return result;
}

function closeRing(points: Position[]): Position[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) points.push(first);
  return points;
}
