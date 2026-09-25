import type { ListingRepository } from "../contracts";
import { canonicalJson, contentFingerprint as scrapeFingerprint } from "../contentIdentity";
export { canonicalJson, contentFingerprint as scrapeFingerprint } from "../contentIdentity";
import { MANAGED_INGESTION_PROVENANCE_KEYS } from "../sourceProvenance";
import type { DetailEnrichmentOptions, DetailEnrichmentPlanner, IngestionJournal, ScrapeSubmission, ScrapeIngestion, ScrapeIngestionReceipt } from "./contracts";
import { prepareNiftyBatch } from "./niftyPolicy";
import { prepareSuumoDetailBatch, selectDetailUrls, validateDetailPatch } from "./suumoDetailPolicy";
import { InvalidScrapeBatchError, ScrapeReplayConflictError } from "./errors";
export { InvalidScrapeBatchError, ScrapeReplayConflictError } from "./errors";

/** Versioned application boundary. Scrapers never choose the merge policy or read source revisions. */
export class ListingIngestionService implements ScrapeIngestion, DetailEnrichmentPlanner {
  constructor(private readonly repository: ListingRepository) {}

  async planDetailEnrichment(options: DetailEnrichmentOptions): Promise<readonly string[]> {
    return selectDetailUrls(await this.repository.listSources(), options);
  }

  async ingestScrape(request: ScrapeSubmission, options: { allowShrink?: boolean } = {}): Promise<ScrapeIngestionReceipt> {
    validateScrapeBatch(request);
    // Own an immutable-by-convention JSON copy across asynchronous reads/writes.
    const batch = JSON.parse(canonicalJson(request)) as ScrapeSubmission;
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

    const prepared = batch.observationKind === "detail-patch"
      ? prepareSuumoDetailBatch(batch, previous) : prepareNiftyBatch(batch, previous);
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

function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function sourceUrl(value: unknown, host: string): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === host && !url.username && !url.password; }
  catch { return false; }
}
function invalid(message: string): never { throw new InvalidScrapeBatchError(message); }

function validateScrapeBatch(batch: ScrapeSubmission): void {
  if (!object(batch) || batch.schemaVersion !== 1) invalid("Unsupported scrape schemaVersion");
  const detailPatch = batch.observationKind === "detail-patch";
  if (batch.observationKind !== undefined && batch.observationKind !== "listing" && !detailPatch) invalid("Unsupported observation kind");
  if (batch.source !== (detailPatch ? "suumo" : "nifty")) invalid("Unsupported scrape source");
  if ((batch.mode !== "discovery" && batch.mode !== "detail-enrichment") || (detailPatch && batch.mode !== "detail-enrichment")) {
    invalid("Unsupported scrape mode; full snapshots require a reviewed exhaustion-evidence policy");
  }
  const validUrl = (value: unknown) => sourceUrl(value, detailPatch ? "suumo.jp" : "myhome.nifty.com");
  const expectedProducer = detailPatch ? "suumo-detail" : batch.mode === "discovery" ? "nifty-list" : "nifty-detail";
  if (!object(batch.scraper) || batch.scraper.name !== expectedProducer || batch.scraper.version !== "1" || batch.scraper.parserVersion !== "1") {
    invalid("Unsupported or missing scraper name/version/parserVersion");
  }
  if (!nonempty(batch.runId) || !nonempty(batch.batchId) || !timestamp(batch.capturedAt)) invalid("Invalid run/batch identity or capture time");
  if (!object(batch.scope) || !Array.isArray(batch.scope.urls) || !batch.scope.urls.every(validUrl)
    || !Array.isArray(batch.scope.cities) || !batch.scope.cities.every(nonempty) || !object(batch.scope.filters)
    || !Object.values(batch.scope.filters).every((value) => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
    invalid("Invalid scrape scope");
  }
  if (batch.provenance !== undefined && (!object(batch.provenance) || MANAGED_INGESTION_PROVENANCE_KEYS.some((key) => key in batch.provenance!))) invalid("Invalid/reserved scrape provenance");
  if (!Array.isArray(batch.observations)) invalid("Observations must be an array");
  const seen = new Map<string, string>();
  for (const observation of batch.observations) {
    if (!object(observation) || !nonempty(observation.sourceListingId)) invalid("Missing observation identity");
    if (observation.observedAt === null) {
      if (detailPatch || batch.mode !== "detail-enrichment") invalid("Only legacy detail captures may have unknown observation time");
    } else if (!timestamp(observation.observedAt)) invalid("Invalid observation timestamp");
    if (!object(observation.evidence) || !nonempty(observation.evidence.captureId) || !validUrl(observation.evidence.url)
      || !batch.scope.urls.includes(observation.evidence.url)) invalid("Missing or out-of-scope observation evidence");
    if (detailPatch) {
      if (observation.sourceListingId !== observation.evidence.url || "listing" in observation || !("details" in observation)) invalid("Invalid detail patch identity/payload");
      validateDetailPatch(observation.details);
    } else {
      if (!("listing" in observation) || !object(observation.listing) || "details" in observation) invalid("Missing observation listing");
      const listing = observation.listing;
      if (listing.source !== batch.source || (listing.id != null && listing.id !== observation.sourceListingId)
        || !validUrl(listing.url) || (listing.id == null && observation.sourceListingId !== listing.url)) invalid("Observation source/identity mismatch");
      if (!nonempty(listing.name) || !nonempty(listing.address) || typeof listing.rent !== "number" || !Number.isFinite(listing.rent) || listing.rent <= 0
        || (listing.sizeM2 !== null && (typeof listing.sizeM2 !== "number" || !Number.isFinite(listing.sizeM2) || listing.sizeM2 <= 0))
        || typeof listing.layout !== "string" || Number(listing.layout.normalize("NFKC").match(/^\d+/)?.[0] ?? 0) < 2) invalid("Invalid family listing fields");
      for (const key of ["status", "firstSeenAt", "lastSeenAt", "soldAt", "sourceListings"] as const) {
        if (listing[key] !== undefined) invalid(`Scrapers cannot assign canonical field ${key}`);
      }
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
