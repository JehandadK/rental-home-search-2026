/**
 * Small reference snapshots and listings for UI tests (a shared test
 * harness, so production code may not import it).
 */
import type { CityBoundaryRecord, CityRecord, ReferenceDataSnapshot, ReferencePlaceRecord, VersionedDataset } from "../../data-layer/contracts";
import type { EnrichedListing } from "../../domain/types";

const AT = "2026-09-30T00:00:00.000Z";

const dataset = <T>(datasetId: string, records: T[]): VersionedDataset<T> =>
  ({ datasetId, schemaVersion: 1, revision: `${datasetId}:${records.length}`, updatedAt: AT, records });

export const city = (id: string, name: string, nameLocal?: string): CityRecord =>
  ({ id, name, ...(nameLocal ? { nameLocal } : {}), status: "active", updatedAt: AT });

const square = (lon: number, lat: number, size: number) =>
  [[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]] as const;

export const polygon = (id: string, cityId: string, lon: number, lat: number): CityBoundaryRecord =>
  ({ id, cityId, geometry: { type: "Polygon", coordinates: [square(lon, lat, 0.05)] }, status: "active", updatedAt: AT });

export const multipolygon = (id: string, cityId: string, lon: number, lat: number): CityBoundaryRecord => ({
  id,
  cityId,
  geometry: { type: "MultiPolygon", coordinates: [[square(lon, lat, 0.04)], [square(lon + 0.06, lat, 0.02)]] },
  status: "active",
  updatedAt: AT,
});

export const place = (
  id: string,
  category: string,
  name: string,
  lat: number,
  lon: number,
  extra: Partial<ReferencePlaceRecord> = {},
): ReferencePlaceRecord => ({ id, category, name, lat, lon, status: "active", updatedAt: AT, ...extra });

export function snapshot(parts: {
  cities?: CityRecord[];
  boundaries?: CityBoundaryRecord[];
  places?: ReferencePlaceRecord[];
}): ReferenceDataSnapshot {
  const cities = parts.cities ?? [];
  const boundaries = parts.boundaries ?? [];
  const places = parts.places ?? [];
  return {
    revision: `fixture:${cities.length}:${boundaries.length}:${places.length}`,
    cities: dataset("cities", cities),
    boundaries: dataset("boundaries", boundaries),
    places: dataset("places", places),
  };
}

/** Two cities (one a multipolygon), a target POI, a mosque, a station, and a school. */
export const FIXTURE_REFERENCE = snapshot({
  cities: [city("city:soka", "Soka", "草加市"), city("city:koshigaya", "Koshigaya", "越谷市")],
  boundaries: [polygon("b:soka", "city:soka", 139.78, 35.8), multipolygon("b:koshigaya", "city:koshigaya", 139.78, 35.86)],
  places: [
    place("p:school", "poi", "Test School", 35.82, 139.8, { attributes: { legacyRole: "poi1" } }),
    place("p:mosque", "mosque", "Test Masjid", 35.87, 139.8),
    place("p:station", "station", "草加", 35.828, 139.803, { subtitle: "東武" }),
    place("p:elementary", "school", "草加小学校", 35.83, 139.81),
  ],
});

export const fixtureListing = (name: string, over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  name,
  address: "埼玉県草加市高砂1-1",
  city: "Soka",
  rent: 90_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2012,
  stationWalkMin: 7,
  url: null,
  source: "fixture",
  geocoded: true,
  lat: 35.825,
  lon: 139.805,
  ...over,
});

export const FIXTURE_LISTINGS: EnrichedListing[] = [
  fixtureListing("Fixture House A"),
  fixtureListing("Fixture House B", { rent: 120_000, lat: 35.87, lon: 139.79, city: "Koshigaya", address: "埼玉県越谷市1-1" }),
];
