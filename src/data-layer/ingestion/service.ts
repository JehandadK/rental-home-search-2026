import type { ListingRepository, ListingSourceSnapshot } from "../contracts";
import { canonicalJson, contentFingerprint as scrapeFingerprint } from "../contentIdentity";
export { canonicalJson, contentFingerprint as scrapeFingerprint } from "../contentIdentity";
import { MANAGED_INGESTION_PROVENANCE_KEYS } from "../sourceProvenance";
import type { AgencyDetailOptions, AgencyDetailPlanner, DetailEnrichmentOptions, DetailEnrichmentPlanner, IngestionJournal, ScrapeSubmission, ScrapeIngestion, ScrapeIngestionReceipt, SuumoDiscoveryClient, SuumoDiscoveryOptions, SuumoDiscoverySession, PortalDiscoveryClient, PortalDiscoveryOptions, PortalDiscoverySession, NativeCaptureIngestion, CaptureRunSummary } from "./contracts";
import { selectDetailUrls } from "./suumoDetailPolicy";
import { selectAgencyDetailUrls } from "./portalDetailPolicy";
import { StagedSuumoDiscovery, validateSuumoDiscoveryOptions } from "./suumoDiscovery";
import { StagedPortalDiscovery, validatePortalOptions } from "./portalDiscovery";
import type { SourcePolicyRegistry } from "./sourcePolicy";
import { SOURCE_POLICIES } from "./sourcePolicies";
import { InvalidScrapeBatchError, ScrapeReplayConflictError } from "./errors";
export { InvalidScrapeBatchError, ScrapeReplayConflictError } from "./errors";

/**
 * Versioned application boundary. Scrapers never choose the merge policy or read
 * source revisions; each source's rules come from its registered SourcePolicy.
 */
export class ListingIngestionService implements ScrapeIngestion, DetailEnrichmentPlanner, AgencyDetailPlanner, SuumoDiscoveryClient, PortalDiscoveryClient, NativeCaptureIngestion {
  private readonly validate = (batch: ScrapeSubmission) => validateScrapeBatch(batch, this.policies);

  constructor(
    private readonly repository: ListingRepository,
    private readonly policies: SourcePolicyRegistry = SOURCE_POLICIES,
  ) {}

  async planDetailEnrichment(options: DetailEnrichmentOptions): Promise<readonly string[]> {
    return selectDetailUrls(await this.repository.listSources(), options);
  }

  async planAgencyDetails(options: AgencyDetailOptions): Promise<readonly string[]> {
    const policy = this.policies.get(options?.source);
    if (!policy?.detailPatches) invalid("Unsupported agency detail source");
    return selectAgencyDetailUrls(await this.repository.readSource(policy.source), options, policy.host);
  }

  async beginSuumoDiscovery(input: SuumoDiscoveryOptions): Promise<SuumoDiscoverySession> {
    validateSuumoDiscoveryOptions(input);
    const options = JSON.parse(canonicalJson(input)) as SuumoDiscoveryOptions;
    const previous = await this.repository.readSource("suumo");
    if (!previous || previous.source !== "suumo") invalid("No SUUMO snapshot exists. Initialize preserved history with `npm run data:migrate` first.");
    return new StagedSuumoDiscovery(options, previous, this.validate, (batch, writeOptions) => this.commitScrape(batch, previous, writeOptions));
  }

  async beginPortalDiscovery(input: PortalDiscoveryOptions): Promise<PortalDiscoverySession> {
    const policy = validatePortalOptions(input, this.policies);
    const options = JSON.parse(canonicalJson(input)) as PortalDiscoveryOptions;
    const previous = await this.repository.readSource(options.source);
    return new StagedPortalDiscovery(options, policy.portalDiscovery, previous, this.validate, (batch, writeOptions) => this.commitScrape(batch, previous, writeOptions));
  }

  /** Compatibility run annotations carry no observations and never re-merge source rows. */
  async annotateCaptureRun(input: CaptureRunSummary): Promise<void> {
    if (!input || input.schemaVersion !== 1 || !this.policies.get(input.source)
      || (input.captureRunId !== undefined && !nonempty(input.captureRunId)) || !Array.isArray(input.cities)
      || input.cities.some((city) => !city || !nonempty(city.city) || !Number.isInteger(city.pages) || city.pages < 0 || !Number.isInteger(city.added) || city.added < 0)
      || new Set(input.cities.map((city) => city.city)).size !== input.cities.length) invalid("Invalid capture run summary");
    const summary = JSON.parse(canonicalJson(input)) as CaptureRunSummary;
    const previous = await this.repository.readSource(summary.source);
    if (!previous) return;
    const provenance: Record<string, unknown> = { ...previous.provenance,
      pagesFetched: summary.cities.reduce((n, city) => n + city.pages, 0), newListings: summary.cities.reduce((n, city) => n + city.added, 0),
      cities: summary.cities.map((city) => city.city) };
    if (summary.captureRunId) provenance.captureRunId = summary.captureRunId; else delete provenance.captureRunId;
    delete provenance.newListingIds;
    if (canonicalJson(previous.provenance) === canonicalJson(provenance)) return;
    await this.repository.ingest({ source: summary.source, expectedRevision: previous.revision, observedAt: previous.scrapedAt,
      completeness: "preserve", observations: [], provenance });
  }

