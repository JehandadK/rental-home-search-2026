import { describe, expect, it } from "vitest";
import type { BoundaryGeometry } from "../domain/referenceData";
import type { CityBoundaryRecord, CityRecord, ReferencePlaceRecord } from "./contracts";
import { planReferenceImport, RAIL_STATION_CATEGORY, type CurrentReference, type ReferenceImport } from "./referenceImport";

const T0 = "2026-09-25T00:00:00.000Z";
const T1 = "2026-10-04T00:00:00.000Z";
const T2 = "2026-10-05T00:00:00.000Z";
const square = (lon: number, lat: number): BoundaryGeometry =>
  ({ type: "Polygon", coordinates: [[[lon, lat], [lon + 0.1, lat], [lon + 0.1, lat + 0.1], [lon, lat + 0.1], [lon, lat]]] });

const soka: CityRecord = { id: "city:soka", name: "Soka", nameLocal: "草加市", prefecture: "埼玉県", status: "active", updatedAt: T0 };
const legacyBoundary: CityBoundaryRecord = { id: "boundary:city:soka:legacy", cityId: "city:soka", geometry: square(139.7, 35.8), status: "active", updatedAt: T0 };
const scoredStation: ReferencePlaceRecord = {
  id: "station:abc", category: "station", name: "草加", lat: 35.828, lon: 139.803,
  attributes: { appPlaceId: "station:草加", appOrder: 0 }, status: "active", updatedAt: T0,
};
const current: CurrentReference = { cities: [soka], boundaries: [legacyBoundary], places: [scoredStation] };

const input: ReferenceImport = {
  boundaryEdition: "N03-20260101",
  stationEdition: "N02-25",
  municipalities: [
    { code: "11221", prefecture: "埼玉県", name: "草加市", geometry: square(139.78, 35.8) },
    { code: "11222", prefecture: "埼玉県", name: "越谷市", geometry: square(139.78, 35.9) },
  ],
  stations: [
    { groupCode: "003040", name: "草加", lat: 35.8284, lon: 139.8035, operators: ["東武鉄道"], lines: [{ operator: "東武鉄道", line: "伊勢崎線" }], municipalityCode: "11221" },
    { groupCode: "002958", name: "南越谷", lat: 35.876, lon: 139.791, operators: ["東日本旅客鉄道"], lines: [{ operator: "東日本旅客鉄道", line: "武蔵野線" }], municipalityCode: "11222" },
  ],
};

/** Apply a plan to the current records, as the catalog would. */
function apply(state: CurrentReference, plan: ReturnType<typeof planReferenceImport>): CurrentReference {
  const merge = <T extends { id: string; status: string }>(records: readonly T[], upsert: readonly T[], retire: readonly { id: string }[] = []) => {
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const record of upsert) byId.set(record.id, record);
    for (const { id } of retire) byId.set(id, { ...byId.get(id)!, status: "retired" });
    return [...byId.values()];
  };
  return {
    cities: merge(state.cities, plan.cities.upsert),
    boundaries: merge(state.boundaries, plan.boundaries.upsert, plan.boundaries.retire),
    places: merge(state.places, plan.places.upsert, plan.places.retire),
  };
}

describe("reference import plan", () => {
  const plan = planReferenceImport(current, input, T1);

  it("keeps an existing city and adds new ones under their municipality code", () => {
    expect(plan.cities.upsert.map((city) => [city.id, city.name, city.prefecture])).toEqual([["city:jp-11222", "越谷市", "埼玉県"]]);
  });

  it("gives every city an edition boundary and retires the one it replaces", () => {
    expect(plan.boundaries.upsert.map((boundary) => [boundary.id, boundary.cityId, boundary.source])).toEqual([
      ["boundary:city:soka:n03-20260101", "city:soka", "ksj:N03-20260101"],
      ["boundary:city:jp-11222:n03-20260101", "city:jp-11222", "ksj:N03-20260101"],
    ]);
    expect(plan.boundaries.retire?.map((retirement) => retirement.id)).toEqual(["boundary:city:soka:legacy"]);
  });

  it("adds stations as map-only rail stations with pinned app ids, leaving scored stations alone", () => {
    expect(plan.places.upsert.map((place) => [place.id, place.category, place.attributes?.appPlaceId, place.attributes?.appOrder]))
      .toEqual([
        ["railStation:003040", RAIL_STATION_CATEGORY, "railStation:草加", 1],
        ["railStation:002958", RAIL_STATION_CATEGORY, "railStation:南越谷", 2],
      ]);
    expect(plan.places.upsert[1].attributes).toMatchObject({ cityId: "city:jp-11222", lineCount: 1, source: "ksj:N02-25", lines: "東日本旅客鉄道 武蔵野線" });
    expect(plan.places.upsert.some((place) => place.id === scoredStation.id)).toBe(false);
  });

  it("is a no-op when the same edition is imported again", () => {
    const again = planReferenceImport(apply(current, plan), input, T2);
    expect(again.cities.upsert).toEqual([]);
    expect(again.boundaries).toEqual({ upsert: [], retire: [] });
    expect(again.places).toEqual({ upsert: [], retire: [] });
  });

  it("retires imported stations a later edition no longer has, keeping pins on the rest", () => {
    const later = planReferenceImport(apply(current, plan), { ...input, stationEdition: "N02-26", stations: input.stations.slice(0, 1) }, T2);
    expect(later.places.retire?.map((retirement) => retirement.id)).toEqual(["railStation:002958"]);
    expect(later.places.upsert.map((place) => [place.id, place.attributes?.appPlaceId, place.attributes?.source]))
      .toEqual([["railStation:003040", "railStation:草加", "ksj:N02-26"]]);
  });
});
