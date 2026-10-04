import { describe, expect, it } from "vitest";
import type { ReferenceDataSnapshot } from "../data-layer/contracts";
import { buildReferenceModel, type ReferenceSnapshotLike } from "./referenceData";

// The data layer's snapshot must stay directly usable by the domain.
const snapshotIsCompatible = (snapshot: ReferenceDataSnapshot): ReferenceSnapshotLike => snapshot;
void snapshotIsCompatible;

const ring = [[139.7, 35.8], [139.8, 35.8], [139.8, 35.9], [139.7, 35.8]] as const;

describe("buildReferenceModel", () => {
  it("keeps active cities, their active boundaries, and active places", () => {
    const model = buildReferenceModel({
      revision: "r1",
      cities: {
        records: [
          { id: "city:a", name: "A", status: "active" },
          { id: "city:b", name: "B", status: "retired" },
          { id: "city:c", name: "C" },
        ],
      },
      boundaries: {
        records: [
          { id: "b1", cityId: "city:a", geometry: { type: "Polygon", coordinates: [ring] } },
          { id: "b2", cityId: "city:a", geometry: { type: "MultiPolygon", coordinates: [[ring], [ring]] } },
          { id: "b3", cityId: "city:b", geometry: { type: "Polygon", coordinates: [ring] } },
          { id: "b4", cityId: "city:c", geometry: { type: "Polygon", coordinates: [ring] }, status: "retired" },
        ],
      },
      places: {
        records: [
          { id: "p1", category: "poi", name: "P", lat: 35.8, lon: 139.8 },
          { id: "p2", category: "poi", name: "Q", lat: 35.8, lon: 139.8, status: "retired" },
        ],
      },
    });
    expect(model.revision).toBe("r1");
    expect(model.cities.map((city) => city.id)).toEqual(["city:a", "city:c"]);
    expect(model.boundaries.map((boundary) => boundary.id)).toEqual(["b1", "b2"]);
    expect(model.catalog.places.map((place) => place.id)).toEqual(["poi:P"]);
  });
});
