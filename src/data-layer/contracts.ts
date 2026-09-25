/**
 * Storage-independent contracts for the application's data layer.
 *
 * These interfaces describe capabilities, not a particular storage engine.
 * JSON/TOON files, an API client, and a future database adapter can implement
 * them without changing frontend or ingestion business rules.
 */
import type { RawListing } from "../types";

/** Stable identifiers are data, not array positions or display names. */
export type RecordId = string;

/** Versioned dataset envelope used for optimistic concurrency and migrations. */
export interface VersionedDataset<T> {
  datasetId: string;
  schemaVersion: number;
  /** Changes whenever this dataset is successfully updated. */
  revision: string;
  updatedAt: string;
  records: readonly T[];
}

/** A requested retirement is explicit and retains its reason and effective time. */
export interface Retirement {
  id: RecordId;
  effectiveAt: string;
  reason: string;
}

/**
 * Updates are upserts plus explicit retirements, never implicit full replacement.
 * A storage adapter must reject a stale expectedRevision rather than lose writes.
 */
export interface DatasetChangeSet<T> {
  upsert: readonly T[];
  retire?: readonly Retirement[];
}

export interface DatasetWriteOptions {
  expectedRevision: string;
  changedBy: string;
  reason: string;
}

/** A city is a managed catalog record; additions/renames are normal data changes. */
export interface CityRecord {
  id: RecordId;
  name: string;
  nameLocal?: string;
  prefecture?: string;
  status: "active" | "retired";
  updatedAt: string;
}

/** GeoJSON-like coordinates are [longitude, latitude] pairs. */
export type Position = readonly [longitude: number, latitude: number];
export type PolygonCoordinates = readonly (readonly Position[])[];

/** Polygon and multipolygon both support cities with multiple boundary pieces. */
export type BoundaryGeometry =
  | { type: "Polygon"; coordinates: PolygonCoordinates }
  | { type: "MultiPolygon"; coordinates: readonly PolygonCoordinates[] };

export interface CityBoundaryRecord {
  id: RecordId;
  cityId: RecordId;
  geometry: BoundaryGeometry;
  source?: string;
  status: "active" | "retired";
  updatedAt: string;
}

/**
 * One addressable place in the current reference catalog. New categories and
 * any number of POIs can be added without changing a tuple or array index.
 */
export interface ReferencePlaceRecord {
  id: RecordId;
  category: string;
  name: string;
  nameLocal?: string;
  address?: string;
  lat: number;
  lon: number;
  subtitle?: string;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  status: "active" | "retired";
  updatedAt: string;
}

/**
 * Reference data changes over time too: cities, boundaries, POIs, and the
 * number and categories of places are all managed datasets, not constants.
 */
export interface ReferenceDataSnapshot {
  revision: string;
  cities: VersionedDataset<CityRecord>;
  boundaries: VersionedDataset<CityBoundaryRecord>;
  places: VersionedDataset<ReferencePlaceRecord>;
}

export interface ReferenceDataRepository {
  loadSnapshot(): Promise<ReferenceDataSnapshot>;
  updateCities(
    changes: DatasetChangeSet<CityRecord>,
    options: DatasetWriteOptions,
  ): Promise<VersionedDataset<CityRecord>>;
  updateBoundaries(
    changes: DatasetChangeSet<CityBoundaryRecord>,
    options: DatasetWriteOptions,
  ): Promise<VersionedDataset<CityBoundaryRecord>>;
  updatePlaces(
    changes: DatasetChangeSet<ReferencePlaceRecord>,
    options: DatasetWriteOptions,
  ): Promise<VersionedDataset<ReferencePlaceRecord>>;
}

/**
 * One source's observation of a listing. Source identity remains distinct from
 * canonical-property identity, which is resolved by application/domain rules.
 */
export interface ListingObservation {
  source: string;
  sourceListingId: string;
  observedAt: string;
  listing: RawListing;
}

export interface ListingObservationBatch {
  source: string;
  /** Revision of this source's data read by the caller; null means not created yet. */
  expectedRevision: string | null;
  observedAt: string;
  completeness: "incremental" | "complete";
  observations: readonly ListingObservation[];
  provenance?: Readonly<Record<string, unknown>>;
}

export interface ListingIngestionResult {
  accepted: number;
  unchanged: number;
  rejected: number;
  revision: string;
}

/**
 * Listing writes enter through observation batches. Implementations must be
 * idempotent and preserve history; absence from an incremental batch is not a
 * deletion signal. Canonical rebuild/lifecycle decisions belong to use cases.
 */
export interface ListingRepository {
  listCurrent(): Promise<readonly RawListing[]>;
  ingest(batch: ListingObservationBatch): Promise<ListingIngestionResult>;
}

/** User-owned state is isolated from reference and source-owned listing data. */
export interface UserDataRepository {
  read<T>(userId: string, key: string): Promise<T | null>;
  /** `expectedRevision: null` means the key is expected not to exist yet. */
  write<T>(userId: string, key: string, value: T, expectedRevision: string | null): Promise<string>;
}
