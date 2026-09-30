import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "../node/dataPaths";
import { REFERENCE_CATALOG_DIR } from "../storage/json/dataStore";
import { JsonReferenceDataRepository } from "../storage/json/jsonReferenceDataRepository";
import { boundaryExtent, extentOf, labelPosition, padExtent, polygonsOf, ringCentroid } from "./mapGeometry";
import { buildReferenceModel, type ReferenceBoundary } from "./referenceData";

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

  it("gives the current catalog the same map extent and labels as the original boundary files", async () => {
    const soka = JSON.parse(readFileSync(join(DATA_DIR, "soka_boundary.json"), "utf8")) as [number, number][];
    const neighbours = JSON.parse(readFileSync(join(DATA_DIR, "neighbor_boundaries.json"), "utf8")) as { name: string; ring: [number, number][] }[];
    const points = [...soka, ...neighbours.flatMap((city) => city.ring)];
    const lons = points.map(([lon]) => lon);
    const lats = points.map(([, lat]) => lat);

    const model = buildReferenceModel(await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot());
    expect(boundaryExtent(model.boundaries)).toEqual({
      minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats),
    });

    const byLocalName = new Map(model.cities.map((city) => [city.nameLocal, city.id]));
    const labelFor = (name: string) =>
      labelPosition(model.boundaries.filter((boundary) => boundary.cityId === byLocalName.get(name)));
    expect(labelFor("草加市")).toEqual(ringCentroid(soka));
    for (const city of neighbours) expect(labelFor(city.name)).toEqual(ringCentroid(city.ring));
  });
});
