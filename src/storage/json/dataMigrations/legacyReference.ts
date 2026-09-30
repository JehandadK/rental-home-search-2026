import { createHash } from "node:crypto";
import type {
  BoundaryGeometry,
  CityBoundaryRecord,
  CityRecord,
  ReferenceDataSnapshot,
  ReferencePlaceRecord,
  VersionedDataset,
} from "../../../data-layer/contracts";
import { catalogRevision } from "../referenceCatalog";
import type {
  ChildcareFacility,
  Mosque,
  NamedPlace,
  PointOfInterest,
  Station,
} from "../../../domain/types";

export interface LegacyReferenceData {
  pois: readonly PointOfInterest[];
  mosques: readonly Mosque[];
  stations: readonly Station[];
  schools: readonly NamedPlace[];
  childcare: readonly ChildcareFacility[];
  busStops: readonly NamedPlace[];
  sokaBoundary: readonly (readonly [number, number])[];
  neighborBoundaries: readonly { name: string; ring: readonly (readonly [number, number])[] }[];
}

export class LegacyReferenceMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyReferenceMigrationError";
  }
}

/** Convert the existing collection of JSON files into version-1 managed datasets. */
export function migrateLegacyReferenceData(
  legacy: LegacyReferenceData,
  updatedAt: string,
): ReferenceDataSnapshot {
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new LegacyReferenceMigrationError("updatedAt must be a valid timestamp");
  }

  const cities = new Map<string, CityRecord>();
  const boundaries: CityBoundaryRecord[] = [];
  const soka = addCityAndBoundary("草加市", legacy.sokaBoundary, "legacy:soka_boundary.json", updatedAt);
  cities.set(soka.city.id, soka.city);
  boundaries.push(soka.boundary);

  for (const boundary of legacy.neighborBoundaries) {
    const converted = addCityAndBoundary(boundary.name, boundary.ring, "legacy:neighbor_boundaries.json", updatedAt);
    cities.set(converted.city.id, converted.city);
    boundaries.push(converted.boundary);
  }

  const places: ReferencePlaceRecord[] = [
    ...legacy.pois.map((place) => convertPlace("poi", place, updatedAt, {
      nameLocal: place.nameJa,
      address: place.address,
      // Retain the old scoring role as metadata; it is not the new record ID.
      attributes: { legacyId: place.id, legacyRole: place.id },
      stableKey: place.id,
    })),
    ...legacy.mosques.map((place) => convertPlace("mosque", place, updatedAt, {
      nameLocal: place.nameJa,
      address: place.address,
      attributes: place.source ? { source: place.source } : {},
    })),
    ...legacy.stations.map((place) => convertPlace("station", place, updatedAt, {
      attributes: { nameEn: place.nameEn, operator: place.operator },
    })),
    ...legacy.schools.map((place) => convertPlace("school", place, updatedAt)),
    ...legacy.childcare.map((place) => convertPlace("childcare", place, updatedAt, {
      subtitle: place.type,
      attributes: { facilityType: place.type },
    })),
    ...legacy.busStops.map((place) => convertPlace("busStop", place, updatedAt)),
  ];
  assertUniqueIds("places", places);
  assertUniqueIds("boundaries", boundaries);

  const cityRecords = [...cities.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedBoundaries = [...boundaries].sort((a, b) => a.id.localeCompare(b.id));
  const sortedPlaces = [...places].sort((a, b) => a.id.localeCompare(b.id));
  const provenance = {
    migration: "legacy-json-to-reference-v1",
    sourceFiles: [
      "pois.json",
      "mosques.json",
      "stations.json",
      "elementary_schools.json",
      "kindergartens.json",
      "bus_stops.json",
      "soka_boundary.json",
      "neighbor_boundaries.json",
    ],
  };
  const cityDataset = dataset("cities", cityRecords, updatedAt, provenance);
  const boundaryDataset = dataset("boundaries", sortedBoundaries, updatedAt, provenance);
  const placeDataset = dataset("places", sortedPlaces, updatedAt, provenance);

  return {
    revision: catalogRevision({
      datasets: {
        cities: { file: "cities.json", schemaVersion: cityDataset.schemaVersion, revision: cityDataset.revision, count: cityDataset.records.length },
        boundaries: { file: "boundaries.json", schemaVersion: boundaryDataset.schemaVersion, revision: boundaryDataset.revision, count: boundaryDataset.records.length },
        places: { file: "places.json", schemaVersion: placeDataset.schemaVersion, revision: placeDataset.revision, count: placeDataset.records.length },
      },
    }),
    cities: cityDataset,
    boundaries: boundaryDataset,
    places: placeDataset,
  };
}

