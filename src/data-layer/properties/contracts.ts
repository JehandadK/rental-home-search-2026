/**
 * Property document store: one additive document per real-world property
 * (see src/domain/propertyDocument.ts). Storage adapters implement the store;
 * the sync service decides identity and what each piece of evidence adds.
 */
import type { PropertyDocument } from "../../domain/propertyDocument";
import type { AdAvailability, RawListing } from "../../domain/types";

export interface PropertyStoreState {
  /** Every document, merged ones included, keyed by propertyId. */
  documents: Map<string, PropertyDocument>;
}

export interface PropertyDocumentStore {
  /**
   * Load every document, run `update` against them, then write the documents
   * it added or changed. Documents are never deleted.
   */
  transact<T>(update: (state: PropertyStoreState) => T | Promise<T>): Promise<T>;
}

/** One source file's evidence, already read by the caller. */
export interface SourceEvidence {
  source: string;
  /** Current rows, each with its capture time when the source file records one. */
  rows: readonly { listing: RawListing; observedAt: string | null }[];
  /** Earlier versions retired from the file (superseded ads). */
  archived: readonly { listing: RawListing; retiredAt: string; reason: string }[];
  /** Ingestion-journal sightings: a capture showed this source row. */
  sightings: readonly { sourceListingId: string; observedAt: string; captureId?: string }[];
}

export interface AvailabilityCheckEvidence extends AdAvailability {
  /** `adKey` of the checked ad. */
  key: string;
  source: string;
  url: string;
}

export interface PropertyEvidence {
  /** When this sync recorded the evidence. */
  recordedAt: string;
  /** Where it came from, e.g. `data:build` or `backfill:git:7fc5cc7`. */
  via: string;
  /** When the snapshot was current (a git commit or backup time); defaults to `recordedAt`. */
  asOf?: string;
  /**
   * The merged dataset (listings_raw.json): cross-portal grouping and build
   * lifecycle. Only the current build's grouping may merge documents; pass
   * `groupingAuthoritative: false` for a historical one.
   */
  canonical?: { builtAt: string | null; rows: readonly RawListing[]; groupingAuthoritative?: boolean };
  sources?: readonly SourceEvidence[];
  availability?: readonly AvailabilityCheckEvidence[];
}

export interface PropertySyncReport {
  via: string;
  documents: number;
  created: number;
  merged: number;
  changed: number;
  factValuesAdded: number;
  sightingsAdded: number;
  eventsAdded: number;
  /** Journal sightings of rows no file still holds; kept on their own documents. */
  orphanSightings: number;
  /** Ad-page checks of ads no document knows; left in availability.json, not guessed. */
  unresolvedChecks: number;
}
