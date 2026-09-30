import { describe, expect, it } from "vitest";
import { boundaryExtent, extentOf, labelPosition, padExtent, polygonsOf, ringCentroid } from "./mapGeometry";
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