function addCityAndBoundary(
  localName: string,
  ring: readonly (readonly [number, number])[],
  source: string,
  updatedAt: string,
): { city: CityRecord; boundary: CityBoundaryRecord } {
  const city = cityRecord(localName, updatedAt);
  validateRing(ring, localName);
  const geometry: BoundaryGeometry = {
    type: "Polygon",
    coordinates: [ring.map(([lon, lat]) => [lon, lat] as const)],
  };
  return {
    city,
    boundary: {
      id: `boundary:${city.id}:legacy`,
      cityId: city.id,
      geometry,
      source,
      status: "active",
      updatedAt,
    },
  };
}

function cityRecord(localName: string, updatedAt: string): CityRecord {
  const known: Record<string, { id: string; name: string; prefecture: string }> = {
    "草加市": { id: "city:soka", name: "Soka", prefecture: "埼玉県" },
    "越谷市": { id: "city:koshigaya", name: "Koshigaya", prefecture: "埼玉県" },
    "川口市": { id: "city:kawaguchi", name: "Kawaguchi", prefecture: "埼玉県" },
    "八潮市": { id: "city:yashio", name: "Yashio", prefecture: "埼玉県" },
    "足立区": { id: "city:adachi", name: "Adachi", prefecture: "東京都" },
  };
  const identity: { id: string; name: string; prefecture?: string } = known[localName] ?? {
    id: `city:${digest(localName).slice(0, 16)}`,
    name: localName,
  };
  return {
    id: identity.id,
    name: identity.name,
    nameLocal: localName,
    ...(identity.prefecture ? { prefecture: identity.prefecture } : {}),
    status: "active",
    updatedAt,
  };
}

function convertPlace(
  category: string,
  place: NamedPlace,
  updatedAt: string,
  extra: {
    nameLocal?: string;
    address?: string;
    subtitle?: string;
    attributes?: Readonly<Record<string, string | number | boolean | null>>;
    stableKey?: string;
  } = {},
): ReferencePlaceRecord {
  if (!place.name.trim() || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
    throw new LegacyReferenceMigrationError(`Invalid ${category} record: ${place.name || "<unnamed>"}`);
  }
  const stableKey = extra.stableKey ?? [
    category,
    place.name.normalize("NFKC").replace(/\s+/g, " ").trim(),
    extra.address ?? "",
    place.lat,
    place.lon,
    JSON.stringify(extra.attributes ?? {}),
  ].join("\u0000");
  return {
    id: `${category}:${digest(stableKey).slice(0, 20)}`,
    category,
    name: place.name,
    ...(extra.nameLocal ? { nameLocal: extra.nameLocal } : {}),
    ...(extra.address ? { address: extra.address } : {}),
    lat: place.lat,
    lon: place.lon,
    ...(extra.subtitle ? { subtitle: extra.subtitle } : {}),
    ...(extra.attributes && Object.keys(extra.attributes).length ? { attributes: extra.attributes } : {}),
    status: "active",
    updatedAt,
  };
}

function dataset<T>(
  datasetId: string,
  records: readonly T[],
  updatedAt: string,
  provenance: Readonly<Record<string, unknown>>,
): VersionedDataset<T> {
  return {
    datasetId,
    schemaVersion: 1,
    revision: digest(JSON.stringify(records)),
    updatedAt,
    provenance,
    records,
  };
}

function validateRing(ring: readonly (readonly [number, number])[], name: string): void {
  if (ring.length < 4) throw new LegacyReferenceMigrationError(`Boundary ${name} needs at least four positions`);
  for (const [lon, lat] of ring) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new LegacyReferenceMigrationError(`Boundary ${name} has an invalid position`);
    }
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new LegacyReferenceMigrationError(`Boundary ${name} ring is not closed`);
  }
}

function assertUniqueIds<T extends { id: string }>(datasetId: string, records: readonly T[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) throw new LegacyReferenceMigrationError(`Duplicate ${datasetId} record ID: ${record.id}`);
    seen.add(record.id);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
