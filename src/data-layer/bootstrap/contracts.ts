import type { LegacyListing } from "../contracts";

/** Historical data import, not a scrape or permission to replace existing sources. */
export interface SourceBootstrapRequest {
  schemaVersion: 1;
  migration: { name: "legacy-source-split"; version: "1" };
  /** Audit correlation only; source existence is the create-only idempotency key. */
  operationId: string;
  actor: string;
  reason: string;
  input: { datasetId: string; records: readonly LegacyListing[] };
}

export interface SourceBootstrapResult {
  source: string;
  status: "created" | "skipped";
  /** Number of input rows belonging to this source, even when creation is skipped. */
  count: number;
  revision: string;
}

export interface SourceBootstrap {
  /** Per-source commits survive later failures; callbacks run only after creation/skip. */
  bootstrapSources(request: SourceBootstrapRequest, onSource?: (result: SourceBootstrapResult) => void): Promise<readonly SourceBootstrapResult[]>;
}

export interface SourceBootstrapAudit {
  schemaVersion: 1;
  migration: SourceBootstrapRequest["migration"];
  operationId: string;
  actor: string;
  reason: string;
  importedAt: string;
  /** No source-level observation times can be inferred from a canonical legacy dump. */
  captureSemantics: "historical-only";
  input: { datasetId: string; recordCount: number; fingerprint: string };
  source: string;
  recordCount: number;
  recordsFingerprint: string;
}
