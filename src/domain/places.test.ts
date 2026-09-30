import { describe, expect, it } from "vitest";
import { buildPlaceCatalog, isKindergarten, type ReferencePlace } from "./places";
import { ProximityIndex } from "./proximityIndex";
import { enrichListing } from "./enrichListing";
import { defaultSelection, describeSelection } from "./placeSelection";
import type { RawListing } from "./types";

const place = (id: string, category: string, name: string, extra: Partial<ReferencePlace> = {}): ReferencePlace =>
  ({ id, category, name, lat: 35.8, lon: 139.8, ...extra });

describe("buildPlaceCatalog", () => {
  it("derives category:name ids with #n suffixes in input order", () => {
    const catalog = buildPlaceCatalog([
      place("a", "busStop", "東口"),
      place("b", "busStop", "西口"),
      place("c", "busStop", "東口"),
      place("d", "busStop", "東口"),
      place("e", "station", "東口"),
    ]);
    expect(catalog.places.map((p) => p.id)).toEqual([
      "busStop:東口", "busStop:西口", "busStop:東口#1", "busStop:東口#2", "station:東口",
    ]);
  });

  it("keeps pinned app ids and order, and places new records after them", () => {
    const catalog = buildPlaceCatalog([
      place("z", "busStop", "東口"),
      place("y", "busStop", "東口", { attributes: { appPlaceId: "busStop:東口#1", appOrder: 1 } }),
      place("x", "busStop", "東口", { attributes: { appPlaceId: "busStop:東口", appOrder: 0 } }),
    ]);
    // The unpinned record cannot take an id a pinned one already owns.
    expect(catalog.places.map((p) => p.id)).toEqual(["busStop:東口", "busStop:東口#1", "busStop:東口#2"]);
  });

  it("rejects two records pinned to one app id", () => {
    expect(() => buildPlaceCatalog([
      place("a", "poi", "A", { attributes: { appPlaceId: "poi:A" } }),
      place("b", "poi", "B", { attributes: { appPlaceId: "poi:A" } }),
    ])).toThrow(/Duplicate app place id/);
  });

  it("skips retired places and indexes whatever categories exist", () => {
    const catalog = buildPlaceCatalog([
      place("a", "poi", "School", { attributes: { legacyRole: "poi1" } }),
      place("b", "poi", "Library"),
      place("c", "poi", "Clinic"),
      place("d", "park", "Big park"),
      place("e", "station", "Old stop", { status: "retired" }),
    ]);
    expect(catalog.places).toHaveLength(4);
    expect(catalog.categories).toEqual(["poi", "park"]);
    expect(catalog.inCategory("poi").map((p) => p.name)).toEqual(["School", "Library", "Clinic"]);
    expect(catalog.inCategory("station")).toEqual([]);
    expect(catalog.withRole("poi1")?.name).toBe("School");
    expect(catalog.byId.get("park:Big park")?.category).toBe("park");
  });

  it("handles an empty catalog", () => {
    const catalog = buildPlaceCatalog([]);
    expect(catalog.places).toEqual([]);
    expect(defaultSelection(catalog).byParameter.poi1).toBeNull();
    expect(describeSelection({ byParameter: { ...defaultSelection(catalog).byParameter, station: ["gone"] } }, "station", catalog))
      .toBe("only 1 place");
    const index = new ProximityIndex([{ ...listing, geocoded: true, lat: 35.8, lon: 139.8 }], catalog);
    expect(index.nearestIn(0, "station", null)).toBeNull();
    const enriched = enrichListing(listing, { lat: 35.8, lon: 139.8 }, undefined, catalog);
    expect(enriched.poi1).toBeUndefined();
    expect(enriched.station).toBeUndefined();
  });

  it("uses the facility type, not the label, to tell kindergartens from daycares", () => {
    const catalog = buildPlaceCatalog([
      place("a", "childcare", "A保育園", { subtitle: "daycare", attributes: { facilityType: "hoikuen" } }),
      place("b", "childcare", "B幼稚園", { attributes: { facilityType: "kindergarten" } }),
    ]);
    expect(catalog.inCategory("childcare").filter(isKindergarten).map((p) => p.name)).toEqual(["B幼稚園"]);
  });
});

const listing: RawListing = {
  name: "L", address: "埼玉県草加市", rent: 100_000, layout: "2LDK", sizeM2: 50,
  builtYear: 2010, stationWalkMin: null, url: null, source: "test",
};
