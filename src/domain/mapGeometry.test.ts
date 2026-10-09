import { describe, expect, it } from "vitest";
import { areaCentroid, boundaryExtent, circleOffCanvas, groupBorders, pointInGeometry, labelPosition, longitudeScale, padExtent, polygonsOf, ringCentroid, ringRadiusPx, scaleBarLength } from "./mapGeometry";
import type { ReferenceBoundary } from "./referenceData";

const square = (lon: number, lat: number, size: number) =>
  [[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]] as const;

describe("map geometry", () => {
  const small: ReferenceBoundary = { id: "s", cityId: "c", geometry: { type: "Polygon", coordinates: [square(0, 0, 1)] } };
  const multi: ReferenceBoundary = {
    id: "m",
    cityId: "c",
    geometry: { type: "MultiPolygon", coordinates: [[square(10, 10, 1)], [square(20, 20, 4), square(21, 21, 1)]] },
  };

  it("flattens polygons and multipolygons", () => {
    expect(polygonsOf(small.geometry)).toHaveLength(1);
    expect(polygonsOf(multi.geometry)).toHaveLength(2);
  });

  it("labels a city at the centroid of its largest outer ring", () => {
    expect(labelPosition([small, multi])).toEqual(ringCentroid(square(20, 20, 4)));
    expect(labelPosition([])).toBeNull();
  });

  it("fits the outer rings of every boundary, and pads degenerate extents", () => {
    expect(boundaryExtent([small, multi])).toEqual({ minLon: 0, maxLon: 24, minLat: 0, maxLat: 24 });
    expect(boundaryExtent([])).toBeNull();
    const padded = padExtent({ minLon: 5, maxLon: 5, minLat: 7, maxLat: 7 });
    expect(padded.maxLon - padded.minLon).toBeCloseTo(0.01);
    expect(padded.maxLat - padded.minLat).toBeCloseTo(0.01);
  });
});

describe("map scale", () => {
  it("shrinks longitude by the cosine of the mid latitude", () => {
    expect(longitudeScale({ minLon: 139.7, maxLon: 139.9, minLat: 35.8, maxLat: 35.9 })).toBeCloseTo(0.8107, 3);
    expect(longitudeScale({ minLon: 0, maxLon: 1, minLat: -1, maxLat: 1 })).toBe(1);
  });
  it("picks the longest round distance that fits", () => {
    expect(scaleBarLength(100, 110)).toEqual({ km: 1, px: 100 });
    expect(scaleBarLength(30, 110)).toEqual({ km: 2.5, px: 75 });
    expect(scaleBarLength(400, 110)).toEqual({ km: 0.25, px: 100 });
  });
  it("falls back to the shortest step when even that overflows", () => {
    expect(scaleBarLength(5000, 110).km).toBe(0.1);
  });
});

describe("travel rings", () => {
  it("converts minutes at a speed into screen pixels", () => {
    // 5 min at 67 m/min = 335 m; at 200 px/km that is 67 px.
    expect(ringRadiusPx(5, 67, 200)).toBeCloseTo(67, 6);
    expect(ringRadiusPx(15, 67, 200)).toBeCloseTo(201, 6);
  });
  it("skips circles whose bounding box is fully off the canvas", () => {
    expect(circleOffCanvas(500, 300, 50, 1100, 680)).toBe(false);
    expect(circleOffCanvas(-60, 300, 50, 1100, 680)).toBe(true);
    expect(circleOffCanvas(-40, 300, 50, 1100, 680)).toBe(false);
    expect(circleOffCanvas(500, 760, 50, 1100, 680)).toBe(true);
    // A big ring that merely contains the canvas still draws.
    expect(circleOffCanvas(550, 340, 2000, 1100, 680)).toBe(false);
  });
});

describe("point in a boundary", () => {
  const withHole = { type: "Polygon" as const, coordinates: [square(0, 0, 4), square(1, 1, 2)] };

  it("is inside an outer ring and outside its holes", () => {
    expect(pointInGeometry([0.5, 0.5], withHole)).toBe(true);
    expect(pointInGeometry([2, 2], withHole)).toBe(false);
    expect(pointInGeometry([5, 5], withHole)).toBe(false);
    expect(pointInGeometry([12, 12], { type: "MultiPolygon", coordinates: [[square(0, 0, 1)], [square(11, 11, 2)]] })).toBe(true);
  });
});

describe("borders between groups", () => {
  // Three unit squares in a row: a and b in one prefecture, c in another.
  const cell = (lon: number) => ({ type: "Polygon" as const, coordinates: [square(lon, 0, 1)] });
  const lines = groupBorders([
    { geometry: cell(0), group: "埼玉県" },
    { geometry: cell(1), group: "埼玉県" },
    { geometry: cell(2), group: "東京都" },
  ]);
  const edges = new Set(lines.flatMap((line) =>
    line.slice(1).map((point, i) => [line[i], point].map((p) => p.join(",")).sort().join("|"))));

  it("keeps the edge between groups and the outer edge, not edges inside a group", () => {
    expect(edges.has(["2,0", "2,1"].join("|"))).toBe(true);
    expect(edges.has(["1,0", "1,1"].join("|"))).toBe(false);
    // Outer perimeter: 3 + 3 + 1 + 1 unit edges, plus the one shared border.
    expect(edges.size).toBe(9);
  });

  it("links touching edges into polylines", () => {
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("labels a group at its area-weighted centroid", () => {
    const boundaries = [cell(0), cell(1)].map((geometry, i) => ({ id: `b${i}`, cityId: `c${i}`, geometry }));
    const [lon, lat] = areaCentroid(boundaries)!;
    expect(lon).toBeCloseTo(1, 6);
    expect(lat).toBeCloseTo(0.5, 6);
    expect(areaCentroid([])).toBeNull();
  });
});
