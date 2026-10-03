import { describe, expect, it } from "vitest";
import { boundaryExtent, extentOf, labelPosition, longitudeScale, padExtent, polygonsOf, ringCentroid, scaleBarLength } from "./mapGeometry";
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
    expect(extentOf([])).toBeNull();
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
