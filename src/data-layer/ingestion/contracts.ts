import type { RawListing } from "../../types";

/** Public scraper boundary. No paths, storage revision, or pre-merged source rows. */
export interface ScrapeBatch {
  schemaVersion: 1;
  source: string;
  scraper: { name: string; version: string; parserVersion: string };
  runId: string;
  /** Unique within a source/run; reusing it with different content is an error. */
  batchId: string;
  mode: "discovery" | "detail-enrichment" | "full-snapshot";
  capturedAt: string;
  scope: {
    urls: readonly string[];
    cities: readonly string[];
    filters: Readonly<Record<string, string | number | boolean>>;
  };
  observations: readonly ScrapeObservation[];
  /** Additional capture metadata; the ingestionJournal key is reserved. */
  provenance?: Readonly<Record<string, unknown>>;
}

export interface ScrapeObservation {
  sourceListingId: string;
  /** null is only for legacy detail captures: never evidence of current availability. */
  observedAt: string | null;
  evidence: { url: string; captureId: string };
  listing: RawListing;
}

export interface ScrapeIngestionReceipt {
  source: string;
  runId: string;
  batchId: string;
  replayed: boolean;
  /** Current source revision, not necessarily the original commit on replay. */
  revision: string;
  previousCount: number;
  currentCount: number;
  added: number;
  updated: number;
  retired: number;
  ignored: number;
  novel: number;
}

export interface ScrapeIngestion {
  ingestScrape(batch: ScrapeBatch, options?: { allowShrink?: boolean }): Promise<ScrapeIngestionReceipt>;
}

/** Persisted atomically with source rows. Never a separate, fallible receipt write. */
export interface IngestionJournalEntry {
  runId: string;
  batchId: string;
  fingerprint: string;
  metadata: Omit<ScrapeBatch, "observations" | "provenance">;
  evidence: readonly { sourceListingId: string; observedAt: string | null; url: string; captureId: string }[];
}

export interface IngestionJournal {
  schemaVersion: 1;
  batches: readonly IngestionJournalEntry[];
}
