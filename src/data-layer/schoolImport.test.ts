import { describe, expect, it } from "vitest";
import type { ReferencePlaceRecord } from "./contracts";
import { planSchoolImport } from "./schoolImport";

const T0 = "2026-09-30T00:00:00.000Z";
const T1 = "2026-11-18T00:00:00.000Z";
const T2 = "2026-11-19T00:00:00.000Z";

const migrated: ReferencePlaceRecord = {
  id: "school:07b3", category: "school", name: "越谷市立蒲生小学校", lat: 35.869169, lon: 139.797818,
  attributes: { appPlaceId: "school:越谷市立蒲生小学校", appOrder: 76 }, status: "active", updatedAt: T0,
};
const entry = (id: string, category: string, name: string, lat: number, lon: number, extra: Record<string, string> = {}): ReferencePlaceRecord => ({
  id, category, name, lat, lon, attributes: { source: "OpenStreetMap", cityId: "city:koshigaya", ...extra }, status: "active", updatedAt: T1,
});
const list: ReferencePlaceRecord[] = [
  // The catalog's own school, a few metres off.
  entry("school:osm-way-1", "school", "越谷市立蒲生小学校", 35.86918, 139.79783),
  entry("school:osm-way-2", "school", "越谷市立桜井小学校", 35.9412, 139.7871),
  entry("childcare:osm-node-3", "childcare", "まどか幼稚園", 35.9565, 139.7805, { facilityType: "kindergarten" }),
];

function apply(current: readonly ReferencePlaceRecord[], plan: ReturnType<typeof planSchoolImport>): ReferencePlaceRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of plan.places.upsert) byId.set(record.id, record);
  return [...byId.values()];
}

describe("planSchoolImport", () => {
  it("adds the schools and childcare the catalog lacks, pinned after the existing places", () => {
    const plan = planSchoolImport([migrated], list, T1);
    expect(plan.matched).toEqual([{ record: list[0], catalogId: "school:07b3" }]);
    expect(plan.places.upsert.map((record) => record.name)).toEqual(["越谷市立桜井小学校", "まどか幼稚園"]);
    expect(plan.places.upsert[0].attributes).toMatchObject({ appPlaceId: "school:越谷市立桜井小学校", appOrder: 77, cityId: "city:koshigaya" });
    expect(plan.places.upsert[1].attributes).toMatchObject({ appPlaceId: "childcare:まどか幼稚園", appOrder: 78, facilityType: "kindergarten" });
    expect(plan.places.retire).toBeUndefined();
  });

  it("is a no-op when re-run, keeping the pinned ids", () => {
    const once = apply([migrated], planSchoolImport([migrated], list, T1));
    expect(planSchoolImport(once, list, T2).places.upsert).toEqual([]);
  });

  it("imports a same-named place somewhere else as its own place", () => {
    const far = entry("school:osm-way-9", "school", "越谷市立蒲生小学校", 35.95, 139.76);
    const plan = planSchoolImport([migrated], [far], T1);
    expect(plan.matched).toEqual([]);
    expect(plan.places.upsert[0].attributes).toMatchObject({ appPlaceId: "school:越谷市立蒲生小学校#1" });
  });

  it("updates an imported place when the list moves it, keeping its app id", () => {
    const once = apply([migrated], planSchoolImport([migrated], list, T1));
    const moved = list.map((record) => (record.id === "school:osm-way-2" ? { ...record, lat: 35.9413 } : record));
    const plan = planSchoolImport(once, moved, T2);
    expect(plan.places.upsert).toHaveLength(1);
    expect(plan.places.upsert[0]).toMatchObject({ id: "school:osm-way-2", lat: 35.9413, updatedAt: T2 });
    expect(plan.places.upsert[0].attributes).toMatchObject({ appPlaceId: "school:越谷市立桜井小学校", appOrder: 77 });
  });

  it("rejects records of another category", () => {
    expect(() => planSchoolImport([], [entry("mosque:x", "mosque", "Masjid", 35.8, 139.8)], T1)).toThrow(/not a school or childcare/);
  });
});
