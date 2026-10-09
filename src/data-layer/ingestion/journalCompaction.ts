import type { ListingRepository } from "../contracts";
import type { IngestionJournal, IngestionJournalEntry } from "./contracts";

/**
 * Retention rule for the ingestion journal.
 *
 * Every batch keeps its identity, fingerprint, effect, and metadata forever: those are what make
 * replay detection and conflict detection work. Only the per-observation `evidence` list is bulky
 * (one entry per observation per commit) and it is never read back by the application, so it is
 * kept for the newest `keepEvidenceBatches` batches and dropped from older ones.
 *
 * This is never silent: it runs only when requested, the source file is backed up by the store, and
 * an append-only `journalCompactions` receipt records what was dropped.
 */
export const DEFAULT_KEEP_EVIDENCE_BATCHES = 50;

export interface JournalCompactionReceipt {
  compactedAt: string;
  keepEvidenceBatches: number;
  batchesCompacted: number;
  evidenceEntriesDropped: number;
}

export type JournalCompactionResult =
  | { status: "missing" | "no-journal" | "nothing-to-compact"; source: string }
  | { status: "compacted"; source: string; receipt: JournalCompactionReceipt; revision: string };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Pure step: returns the compacted journal and how many evidence entries it dropped. */
export function compactJournal(journal: IngestionJournal, keepEvidenceBatches: number): { journal: IngestionJournal; batchesCompacted: number; evidenceEntriesDropped: number } {
  const cutoff = Math.max(0, journal.batches.length - keepEvidenceBatches);
  let batchesCompacted = 0, evidenceEntriesDropped = 0;
  const batches = journal.batches.map((entry, index): IngestionJournalEntry => {
    if (index >= cutoff || entry.evidence.length === 0) return entry;
    batchesCompacted++; evidenceEntriesDropped += entry.evidence.length;
    return { ...entry, evidence: [] };
  });
  return { journal: { ...journal, batches }, batchesCompacted, evidenceEntriesDropped };
}

export async function compactIngestionJournal(repository: ListingRepository, input: {
  source: string; keepEvidenceBatches?: number; now?: () => Date;
}): Promise<JournalCompactionResult> {
  const keep = input.keepEvidenceBatches ?? DEFAULT_KEEP_EVIDENCE_BATCHES;
  if (!Number.isInteger(keep) || keep < 1) throw new Error("keepEvidenceBatches must be a positive integer");
  const previous = await repository.readSource(input.source);
  if (!previous) return { status: "missing", source: input.source };
  const raw = previous.provenance?.ingestionJournal;
  if (raw === undefined) return { status: "no-journal", source: input.source };
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.batches)) throw new Error("Invalid or unsupported persisted ingestion journal");
  const compacted = compactJournal(raw as unknown as IngestionJournal, keep);
  if (compacted.batchesCompacted === 0) return { status: "nothing-to-compact", source: input.source };
  const receipt: JournalCompactionReceipt = { compactedAt: (input.now?.() ?? new Date()).toISOString(), keepEvidenceBatches: keep,
    batchesCompacted: compacted.batchesCompacted, evidenceEntriesDropped: compacted.evidenceEntriesDropped };
  const prior = Array.isArray(previous.provenance?.journalCompactions) ? previous.provenance!.journalCompactions as unknown[] : [];
  const result = await repository.ingest({ source: input.source, expectedRevision: previous.revision, observedAt: previous.scrapedAt,
    completeness: "preserve", observations: [],
    provenance: { ...previous.provenance, ingestionJournal: compacted.journal, journalCompactions: [...prior, receipt] } });
  return { status: "compacted", source: input.source, receipt, revision: result.revision };
}
