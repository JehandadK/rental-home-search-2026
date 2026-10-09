import { describe, expect, it } from "vitest";
import type { ReferencePlaceRecord } from "./contracts";
import { MASJID_LIST_SOURCE, planMasjidImport, type MasjidListImport } from "./masjidImport";

const T0 = "2026-09-25T00:00:00.000Z";
const T1 = "2026-10-04T00:00:00.000Z";
const T2 = "2026-10-05T00:00:00.000Z";

const curated: ReferencePlaceRecord = {
  id: "mosque:yashio", category: "mosque", name: "Yashio Masjid", lat: 35.7978, lon: 139.8284,
  attributes: { source: "Google Maps place pin", appPlaceId: "mosque:Yashio Masjid", appOrder: 5 }, status: "active", updatedAt: T0,
};
const listEntry = (id: string, name: string, extra: Record<string, string | number> = {}): ReferencePlaceRecord => ({
  id, category: "mosque", name, lat: 35.8, lon: 139.8,
  attributes: { source: MASJID_LIST_SOURCE, googleFeatureId: `0x1:0x${id.length}`, ...extra }, status: "active", updatedAt: T1,
});
const list: MasjidListImport = {
  listId: "LIST1",
  records: [
    listEntry("mosque:g-yashio", "Yashio Masjid", { catalogMatchId: "mosque:yashio", catalogMatchName: "Yashio Masjid", catalogMatchDistM: 2 }),
    listEntry("mosque:g-misato", "Misato Mosque"),
    listEntry("mosque:g-abrar", "Masjid Al Abrar"),
  ],
};

function apply(current: readonly ReferencePlaceRecord[], plan: ReturnType<typeof planMasjidImport>): ReferencePlaceRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of plan.places.upsert) byId.set(record.id, record);
  for (const { id } of plan.places.retire ?? []) byId.set(id, { ...byId.get(id)!, status: "retired" });
  return [...byId.values()];
}

describe("planMasjidImport", () => {
  it("adds list mosques to the scored set, skipping ones the catalog already has", () => {
    const plan = planMasjidImport([curated], list, T1);
    expect(plan.matched.map((match) => match.catalogId)).toEqual(["mosque:yashio"]);
    expect(plan.places.upsert.map((record) => record.name)).toEqual(["Misato Mosque", "Masjid Al Abrar"]);
    const misato = plan.places.upsert[0];
    expect(misato.category).toBe("mosque");
    expect(misato.attributes).toMatchObject({ appPlaceId: "mosque:Misato Mosque", appOrder: 6, googleListId: "LIST1" });
    expect(misato.attributes).not.toHaveProperty("catalogMatchId");
    expect(plan.places.retire).toEqual([]);
  });

  it("is a no-op when re-run, keeping the pinned ids", () => {
    const once = apply([curated], planMasjidImport([curated], list, T1));
    const again = planMasjidImport(once, list, T2);
    expect(again.places.upsert).toEqual([]);
    expect(again.places.retire).toEqual([]);
  });

  it("retires list mosques that left the list, never the hand-picked ones", () => {
    const once = apply([curated], planMasjidImport([curated], list, T1));
    const shorter = { ...list, records: list.records.filter((record) => record.name !== "Masjid Al Abrar") };
    const plan = planMasjidImport(once, shorter, T2);
    expect(plan.places.upsert).toEqual([]);
    expect(plan.places.retire?.map((retirement) => retirement.id)).toEqual(["mosque:g-abrar"]);
  });

  it("retires an entry saved as retired, with its reason, and never re-imports it", () => {
    const once = apply([curated], planMasjidImport([curated], list, T1));
    const reason = "Duplicate pin";
    const edited = {
      ...list,
      records: list.records.map((record) => record.name === "Masjid Al Abrar"
        ? { ...record, status: "retired" as const, retiredAt: T2, retirementReason: reason }
        : record),
    };
    const plan = planMasjidImport(once, edited, T2);
    expect(plan.places.upsert).toEqual([]);
    expect(plan.places.retire).toEqual([{ id: "mosque:g-abrar", effectiveAt: T2, reason }]);
    expect(planMasjidImport(apply(once, plan), edited, T2).places).toEqual({ upsert: [], retire: [] });
    // A fresh catalog never receives it.
    expect(planMasjidImport([curated], edited, T1).places.upsert.map((record) => record.name)).toEqual(["Misato Mosque"]);
  });

  it("imports a matched entry when its catalog mosque has been retired", () => {
    const plan = planMasjidImport([{ ...curated, status: "retired" }], list, T1);
    expect(plan.matched).toEqual([]);
    expect(plan.places.upsert.map((record) => record.id)).toContain("mosque:g-yashio");
  });
});
