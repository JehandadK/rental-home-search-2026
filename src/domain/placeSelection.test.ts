import { describe, expect, it } from "vitest";
import { ProximityIndex } from "./proximityIndex";
import { applySelection, defaultSelection, describeSelection } from "./placeSelection";
import { PLACE_CATALOG } from "./reference";
import { haversineM } from "./geo";
import type { EnrichedListing } from "./types";

const listing = (lat: number, lon: number): EnrichedListing => ({
  name: "L",
  address: "埼玉県草加市",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2010,
  stationWalkMin: null,
  url: null,
  source: "test",
  geocoded: true,
  lat,
  lon,
});

const DEFAULT_SELECTION = defaultSelection(PLACE_CATALOG);
const placesInCategory = (category: string) => PLACE_CATALOG.inCategory(category);

// Near Soka station.
const SOKA = listing(35.8282, 139.8033);

describe("ProximityIndex", () => {
  const index = new ProximityIndex([SOKA], PLACE_CATALOG);

  it("measures the distance to a specific place", () => {
    const station = placesInCategory("station").find((p) => p.name === "草加")!;
    const d = index.distanceTo(0, station.id);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(haversineM(SOKA as never, station), 3);
  });

  it("finds the nearest place in a category", () => {
    const nearest = index.nearestIn(0, "station", null);
    // Soka station is a few hundred metres from the test coordinate.
    expect(nearest?.name).toBe("草加");
    expect(nearest!.distM).toBeLessThan(1000);
  });

  it("honours a restricted candidate set", () => {
    const yatsuka = placesInCategory("station").find((p) => p.name === "谷塚")!;
    const nearest = index.nearestIn(0, "station", new Set([yatsuka.id]));
    expect(nearest?.name).toBe("谷塚");
  });

  it("returns null when nothing is selected", () => {
    expect(index.nearestIn(0, "station", new Set())).toBeNull();
  });

  it("skips listings without coordinates", () => {
    const noCoords = { ...SOKA, lat: undefined, lon: undefined };
    const idx = new ProximityIndex([noCoords], PLACE_CATALOG);
    expect(idx.nearestIn(0, "station", null)).toBeNull();
  });
});

describe("applySelection", () => {
  const index = new ProximityIndex([SOKA], PLACE_CATALOG);

  it("resolves every distance parameter with the default selection", () => {
    const out = applySelection(SOKA, 0, index, DEFAULT_SELECTION);
    expect(out.station?.name).toBe("草加");
    expect(out.poi1?.name).toContain("Al Sanad");
    expect(out.poi2?.name).toBeTruthy();
    expect([
      "Baitul Aman Masjid (蒲生モスク)",
      "Baitul Aqsa Masjid",
      "Mizumoto Musalla",
      "Yashio Masjid",
      "Yashio Gujarati Masjid",
    ]).toContain(out.poi2?.name);
    expect(out.school).toBeDefined();
    expect(out.busStop).toBeDefined();
    expect(out.childcareAny).toBeDefined();
  });

  it("re-targets a parameter without touching the source data", () => {
    const shinden = placesInCategory("station").find((p) => p.name === "新田")!;
    const out = applySelection(SOKA, 0, index, {
      byParameter: { ...DEFAULT_SELECTION.byParameter, station: [shinden.id] },
    });
    expect(out.station?.name).toBe("新田");
    // The original listing object is untouched.
    expect(SOKA.station).toBeUndefined();
  });

  it("swaps the Al Sanad POI target", () => {
    const poi = placesInCategory("poi")[0];
    const out = applySelection(SOKA, 0, index, {
      byParameter: { ...DEFAULT_SELECTION.byParameter, poi1: [poi.id] },
    });
    expect(out.poi1?.name).toBe(poi.name);
  });

  it("scores the nearest mosque and honours a curated mosque set", () => {
    const mosques = placesInCategory("mosque");
    const all = applySelection(SOKA, 0, index, DEFAULT_SELECTION);
    const distances = mosques.map((mosque) => ({ mosque, d: haversineM(SOKA as never, mosque) }));
    const nearest = distances.sort((a, b) => a.d - b.d)[0].mosque;
    expect(all.poi2?.name).toBe(nearest.name);

    const chosen = mosques.find((mosque) => mosque.name !== nearest.name)!;
    const restricted = applySelection(SOKA, 0, index, {
      byParameter: { ...DEFAULT_SELECTION.byParameter, poi2: [chosen.id] },
    });
    expect(restricted.poi2?.name).toBe(chosen.name);
  });

  it("clears a parameter when its selection is empty", () => {
    const out = applySelection(SOKA, 0, index, {
      byParameter: { ...DEFAULT_SELECTION.byParameter, poi1: [] },
    });
    expect(out.poi1).toBeUndefined();
  });
});

describe("describeSelection", () => {
  it("summarises the current choice", () => {
    expect(describeSelection(DEFAULT_SELECTION, "station", PLACE_CATALOG)).toBe("nearest of all");
    const one = placesInCategory("station")[0];
    expect(
      describeSelection(
        { byParameter: { ...DEFAULT_SELECTION.byParameter, station: [one.id] } },
        "station",
        PLACE_CATALOG,
      ),
    ).toContain(one.name);
  });
});

describe("place catalog", () => {
  it("gives every place a unique id", () => {
    const ids = new Set(PLACE_CATALOG.places.map((p) => p.id));
    expect(ids.size).toBe(PLACE_CATALOG.places.length);
  });
});
