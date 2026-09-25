import type { ListingRepository } from "../contracts";
import type { IngestionJournal, ScrapeBatch, ScrapeIngestion, ScrapeIngestionReceipt } from "./contracts";
import { prepareNiftyBatch } from "./niftyPolicy";

export class InvalidScrapeBatchError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidScrapeBatchError"; }
}
export class ScrapeReplayConflictError extends Error {
  constructor() { super("Scrape batch ID was already committed with different content"); this.name = "ScrapeReplayConflictError"; }
}

/** Versioned application boundary. Scrapers never choose the merge policy or read source revisions. */
export class ListingIngestionService implements ScrapeIngestion {
  constructor(private readonly repository: ListingRepository) {}

  async ingestScrape(request: ScrapeBatch, options: { allowShrink?: boolean } = {}): Promise<ScrapeIngestionReceipt> {
    validateScrapeBatch(request);
    // Own an immutable-by-convention JSON copy across asynchronous reads/writes.
    const batch = JSON.parse(canonicalJson(request)) as ScrapeBatch;
    const fingerprint = await scrapeFingerprint(batch);
    const previous = await this.repository.readSource(batch.source);
    const journal = readJournal(previous?.provenance?.ingestionJournal);
    const priorBatch = journal.batches.find((entry) => entry.runId === batch.runId && entry.batchId === batch.batchId);
    const identity = { source: batch.source, runId: batch.runId, batchId: batch.batchId };
    if (priorBatch) {
      if (priorBatch.fingerprint !== fingerprint) throw new ScrapeReplayConflictError();
      return { ...identity, replayed: true, revision: previous!.revision,
        previousCount: previous!.listings.length, currentCount: previous!.listings.length,
        added: 0, updated: 0, retired: 0, ignored: batch.observations.length, novel: 0 };
    }

    const prepared = prepareNiftyBatch(batch, previous);
    const { observations, provenance: _provenance, ...metadata } = batch;
    const nextJournal: IngestionJournal = { schemaVersion: 1, batches: [...journal.batches, {
      runId: batch.runId, batchId: batch.batchId, fingerprint, metadata,
      evidence: observations.map((observation) => ({
        sourceListingId: observation.sourceListingId, observedAt: observation.observedAt, ...observation.evidence,
      })),
    }] };
    // Journal and rows share one revision-checked atomic commit. A failure cannot
    // mark a batch as applied. Conflicts are surfaced, never retried with new state.
    const result = await this.repository.ingest({ ...prepared.batch,
      provenance: { ...prepared.batch.provenance, ingestionJournal: nextJournal },
    }, options);
    return { ...identity, replayed: false, revision: result.revision, retired: result.retired,
      added: prepared.added, updated: prepared.updated, ignored: prepared.ignored, novel: prepared.novel,
      previousCount: prepared.previousCount, currentCount: prepared.currentCount };
  }
}

/** Deterministic content identity: object key order is irrelevant; array order is not. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export async function scrapeFingerprint(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function niftyUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "myhome.nifty.com" && !url.username && !url.password; }
  catch { return false; }
}
function invalid(message: string): never { throw new InvalidScrapeBatchError(message); }

function validateScrapeBatch(batch: ScrapeBatch): void {
  if (!object(batch) || batch.schemaVersion !== 1) invalid("Unsupported scrape schemaVersion");
  if (batch.source !== "nifty") invalid("Unsupported scrape source");
  if (batch.mode !== "discovery" && batch.mode !== "detail-enrichment") {
    invalid("Unsupported scrape mode; full snapshots require a reviewed exhaustion-evidence policy");
  }
  const expectedProducer = batch.mode === "discovery" ? "nifty-list" : "nifty-detail";
  if (!object(batch.scraper) || batch.scraper.name !== expectedProducer || batch.scraper.version !== "1" || batch.scraper.parserVersion !== "1") {
    invalid("Unsupported or missing scraper name/version/parserVersion");
  }
  if (!nonempty(batch.runId) || !nonempty(batch.batchId) || !timestamp(batch.capturedAt)) invalid("Invalid run/batch identity or capture time");
  if (!object(batch.scope) || !Array.isArray(batch.scope.urls) || !batch.scope.urls.every(niftyUrl)
    || !Array.isArray(batch.scope.cities) || !batch.scope.cities.every(nonempty) || !object(batch.scope.filters)
    || !Object.values(batch.scope.filters).every((value) => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
    invalid("Invalid scrape scope");
  }
  if (batch.provenance !== undefined && (!object(batch.provenance) || "ingestionJournal" in batch.provenance)) invalid("Invalid/reserved scrape provenance");
  if (!Array.isArray(batch.observations)) invalid("Observations must be an array");
  const seen = new Map<string, string>();
  for (const observation of batch.observations) {
    if (!object(observation) || !nonempty(observation.sourceListingId) || !object(observation.listing)) invalid("Missing observation identity/listing");
    if (observation.observedAt === null) {
      if (batch.mode !== "detail-enrichment") invalid("Only legacy detail captures may have unknown observation time");
    } else if (!timestamp(observation.observedAt)) invalid("Invalid observation timestamp");
    if (!object(observation.evidence) || !nonempty(observation.evidence.captureId) || !niftyUrl(observation.evidence.url)
      || !batch.scope.urls.includes(observation.evidence.url)) invalid("Missing or out-of-scope observation evidence");
    const listing = observation.listing;
    if (listing.source !== batch.source || (listing.id != null && listing.id !== observation.sourceListingId)
      || !niftyUrl(listing.url) || (listing.id == null && observation.sourceListingId !== listing.url)) invalid("Observation source/identity mismatch");
    if (!nonempty(listing.name) || !nonempty(listing.address) || typeof listing.rent !== "number" || !Number.isFinite(listing.rent) || listing.rent <= 0
      || (listing.sizeM2 !== null && (typeof listing.sizeM2 !== "number" || !Number.isFinite(listing.sizeM2) || listing.sizeM2 <= 0))
      || typeof listing.layout !== "string" || Number(listing.layout.normalize("NFKC").match(/^\d+/)?.[0] ?? 0) < 2) invalid("Invalid family listing fields");
    for (const key of ["status", "firstSeenAt", "lastSeenAt", "soldAt", "sourceListings"] as const) {
      if (listing[key] !== undefined) invalid(`Scrapers cannot assign canonical field ${key}`);
    }
    const encoded = canonicalJson(observation);
    if (seen.has(observation.sourceListingId) && seen.get(observation.sourceListingId) !== encoded) invalid("Conflicting observations for one source listing ID");
    seen.set(observation.sourceListingId, encoded);
  }
}

function readJournal(value: unknown): IngestionJournal {
  if (value === undefined) return { schemaVersion: 1, batches: [] };
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.batches)) invalid("Invalid or unsupported persisted ingestion journal");
  const keys = new Set<string>();
  for (const entry of value.batches) {
    if (!object(entry) || !nonempty(entry.runId) || !nonempty(entry.batchId)
      || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) invalid("Invalid persisted ingestion receipt");
    const key = JSON.stringify([entry.runId, entry.batchId]);
    if (keys.has(key)) invalid("Duplicate persisted ingestion receipt");
    keys.add(key);
  }
  return value as unknown as IngestionJournal;
}
