import { describe, expect, it } from "vitest";
import type { LegacyReferenceData } from "./legacyReference";
import { LegacyReferenceMigrationError, migrateLegacyReferenceData } from "./legacyReference";

const closedRing = [
  [139.7, 35.8],
  [139.8, 35.8],
  [139.8, 35.9],
  [139.7, 35.8],
] as const;

function fixture(): LegacyReferenceData {
  return {
    pois: [
      { id: "school", name: "School", nameJa: "学校", address: "address", lat: 35.81, lon: 139.71 },
      { id: "mosque-target", name: "Mosque", nameJa: "モスク", address: "address", lat: 35.82, lon: 139.72 },
      { id: "park", name: "Park", nameJa: "公園", address: "address", lat: 35.83, lon: 139.73 },
    ],
    mosques: [{ name: "Mosque A", lat: 35.84, lon: 139.74, source: "fixture" }],
    stations: [{ name: "Station", lat: 35.85, lon: 139.75, nameEn: "Station", operator: null }],
    schools: [{ name: "Elementary", lat: 35.86, lon: 139.76 }],
    childcare: [{ name: "Kindergarten", lat: 35.87, lon: 139.77, type: "kindergarten" }],
    busStops: [{ name: "Bus stop", lat: 35.88, lon: 139.78 }],
    sokaBoundary: closedRing,
    neighborBoundaries: [{ name: "新しい市", ring: closedRing }],
  };
}

describe("legacy reference-data migration", () => {
  it("builds versioned variable-size city, boundary, and place datasets", () => {
    const migrated = migrateLegacyReferenceData(fixture(), "2026-09-25T00:00:00.000Z");

    expect(migrated.cities.schemaVersion).toBe(1);
    expect(migrated.cities.records.map((city) => city.nameLocal)).toEqual(["新しい市", "草加市"]);
    expect(migrated.boundaries.records).toHaveLength(2);
    expect(migrated.places.records.filter((place) => place.category === "poi")).toHaveLength(3);
    expect(migrated.places.records.map((place) => place.category).sort()).toEqual([
      "busStop", "childcare", "mosque", "poi", "poi", "poi", "school", "station",
    ]);
    expect(migrated.places.records.find((place) => place.name === "School")?.attributes).toMatchObject({
      legacyId: "school",
      legacyRole: "school",
    });
    expect(migrated.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("assigns place IDs from record identity, independent of input ordering", () => {
    const input = fixture();
    const reversed = { ...input, pois: [...input.pois].reverse() };
    const first = migrateLegacyReferenceData(input, "2026-09-25T00:00:00.000Z");
    const second = migrateLegacyReferenceData(reversed, "2026-09-25T00:00:00.000Z");

    expect(first.places.records.map((place) => place.id)).toEqual(second.places.records.map((place) => place.id));
    expect(first.places.revision).toBe(second.places.revision);
  });

  it("rejects duplicate identities and malformed boundaries rather than dropping records", () => {
    const input = fixture();
    const duplicate = { ...input, mosques: [...input.mosques, input.mosques[0]] };
    expect(() => migrateLegacyReferenceData(duplicate, "2026-09-25T00:00:00.000Z")).toThrow(
      "Duplicate places record ID",
    );
    expect(() => migrateLegacyReferenceData({ ...input, sokaBoundary: closedRing.slice(0, 3) }, "2026-09-25T00:00:00.000Z")).toThrow(
      LegacyReferenceMigrationError,
    );
  });

  it("rejects invalid migration timestamps", () => {
    expect(() => migrateLegacyReferenceData(fixture(), "not-a-time")).toThrow("updatedAt must be a valid timestamp");
  });
});
