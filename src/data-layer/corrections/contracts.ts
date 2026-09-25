/** Named, versioned rules over stored source evidence, not caller-supplied replacement rows. */
export interface SourceCorrectionRequest {
  schemaVersion: 1;
  source: "suumo";
  rule: { name: "suumo-notes-backfill"; version: "1" };
  /** Replay key for a changing commit. Missing/no-op requests do not create receipts. */
  operationId: string;
  actor: string;
  reason: string;
}

export interface SourceCorrectionResult {
  status: "missing" | "unchanged" | "applied" | "replayed";
  /** Current source revision; null only when the source does not exist. */
  revision: string | null;
  count: number;
  withFloor: number;
  updated: number;
}

export interface SourceCorrections {
  applyCorrection(request: SourceCorrectionRequest): Promise<SourceCorrectionResult>;
}

export interface SourceFieldCorrection {
  field: "building.floor" | "building.totalFloors" | "costs.adminFeeYen";
  /** Omitted means the prior field was unset; null and zero remain distinct. */
  before?: string | number | null;
  after: string | number | null;
}

export interface SourceRowCorrection {
  sourceListingId: string;
  targetUrl: string | null;
  evidence: { notes: string | null; priorFloor: string | null };
  changes: readonly SourceFieldCorrection[];
}

/** This journal is committed atomically with the corrected rows, never as a second write. */
export interface SourceCorrectionJournalEntry {
  operationId: string;
  fingerprint: string;
  request: SourceCorrectionRequest;
  appliedAt: string;
  basedOnRevision: string;
  rows: readonly SourceRowCorrection[];
}

export interface SourceCorrectionJournal {
  schemaVersion: 1;
  operations: readonly SourceCorrectionJournalEntry[];
}
