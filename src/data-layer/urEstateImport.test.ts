import { describe, expect, it } from "vitest";
import type { UrEstateObservation } from "../domain/ur";
import type { CityRecord, ReferencePlaceRecord } from "./contracts";
import { planUrEstateImport } from "./urEstateImport";

const at = "2026-10-09T05:00:00.000Z";
const cities: CityRecord[] = [
  { id: "city:soka", name: "Soka", nameLocal: "草加市", code: "11221", status: "active", updatedAt: at },
  { id: "city:kawaguchi", name: "Kawaguchi", nameLocal: "川口市", code: "11203", status: "active", updatedAt: at },
];
const estate = (code: string, vacantRooms: number, cityCode = "11221"): UrEstateObservation => ({
  code, name: `団地${code}`, address: `埼玉県草加市${code}`, cityCode, lat: 35.84, lon: 139.8,
  url: `https://www.ur-net.go.jp/chintai/kanto/saitama/${code}.html`, vacantRooms, checkedAt: at,
  vacantRentMin: vacantRooms ? 100_000 : null, vacantRentMax: vacantRooms ? 120_000 : null, floors: 14, structure: "鉄筋コンクリート造",
});
const apply = (current: ReferencePlaceRecord[], plan: ReturnType<typeof planUrEstateImport>) => {
  const byId = new Map(current.map((place) => [place.id, place]));
  for (const record of plan.places.upsert) byId.set(record.id, record);
  for (const retired of plan.places.retire ?? []) byId.set(retired.id, { ...byId.get(retired.id)!, status: "retired", retirementReason: retired.reason });
  return [...byId.values()];
};

describe("UR estate import", () => {
  it("adds every estate of a swept city as a pinned urDanchi place, vacant or not", () => {
    const plan = planUrEstateImport([], cities, [estate("50_4090", 1), estate("50_3880", 0)], ["11221"], at);
    expect(plan.places.upsert).toHaveLength(2);
    expect(plan.places.upsert[0]).toMatchObject({
      id: "urDanchi:50_4090", category: "urDanchi", name: "団地50_4090", subtitle: "UR賃貸 · 草加市", status: "active",
      attributes: { urCode: "50_4090", cityId: "city:soka", floors: 14, source: "UR都市機構" },
    });
    expect(plan.places.upsert.every((record) => typeof record.attributes?.appPlaceId === "string")).toBe(true);
    expect(plan.places.retire).toEqual([]);
  });

  it("keeps vacancies out of the catalog, so a later sweep rewrites only what UR changed", () => {
    const first = apply([], planUrEstateImport([], cities, [estate("50_4090", 1)], ["11221"], at));
    expect(first[0].attributes).not.toHaveProperty("vacantRooms");
    const later = "2026-10-10T05:00:00.000Z";
    expect(planUrEstateImport(first, cities, [{ ...estate("50_4090", 0), checkedAt: later }], ["11221"], later).places.upsert).toEqual([]);
    const moved = planUrEstateImport(first, cities, [{ ...estate("50_4090", 0), floors: 15 }], ["11221"], later);
    expect(moved.places.upsert[0].attributes).toMatchObject({ floors: 15, appPlaceId: first[0].attributes?.appPlaceId });
  });

  it("retires an estate UR no longer lists, only in a swept city", () => {
    const held = apply([], planUrEstateImport([], cities, [estate("50_4090", 1), estate("50_1340", 0), estate("50_1820", 0, "11203")], ["11221", "11203"], at));
    const plan = planUrEstateImport(held, cities, [estate("50_4090", 1)], ["11221"], at);
    expect(plan.places.retire?.map((retired) => retired.id)).toEqual(["urDanchi:50_1340"]);
  });

  it("skips an estate whose city is not in the catalog", () => {
    const plan = planUrEstateImport([], cities, [estate("50_1390", 0, "11234")], ["11234"], at);
    expect(plan.places.upsert).toEqual([]);
    expect(plan.unknownCity.map((unknown) => unknown.code)).toEqual(["50_1390"]);
  });
});
