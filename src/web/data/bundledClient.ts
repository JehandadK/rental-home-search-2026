/**
 * Static web data client over the bundled data files.
 *
 * This is the compatibility path while the app moves to fetched assets: it
 * turns the original reference files into a reference snapshot and returns
 * the bundled listing payload, through the same `WebDataClient` interface a
 * runtime client implements.
 */
import type { CityBoundaryRecord, CityRecord, ReferenceDataSnapshot, ReferencePlaceRecord, VersionedDataset } from "../../data-layer/contracts";
import type { ReadResult, WebDataClient, ListingQueryResult } from "../../data-layer/read/contracts";
import type { ChildcareFacility, EnrichedListing, Mosque, NamedPlace, PointOfInterest, Station } from "../../domain/types";
import { buildReferenceModel, type ReferenceModel } from "../../domain/referenceData";
import { unpackListings, type WebPayload } from "../../domain/webPayload";
import poisJson from "../../data/pois.json";
import stationsJson from "../../data/stations.json";
import schoolsJson from "../../data/elementary_schools.json";
import kindergartensJson from "../../data/kindergartens.json";
import busStopsJson from "../../data/bus_stops.json";
import boundaryJson from "../../data/soka_boundary.json";
import neighborBoundariesJson from "../../data/neighbor_boundaries.json";
// Browser-optimized derivative: baked nearest-place fields are omitted because
// ProximityIndex computes them for the user's current place selection.
import listingsJson from "../../data/listings_web.json";
import mosquesJson from "../../data/mosques.json";

const UPDATED_AT = "1970-01-01T00:00:00.000Z";

/** The ids the managed catalog gives these cities (see legacyReference.ts). */
const CITIES: Record<string, { id: string; name: string }> = {
  "草加市": { id: "city:soka", name: "Soka" },
  "越谷市": { id: "city:koshigaya", name: "Koshigaya" },
  "川口市": { id: "city:kawaguchi", name: "Kawaguchi" },
  "八潮市": { id: "city:yashio", name: "Yashio" },
  "足立区": { id: "city:adachi", name: "Adachi" },
};

function dataset<T>(datasetId: string, records: T[]): VersionedDataset<T> {
  return { datasetId, schemaVersion: 1, revision: `bundled:${datasetId}`, updatedAt: UPDATED_AT, records };
}

function legacySnapshot(): ReferenceDataSnapshot {
  const rings: [string, [number, number][]][] = [
    ["草加市", boundaryJson as [number, number][]],
    ...(neighborBoundariesJson as { name: string; ring: [number, number][] }[]).map(
      (city): [string, [number, number][]] => [city.name, city.ring],
    ),
  ];
  const cities: CityRecord[] = rings.map(([nameLocal]) => {
    const known = CITIES[nameLocal] ?? { id: `city:${nameLocal}`, name: nameLocal };
    return { ...known, nameLocal, status: "active", updatedAt: UPDATED_AT };
  });
  const boundaries: CityBoundaryRecord[] = rings.map(([, ring], i) => ({
    id: `boundary:${cities[i].id}:legacy`,
    cityId: cities[i].id,
    geometry: { type: "Polygon", coordinates: [ring] },
    status: "active",
    updatedAt: UPDATED_AT,
  }));

  // Original file order; there are no pinned app ids, so ids derive from it.
  let n = 0;
  const place = (category: string, p: NamedPlace, extra: Partial<ReferencePlaceRecord> = {}): ReferencePlaceRecord =>
    ({ id: `bundled:${n++}`, category, name: p.name, lat: p.lat, lon: p.lon, status: "active", updatedAt: UPDATED_AT, ...extra });
  const places: ReferencePlaceRecord[] = [
    ...(poisJson as PointOfInterest[]).map((p) => place("poi", p, { subtitle: p.address, attributes: { legacyRole: p.id } })),
    ...(mosquesJson as Mosque[]).map((m) => place("mosque", m, m.address ? { subtitle: m.address } : {})),
    ...(stationsJson as Station[]).map((s) => place("station", s, s.operator ? { subtitle: s.operator } : {})),
    ...(schoolsJson as NamedPlace[]).map((s) => place("school", s)),
    ...(kindergartensJson as ChildcareFacility[]).map((c) =>
      place("childcare", c, { subtitle: c.type, attributes: { facilityType: c.type } })),
    ...(busStopsJson as NamedPlace[]).map((b) => place("busStop", b)),
  ];
  return {
    revision: "bundled",
    cities: dataset("cities", cities),
    boundaries: dataset("boundaries", boundaries),
    places: dataset("places", places),
  };
}

export const BUNDLED_REFERENCE_SNAPSHOT = legacySnapshot();
export const BUNDLED_LISTINGS: readonly EnrichedListing[] =
  unpackListings(listingsJson as unknown as WebPayload | EnrichedListing[]);

/** Reference model over the bundled files, for code not yet behind the data provider. */
export const BUNDLED_REFERENCE: ReferenceModel = buildReferenceModel(BUNDLED_REFERENCE_SNAPSHOT);

export function createBundledWebDataClient(): WebDataClient {
  return {
    queryListings: async (): Promise<ReadResult<ListingQueryResult>> => ({ data: { listings: BUNDLED_LISTINGS } }),
    loadReferenceSnapshot: async (): Promise<ReadResult<ReferenceDataSnapshot>> => ({ data: BUNDLED_REFERENCE_SNAPSHOT }),
  };
}
