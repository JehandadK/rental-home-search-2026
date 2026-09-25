import type { ListingObservation, ListingRepository } from "../contracts";
import { canonicalJson, contentFingerprint } from "../contentIdentity";
import type { SourceCorrectionJournal, SourceCorrectionRequest, SourceCorrectionResult, SourceCorrections, SourceRowCorrection } from "./contracts";
import { backfillSuumoNotes, suumoNoteChanges } from "./suumoNotes";

export class InvalidSourceCorrectionError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidSourceCorrectionError"; }
}
export class SourceCorrectionReplayConflictError extends Error {
  constructor() { super("Correction operation ID was already committed with different metadata"); this.name = "SourceCorrectionReplayConflictError"; }
}

/** Closed, versioned correction recipes; callers cannot supply replacement rows or patches. */
export class SourceCorrectionService implements SourceCorrections {
  constructor(private readonly repository: ListingRepository, private readonly now = () => new Date()) {}

  async applyCorrection(input: SourceCorrectionRequest): Promise<SourceCorrectionResult> {
    validateRequest(input);
    const request = JSON.parse(canonicalJson(input)) as SourceCorrectionRequest;
    validateRequest(request);
    const fingerprint = await contentFingerprint(request);
    const previous = await this.repository.readSource(request.source);
    if (!previous) return { status: "missing", revision: null, count: 0, withFloor: 0, updated: 0 };
    if (previous.source !== request.source) invalid("Correction source snapshot mismatch");
    const journal = readJournal(previous.provenance?.correctionJournal);
    const committed = journal.operations.find((entry) => entry.operationId === request.operationId);
    const current = { revision: previous.revision, count: previous.listings.length,
      withFloor: previous.listings.filter((listing) => listing.building?.floor).length, updated: 0 };
    if (committed) {
      if (committed.fingerprint !== fingerprint) throw new SourceCorrectionReplayConflictError();
      return { ...current, status: "replayed" };
    }

    const observations: ListingObservation[] = [];
    const rows: SourceRowCorrection[] = [];
    let withFloor = 0;
    for (const listing of previous.listings) {
      if (listing.source !== request.source) invalid("Correction row belongs to a different source");
      const next = backfillSuumoNotes(listing);
      if (next.building?.floor) withFloor++;
      const changes = suumoNoteChanges(listing, next);
      if (!changes.length) continue;
      const sourceListingId = listing.id ?? listing.url;
      if (!sourceListingId?.trim()) invalid("Cannot correct a source row without a stable identity");
      observations.push({ source: request.source, sourceListingId, targetUrl: listing.url ?? undefined,
        observedAt: previous.scrapedAt, listing: next });
      rows.push({ sourceListingId, targetUrl: listing.url,
        evidence: { notes: listing.notes ?? null, priorFloor: listing.building?.floor ?? null }, changes });
    }
    // A repeated CLI invocation is a true no-op, even with a new operation ID or
    // clock time. Do not churn revisions/backups just to report no changes.
    if (!rows.length) return { ...current, status: "unchanged" };
    const appliedAt = this.now().toISOString();
    const correctionJournal: SourceCorrectionJournal = { schemaVersion: 1, operations: [...journal.operations, {
      operationId: request.operationId, fingerprint, request, appliedAt, basedOnRevision: previous.revision, rows,
    }] };
    readJournal(correctionJournal); // validate the generated audit before any write, too
    const result = await this.repository.ingest({ source: request.source, expectedRevision: previous.revision,
      observedAt: previous.scrapedAt, completeness: "preserve", observations,
      provenance: { ...previous.provenance, backfilledAt: appliedAt, correctionJournal },
    });
    return { status: "applied", revision: result.revision, count: current.count, withFloor, updated: rows.length };
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function invalid(message: string): never { throw new InvalidSourceCorrectionError(message); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validateRequest(request: SourceCorrectionRequest): void {
  if (!object(request) || !exactKeys(request, ["schemaVersion", "source", "rule", "operationId", "actor", "reason"]) || request.schemaVersion !== 1) invalid("Invalid correction request/schemaVersion");
  if (request.source !== "suumo" || !object(request.rule) || !exactKeys(request.rule, ["name", "version"])
    || request.rule.name !== "suumo-notes-backfill" || request.rule.version !== "1") invalid("Unsupported correction source/rule/version");
  if (!text(request.operationId) || !text(request.actor) || !text(request.reason)) invalid("Correction operationId, actor and reason are required");
}

function readJournal(value: unknown): SourceCorrectionJournal {
  if (value === undefined) return { schemaVersion: 1, operations: [] };
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.operations)) invalid("Invalid or unsupported correction journal");
  const seen = new Set<string>();
  const nullableText = (v: unknown) => v === null || typeof v === "string";
  const fieldValue = (v: unknown) => nullableText(v) || (typeof v === "number" && Number.isFinite(v));
  for (const entry of value.operations) {
    if (!object(entry) || !text(entry.operationId) || seen.has(entry.operationId)
      || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
      || !text(entry.basedOnRevision) || !text(entry.appliedAt) || !Number.isFinite(Date.parse(entry.appliedAt))
      || !Array.isArray(entry.rows) || !entry.rows.length) invalid("Invalid persisted correction receipt");
    validateRequest(entry.request as SourceCorrectionRequest);
    if ((entry.request as SourceCorrectionRequest).operationId !== entry.operationId) invalid("Correction receipt identity mismatch");
    for (const row of entry.rows) {
      if (!object(row) || !text(row.sourceListingId) || !nullableText(row.targetUrl) || !object(row.evidence)
        || !nullableText(row.evidence.notes) || !nullableText(row.evidence.priorFloor) || !Array.isArray(row.changes) || !row.changes.length) invalid("Invalid correction row audit");
      for (const change of row.changes) {
        if (!object(change) || !["building.floor", "building.totalFloors", "costs.adminFeeYen"].includes(String(change.field))
          || (Object.hasOwn(change, "before") && !fieldValue(change.before)) || !fieldValue(change.after)) invalid("Invalid correction field audit");
      }
    }
    seen.add(entry.operationId);
  }
  return value as unknown as SourceCorrectionJournal;
}
