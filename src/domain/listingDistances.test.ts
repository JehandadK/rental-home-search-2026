import { describe, expect, it } from "vitest";
import { formatKm, listingDistances } from "./listingDistances";
import type { CatalogPlace } from "./places";
import type { EnrichedListing } from "./types";

const poi = (name: string, lat: number, lon: number): CatalogPlace =>
  ({ id: `poi:${name}`, recordId: name, category: "poi", name, lat, lon });

const alSanad = poi("Al Sanad School Japan", 35.846389, 139.7767021);
const baitulAman = poi("Baitul Aman Masjid", 35.86, 139.79);

const listing = (overrides: Partial<EnrichedListing> = {}): EnrichedListing => ({
  name: "Test home",
  address: "草加市",
  rent: 100_000,
  source: "suumo",
  geocoded: true,
  lat: 35.828252,
  lon: 139.803362,
  ...overrides,
} as EnrichedListing);

const options = { pois: [baitulAman, alSanad], targetPoiId: alSanad.id, walkSpeedMPerMin: 80, detourFactor: 1.3 };

describe("listingDistances", () => {
  it("lists the target POI first, then the other POIs, with km and walking minutes", () => {
    const rows = listingDistances(listing(), options);
    expect(rows.map((row) => row.label)).toEqual(["Al Sanad School Japan", "Baitul Aman Masjid"]);
    expect(rows[0].distM).toBeGreaterThan(2900);
    expect(rows[0].distM).toBeLessThan(3300);
    expect(rows[0].walkMin).toBeCloseTo((rows[0].distM * 1.3) / 80, 5);
  });

  it("adds the nearest places the scoring measures, skipping ones already listed as POIs", () => {
    const rows = listingDistances(listing({
      poi2: { name: "Baitul Aman Masjid", distM: 4000, walkMin: 65 },
      station: { name: "草加", distM: 400, walkMin: 6.5 },
      school: { name: "草加小学校", distM: 800, walkMin: 13 },
      kindergarten: { name: "草加幼稚園", distM: 600, walkMin: 9.8 },
      childcareAny: { name: "草加保育園", distM: 200, walkMin: 3.3 },
      busStop: { name: "草加駅東口", distM: 100, walkMin: 1.6 },
    }), options);
    expect(rows.map((row) => [row.label, row.place])).toEqual([
      ["Al Sanad School Japan", undefined],
      ["Baitul Aman Masjid", undefined],
      ["Station", "草加"],
      ["School", "草加小学校"],
      ["Kindergarten", "草加幼稚園"],
      ["Bus stop", "草加駅東口"],
    ]);
  });

  it("measures childcare to any facility when 保育園 count", () => {
    const rows = listingDistances(listing({
      kindergarten: { name: "草加幼稚園", distM: 600, walkMin: 9.8 },
      childcareAny: { name: "草加保育園", distM: 200, walkMin: 3.3 },
    }), { ...options, includeHoikuen: true });
    expect(rows.find((row) => row.key === "childcare")).toMatchObject({ label: "Childcare", place: "草加保育園" });
  });

  it("uses the advertised station walk only when it describes the measured station", () => {
    const station = { name: "草加", distM: 400, walkMin: 6.5 };
    const matching = listingDistances(listing({ station, advertisedStation: "草加駅", stationWalkMin: 9 }), options);
    expect(matching.find((row) => row.key === "station")).toMatchObject({ walkMin: 9, advertised: true });

    const other = listingDistances(listing({ station, advertisedStation: "谷塚駅", stationWalkMin: 9 }), options);
    expect(other.find((row) => row.key === "station")).toMatchObject({ walkMin: 6.5 });
    expect(other.find((row) => row.key === "station")?.advertised).toBeUndefined();
  });

  it("has nothing to measure for an ungeocoded listing", () => {
    expect(listingDistances(listing({ lat: undefined, lon: undefined }), options)).toEqual([]);
  });
});

describe("formatKm", () => {
  it("rounds to a tenth of a kilometre", () => {
    expect(formatKm(380)).toBe("0.4 km");
    expect(formatKm(2345)).toBe("2.3 km");
  });
});