  async ingestScrape(request: ScrapeSubmission, options: { allowShrink?: boolean } = {}): Promise<ScrapeIngestionReceipt> {
    this.validate(request);
    // Own an immutable-by-convention JSON copy across asynchronous reads/writes.
    const batch = JSON.parse(canonicalJson(request)) as ScrapeSubmission;
    const previous = await this.repository.readSource(batch.source);
    return this.commitScrape(batch, previous, options);
  }

  private async commitScrape(batch: ScrapeSubmission, previous: ListingSourceSnapshot | null, options: { allowShrink?: boolean }): Promise<ScrapeIngestionReceipt> {
    const fingerprint = await scrapeFingerprint(batch);
    const journal = readJournal(previous?.provenance?.ingestionJournal);
    const priorBatch = journal.batches.find((entry) => entry.runId === batch.runId && entry.batchId === batch.batchId);
    const identity = { source: batch.source, runId: batch.runId, batchId: batch.batchId };
    if (priorBatch) {
      if (priorBatch.fingerprint !== fingerprint) throw new ScrapeReplayConflictError(identity);
      return { ...identity, replayed: true, revision: previous!.revision,
        previousCount: previous!.listings.length, currentCount: previous!.listings.length,
        added: 0, updated: 0, retired: 0, ignored: batch.observations.length, novel: 0, effect: priorBatch.effect };
    }

    const policy = this.policies.get(batch.source);
    const detailPolicy = policy?.detailPatches;
    const prepared = batch.observationKind === "detail-patch"
      ? detailPolicy ? detailPolicy.prepare(batch, previous) : invalid("Unsupported scrape source")
      : policy ? policy.listings.prepare(batch, previous) : invalid("Unsupported scrape source");
    const effect = { added: prepared.added, updated: prepared.updated, novel: prepared.novel,
      observedCount: prepared.observedCount ?? batch.observations.length - prepared.ignored };
    const { observations, provenance: _provenance, ...metadata } = batch;
    const nextJournal: IngestionJournal = { schemaVersion: 1, batches: [...journal.batches, {
      runId: batch.runId, batchId: batch.batchId, fingerprint, metadata, effect,
      evidence: observations.map((observation) => ({
        sourceListingId: observation.sourceListingId, observedAt: observation.observedAt, ...observation.evidence,
      })),
    }] };
    // Journal and rows share one revision-checked atomic commit. A failure cannot
    // mark a batch as applied. Conflicts are surfaced, never retried with new state.
    const result = "reconciliation" in prepared
      ? await this.repository.reconcileSource({ ...prepared.reconciliation, provenance: { ...prepared.reconciliation.provenance, ingestionJournal: nextJournal } }, options)
      : await this.repository.ingest({ ...prepared.batch, provenance: { ...prepared.batch.provenance, ingestionJournal: nextJournal } }, options);
    return { ...identity, replayed: false, revision: result.revision, retired: result.retired,
      added: prepared.added, updated: prepared.updated, ignored: prepared.ignored, novel: prepared.novel,
      previousCount: prepared.previousCount, currentCount: prepared.currentCount, effect };
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

function validateScrapeBatch(batch: ScrapeSubmission, policies: SourcePolicyRegistry): void {
  if (!object(batch) || batch.schemaVersion !== 1) invalid("Unsupported scrape schemaVersion");
  const detailPatch = batch.observationKind === "detail-patch";
  if (batch.observationKind !== undefined && batch.observationKind !== "listing" && !detailPatch) invalid("Unsupported observation kind");
  const policy = policies.get(batch.source);
  if (!policy || (detailPatch && !policy.detailPatches)) invalid("Unsupported scrape source");
  const detailPolicy = policy.detailPatches;
  const strictDiscovery = !detailPatch && policy.listings.exactUrlDiscovery;
  const nativeCapture = batch.scraper?.name === "native-capture";
  const detailImportProducer = policy.listings.detailImportProducer;
  if ((batch.mode !== "discovery" && batch.mode !== "detail-enrichment") || (detailPatch && batch.mode !== "detail-enrichment")
    || (!detailPatch && (!detailImportProducer || nativeCapture) && batch.mode !== "discovery")) {
    invalid("Unsupported scrape mode; full snapshots require a reviewed exhaustion-evidence policy");
  }
  const validUrl = (value: unknown) => sourceUrl(value, policy.host);
  const expectedProducer = detailPatch ? detailPolicy!.producer : nativeCapture ? "native-capture" : batch.mode === "discovery" ? `${batch.source}-list` : detailImportProducer;
  const parserVersions = detailPatch ? detailPolicy!.parserVersions ?? ["1"]
    : !nativeCapture && batch.mode === "detail-enrichment" ? policy.listings.detailImportParserVersions ?? ["1"]
    : ["1"];
  if (!object(batch.scraper) || batch.scraper.name !== expectedProducer || batch.scraper.version !== "1"
    || !parserVersions.includes(batch.scraper.parserVersion)) {
    invalid("Unsupported or missing scraper name/version/parserVersion");
  }
  if (!nonempty(batch.runId) || !nonempty(batch.batchId) || !timestamp(batch.capturedAt)) invalid("Invalid run/batch identity or capture time");
  if (!object(batch.scope) || !Array.isArray(batch.scope.urls) || !batch.scope.urls.every(validUrl)
    || !Array.isArray(batch.scope.cities) || !batch.scope.cities.every(nonempty) || !object(batch.scope.filters)
    || !Object.values(batch.scope.filters).every((value) => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
    invalid("Invalid scrape scope");
  }
  if (batch.provenance !== undefined && (!object(batch.provenance) || MANAGED_INGESTION_PROVENANCE_KEYS.some((key) => key in batch.provenance!))) invalid("Invalid/reserved scrape provenance");
  if (!Array.isArray(batch.observations) || (strictDiscovery && !nativeCapture && !batch.observations.length)) invalid("Observations must be a non-empty array for SUUMO discovery");
  const seen = new Map<string, string>();
  for (const observation of batch.observations) {
    if (!object(observation) || !nonempty(observation.sourceListingId)) invalid("Missing observation identity");
    if (observation.observedAt === null) {
      if (detailPatch || strictDiscovery || batch.mode !== "detail-enrichment") invalid("Only legacy detail captures may have unknown observation time");
    } else if (!timestamp(observation.observedAt) || (strictDiscovery && Date.parse(observation.observedAt) > Date.parse(batch.capturedAt))) invalid("Invalid observation timestamp");
    if (!object(observation.evidence) || !nonempty(observation.evidence.captureId) || !validUrl(observation.evidence.url)
      || !batch.scope.urls.includes(observation.evidence.url)) invalid("Missing or out-of-scope observation evidence");
    if (detailPatch) {
      if (observation.sourceListingId !== observation.evidence.url || "listing" in observation || !("details" in observation)) invalid("Invalid detail patch identity/payload");
      detailPolicy!.validate(observation.details);
    } else {
      if (!("listing" in observation) || !object(observation.listing) || "details" in observation) invalid("Missing observation listing");
      const listing = observation.listing;
      if (strictDiscovery && !nonempty(listing.id)) invalid("SUUMO summary observation requires its display ID");
      if (listing.source !== batch.source || !validUrl(listing.url)
        || (strictDiscovery ? observation.sourceListingId !== listing.url : (listing.id != null ? listing.id !== observation.sourceListingId : observation.sourceListingId !== listing.url))) invalid("Observation source/identity mismatch");
      if (!nonempty(listing.name) || !nonempty(listing.address) || typeof listing.rent !== "number" || !Number.isFinite(listing.rent) || listing.rent <= 0
        || (listing.sizeM2 !== null && (typeof listing.sizeM2 !== "number" || !Number.isFinite(listing.sizeM2) || listing.sizeM2 <= 0))
        || typeof listing.layout !== "string" || Number(listing.layout.normalize("NFKC").match(/^\d+/)?.[0] ?? 0) < 2) invalid("Invalid family listing fields");
      for (const key of ["status", "firstSeenAt", "lastSeenAt", "soldAt", "sourceListings"] as const) {
        if (listing[key] !== undefined) invalid(`Scrapers cannot assign canonical field ${key}`);
      }
    }
    const encoded = canonicalJson(observation);
    // A bounded crawl can see the same ad on multiple pages/capture times.
    // Reject contradictions within one capture, but let the source policy choose
    // between independently captured observations instead of deduplicating here.
    const key = batch.mode === "discovery" ? JSON.stringify([observation.sourceListingId, observation.observedAt, observation.evidence.url, observation.evidence.captureId]) : observation.sourceListingId;
    if (seen.has(key) && seen.get(key) !== encoded) invalid("Conflicting observations for one source listing ID");
    seen.set(key, encoded);
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
    if (entry.effect !== undefined && (!object(entry.effect) || !["added", "updated", "novel", "observedCount"].every((field) => Number.isInteger(entry.effect && (entry.effect as Record<string, unknown>)[field]) && Number((entry.effect as Record<string, unknown>)[field]) >= 0))) invalid("Invalid persisted ingestion effects");
    keys.add(key);
  }
  return value as unknown as IngestionJournal;
}
