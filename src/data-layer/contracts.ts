/**
 * Storage-independent contracts for the application's data layer.
 *
 * These interfaces describe capabilities, not a particular storage engine.
 * JSON/TOON files, an API client, and a future database adapter can implement
 * them without changing frontend or ingestion business rules.
 */
import type { RawListing } from "../domain/types";
import type { BoundaryGeometry } from "../domain/referenceData";

/** Stable identifiers are data, not array positions or display names. */
export type RecordId = string;

/** Versioned dataset envelope used for optimistic concurrency and migrations. */
export interface VersionedDataset<T> {
  datasetId: string;
  schemaVersion: number;
  /** Changes whenever this dataset is successfully updated. */
  revision: string;
  updatedAt: string;
  provenance?: Readonly<Record<string, unknown>>;
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
  /** English name (Soka, Saitama Minami-ku); the local name when no English is known. */
  name: string;
  nameLocal?: string;
  prefecture?: string;
  /** English prefecture name (Saitama). */
  prefectureEn?: string;
  /** 5-digit 全国地方公共団体コード, when known. */
  code?: string;
  status: "active" | "retired";
  updatedAt: string;
  retiredAt?: string;
  retirementReason?: string;
}

/** Boundary geometry is shared with the domain, which draws and measures it. */
export type { BoundaryGeometry, PolygonCoordinates, Position } from "../domain/referenceData";

export interface CityBoundaryRecord {
  id: RecordId;
  cityId: RecordId;
  geometry: BoundaryGeometry;
  source?: string;
  status: "active" | "retired";
  updatedAt: string;
  retiredAt?: string;
  retirementReason?: string;
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
  retiredAt?: string;
  retirementReason?: string;
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

export interface ReferenceCatalogManifest {
  schemaVersion: 1;
  /** Root revision algorithm; missing means legacy algorithm v1. */
  revisionAlgorithm?: 1 | 2;
  revision: string;
  migratedAt: string;
  updatedAt?: string;
  datasets: Record<string, { file: string; schemaVersion: number; revision: string; count: number }>;
  counts: {
    cities: number;
    boundaries: number;
    places: number;
    placesByCategory: Record<string, number>;
  };
  sourceFiles: Record<string, string>;
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
  /** Existing-row enrichment locator for legacy IDs that collide across distinct ads. */
  targetUrl?: string;
  observedAt: string;
  listing: RawListing;
}

export interface ListingObservationBatch {
  source: string;
  /** Revision of this source's data read by the caller; null means not created yet. */
  expectedRevision: string | null;
  observedAt: string;
  /** preserve is an existing-row-only enrichment, not new availability evidence. */
  completeness: "incremental" | "complete" | "preserve";
  observations: readonly ListingObservation[];
  /** Explicitly retire source IDs only when an ingestion rule can explain why. */
  retirements?: readonly Retirement[];
  provenance?: Readonly<Record<string, unknown>>;
}

/** Exact legacy row identity. Generated IDs alone may collide across source ads. */
export interface SourceRowLocator {
  sourceListingId: string;
  targetUrl: string | null;
}

/** Internal application reconciliation: every removed locator needs an explicit archive reason. */
export interface SourceReconciliation {
  source: string;
  expectedRevision: string | null;
  observedAt: string;
  listings: readonly RawListing[];
  retirements: readonly (SourceRowLocator & { effectiveAt: string; reason: string })[];
  provenance?: Readonly<Record<string, unknown>>;
}

export interface ArchivedSourceListing {
  sourceListingId: string;
  listing: RawListing;
  retiredAt: string;
  reason: string;
}

/** Bootstrap-only compatibility shape. A missing/empty source is grouped under "unknown" without rewriting the row. */
export type LegacyListing = Pick<RawListing, "name" | "address" | "rent"> & Partial<Omit<RawListing, "source" | "name" | "address" | "rent">> & { source?: string | null };

/** Internal create-only port: preserve every historical row, including missing/colliding IDs. */
export interface HistoricalSourceSeed {
  source: string;
  importedAt: string;
  listings: readonly LegacyListing[];
  provenance: Readonly<Record<string, unknown>>;
}

/** Current source-owned rows plus retained rows retired by complete snapshots. */
export interface ListingSourceSnapshot {
  source: string;
  revision: string;
  /** Legacy envelope time; a tagged bootstrap uses import time, not capture evidence. See sourceObservationTime helpers. */
  scrapedAt: string;
  completeSnapshot: boolean;
  listings: readonly RawListing[];
  archivedListings: readonly ArchivedSourceListing[];
  provenance?: Readonly<Record<string, unknown>>;
}

export interface ListingIngestionResult {
  accepted: number;
  unchanged: number;
  retired: number;
  revision: string;
}

/**
 * Listing writes enter through source-scoped observation batches. Implementations
 * must be idempotent and preserve history; absence from an incremental batch is
 * not a deletion signal. Incremental retirements require explicit reasons.
 * Canonical merge/lifecycle decisions belong to use cases.
 */
export interface ListingRepository {
  readSource(source: string): Promise<ListingSourceSnapshot | null>;
  listSources(): Promise<readonly ListingSourceSnapshot[]>;
  /** Create historical data verbatim; never replace, deduplicate, assign IDs, or assert fresh observations. */
  initializeHistoricalSource(seed: HistoricalSourceSeed, options: { expectedRevision: null }): Promise<{ revision: string }>;
  /** Exact-row incremental reconciliation; rejects unexplained absence and never establishes market completeness. */
  reconcileSource(batch: SourceReconciliation, options?: { allowShrink?: boolean }): Promise<ListingIngestionResult>;
  /** allowShrink is an explicit operator confirmation after snapshot validation. */
  ingest(
    batch: ListingObservationBatch,
    options?: { allowShrink?: boolean },
  ): Promise<ListingIngestionResult>;
}

/** User-owned state is isolated from reference and source-owned listing data. */
export interface UserDataRepository {
  read<T>(userId: string, key: string): Promise<T | null>;
  /** `expectedRevision: null` means the key is expected not to exist yet. */
  write<T>(userId: string, key: string, value: T, expectedRevision: string | null): Promise<string>;
}
