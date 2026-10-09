import type {
  HistoricalSourceSeed,
  ListingIngestionResult,
  ListingObservationBatch,
  ListingRepository,
  ListingSourceSnapshot,
  SourceReconciliation,
} from "../../data-layer/contracts";
import type { RawListing } from "../../domain/types";
import { RevisionConflictError } from "../../data-layer/errors";
import { indexSourceRows, sourceRowKey, sourceRowLocator } from "../../data-layer/sourceRowIdentity";
import { invalidBootstrap, legacySource, validateJsonValue, validateLegacyListing, validateSourceId } from "../../data-layer/bootstrap/validation";
import { JsonSourceStore, type SourceFile } from "./dataStore";

export class InvalidListingBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidListingBatchError";
  }
}

/**
 * Application-facing repository adapter over the per-source JSON store.
 * Complete snapshots retire absent source rows into an archive; incremental
 * absence never deletes, though a validated rule may explicitly retire a
 * superseded source ID with a reason.
 */
export class JsonListingRepository implements ListingRepository {
  constructor(private readonly sourceStore: JsonSourceStore) {}

  async readSource(source: string): Promise<ListingSourceSnapshot | null> {
    const stored = await this.sourceStore.readSource(source);
    if (!stored) return null;
    return {
      source: stored.source,
      revision: stored.revision!,
      scrapedAt: stored.scrapedAt,
      completeSnapshot: stored.completeSnapshot === true,
      listings: stored.listings,
      archivedListings: stored.archivedListings ?? [],
      provenance: stored.provenance,
    };
  }

  async listSources(): Promise<readonly ListingSourceSnapshot[]> {
    const stored = await this.sourceStore.listSources();
    return stored.map((source) => ({
      source: source.source,
      revision: source.revision!,
      scrapedAt: source.scrapedAt,
      completeSnapshot: source.completeSnapshot === true,
      listings: source.listings,
      archivedListings: source.archivedListings ?? [],
      provenance: source.provenance,
    }));
  }

  async initializeHistoricalSource(seed: HistoricalSourceSeed, options: { expectedRevision: null }): Promise<{ revision: string }> {
    validateSourceId(seed.source);
    if (options.expectedRevision !== null) invalidBootstrap("Historical bootstrap requires expectedRevision: null");
    if (typeof seed.importedAt !== "string" || !Number.isFinite(Date.parse(seed.importedAt))) invalidBootstrap("Invalid bootstrap import time");
    if (!Array.isArray(seed.listings)) invalidBootstrap("Historical listings must be an array");
    validateJsonValue(seed.listings);
    validateJsonValue(seed.provenance);
    for (const listing of seed.listings) {
      validateLegacyListing(listing);
      if (legacySource(listing) !== seed.source) invalidBootstrap("Historical row belongs to a different source");
    }
    const result = await this.sourceStore.writeSource({
      source: seed.source,
      // Compatibility envelope timestamp, explicitly NOT observation evidence.
      // The audit retains importedAt; readers use the empty evidence maps below.
      scrapedAt: seed.importedAt,
      completeSnapshot: false,
      provenance: { ...seed.provenance, observedTrackingKeys: [], observedAtByKey: {} },
      // Ordinary ingestion expects modern RawListing rows. This one-time seam
      // deliberately preserves older shapes (including missing source/ID) verbatim.
      listings: seed.listings.map((listing) => listing as RawListing),
    }, { expectedRevision: null });
    return { revision: result.revision };
  }

  async reconcileSource(batch: SourceReconciliation, options: { allowShrink?: boolean } = {}): Promise<ListingIngestionResult> {
    validateSourceId(batch.source);
    if ((batch.expectedRevision !== null && !batch.expectedRevision) || !Number.isFinite(Date.parse(batch.observedAt))) throw new InvalidListingBatchError("Invalid reconciliation revision/time");
    if (batch.listings.some((listing) => listing.source !== batch.source)) throw new InvalidListingBatchError("Reconciliation source mismatch");
    const previous = await this.sourceStore.readSource(batch.source);
    if (batch.expectedRevision !== (previous?.revision ?? null)) {
      throw new RevisionConflictError(batch.expectedRevision, previous?.revision ?? null, this.sourceStore.sourcePath(batch.source));
    }
    const priorRows = indexSourceRows(previous?.listings ?? []), currentRows = indexSourceRows(batch.listings);
    const retired = new Map<string, SourceReconciliation["retirements"][number]>();
    for (const retirement of batch.retirements) {
      const key = sourceRowKey(retirement);
      if (!priorRows.has(key) || currentRows.has(key) || retired.has(key) || !retirement.reason.trim() || !Number.isFinite(Date.parse(retirement.effectiveAt))) {
        throw new InvalidListingBatchError("Invalid/unknown reconciliation retirement or retained locator");
      }
      retired.set(key, retirement);
    }
    for (const key of priorRows.keys()) {
      if (!currentRows.has(key) && !retired.has(key)) throw new InvalidListingBatchError("Reconciliation cannot omit a source row without an explicit retirement");
    }
    let accepted = 0, unchanged = 0;
    for (const [key, row] of currentRows) {
      const prior = priorRows.get(key);
      if (prior && sameListing(prior, row)) unchanged++; else accepted++;
    }
    const archivedListings = [...(previous?.archivedListings ?? []), ...[...retired].map(([key, retirement]) => ({
      sourceListingId: sourceRowLocator(priorRows.get(key)!).sourceListingId, listing: priorRows.get(key)!,
      retiredAt: retirement.effectiveAt, reason: retirement.reason,
    }))];
    const result = await this.sourceStore.writeSource({ source: batch.source, scrapedAt: batch.observedAt,
      completeSnapshot: false, listings: [...batch.listings], archivedListings,
      provenance: batch.provenance ? { ...batch.provenance } : previous?.provenance,
    }, { expectedRevision: batch.expectedRevision, force: options.allowShrink });
    return { accepted, unchanged, retired: retired.size, revision: result.revision };
  }

  async ingest(
    batch: ListingObservationBatch,
    options: { allowShrink?: boolean } = {},
  ): Promise<ListingIngestionResult> {
    validateBatch(batch);
    const previous = await this.sourceStore.readSource(batch.source);
    const actualRevision = previous?.revision ?? null;
    if (batch.expectedRevision !== actualRevision) {
      throw new RevisionConflictError(batch.expectedRevision, actualRevision, this.sourceStore.sourcePath(batch.source));
    }

    if (batch.completeness === "preserve") {
      if (!previous || batch.retirements?.length) {
        throw new InvalidListingBatchError("Preserving enrichment requires an existing source and cannot retire rows");
      }
      return this.enrichExisting(batch, previous);
    }
    const observations = new Map(
      batch.observations.map((observation) => [
        observation.sourceListingId,
        normalizeListing(observation.sourceListingId, batch.source, observation.listing),
      ]),
    );
    const previousById = new Map(
      (previous?.listings ?? []).map((listing) => [sourceListingId(listing), listing]),
    );

    let accepted = 0;
    let unchanged = 0;
    for (const [id, listing] of observations) {
      const prior = previousById.get(id);
      if (prior && sameListing(prior, listing)) unchanged++;
      else accepted++;
    }

    const complete = batch.completeness === "complete";
    const current = complete ? new Map<string, RawListing>() : new Map(previousById);
    for (const [id, listing] of observations) current.set(id, listing);

    const retiredListings = new Map<string, { listing: RawListing; retiredAt: string; reason: string }>();
    for (const retirement of batch.retirements ?? []) {
      const previousListing = previousById.get(retirement.id);
      if (!previousListing) throw new InvalidListingBatchError(`Cannot retire unknown sourceListingId ${retirement.id}`);
      if (observations.has(retirement.id)) {
        throw new InvalidListingBatchError(`Cannot observe and retire ${retirement.id} in the same batch`);
      }
      current.delete(retirement.id);
      retiredListings.set(retirement.id, {
        listing: previousListing,
        retiredAt: retirement.effectiveAt,
        reason: retirement.reason,
      });
    }
    if (complete) {
      for (const [id, listing] of previousById) {
        if (observations.has(id) || retiredListings.has(id)) continue;
        retiredListings.set(id, {
          listing,
          retiredAt: batch.observedAt,
          reason: "Absent from a validated complete source snapshot",
        });
      }
    }

    const archivedListings = [...(previous?.archivedListings ?? [])];
    for (const [id, retirement] of retiredListings) {
      // Retrying the same source revision conflicts before reaching this point;
      // reactivation followed by a later retirement remains a separate event.
      archivedListings.push({
        sourceListingId: id,
        listing: retirement.listing,
        retiredAt: retirement.retiredAt,
        reason: retirement.reason,
      });
    }

    const listings = [...current.values()];
    const provenance = batch.provenance ? { ...batch.provenance } : previous?.provenance;
    const result = await this.sourceStore.writeSource(
      {
        source: batch.source,
        scrapedAt: batch.observedAt,
        completeSnapshot: complete,
        provenance,
        archivedListings,
        listings,
      },
      {
        expectedRevision: batch.expectedRevision,
        force: options.allowShrink,
      },
    );

    return {
      accepted,
      unchanged,
      retired: retiredListings.size,
      revision: result.revision,
    };
  }

  private async enrichExisting(batch: ListingObservationBatch, previous: SourceFile): Promise<ListingIngestionResult> {
    // Do not put legacy rows in an ID-keyed Map: distinct ads can share an old
    // generated ID. Enrichment must not deduplicate/reorder unrelated history.
    const listings = [...previous.listings];
    const touched = new Set<number>();
    let accepted = 0, unchanged = 0;
    for (const observation of batch.observations) {
      const matches = previous.listings.flatMap((listing, index) =>
        sourceListingId(listing) === observation.sourceListingId && (observation.targetUrl === undefined || listing.url === observation.targetUrl) ? [index] : []);
      if (!matches.length) throw new InvalidListingBatchError("Preserving enrichment cannot add source listing IDs");
      if (matches.length !== 1) throw new InvalidListingBatchError("Ambiguous enrichment identity; supply an exact targetUrl");
      const index = matches[0], prior = previous.listings[index];
      if (touched.has(index)) throw new InvalidListingBatchError("Cannot enrich a source row twice in one batch");
      if (observation.listing.id !== prior.id || observation.listing.url !== prior.url || observation.listing.source !== prior.source) {
        throw new InvalidListingBatchError("Preserving enrichment cannot change source identity");
      }
      touched.add(index);
      listings[index] = observation.listing;
      if (sameListing(prior, observation.listing)) unchanged++; else accepted++;
    }
    const result = await this.sourceStore.writeSource({ ...previous, listings,
      provenance: batch.provenance ? { ...batch.provenance } : previous.provenance,
    }, { expectedRevision: batch.expectedRevision });
    return { accepted, unchanged, retired: 0, revision: result.revision };
  }
}

function validateBatch(batch: ListingObservationBatch): void {
  if (!batch.source.trim()) throw new InvalidListingBatchError("Source is required");
  if (!["incremental", "complete", "preserve"].includes(batch.completeness)) {
    throw new InvalidListingBatchError("Invalid snapshot completeness");
  }
  if (!Number.isFinite(Date.parse(batch.observedAt))) {
    throw new InvalidListingBatchError("observedAt must be a valid timestamp");
  }
  const seen = new Set<string>();
  for (const observation of batch.observations) {
    if (observation.source !== batch.source) {
      throw new InvalidListingBatchError(`Observation source ${observation.source} does not match batch ${batch.source}`);
    }
    if (!observation.sourceListingId.trim()) {
      throw new InvalidListingBatchError("Every observation requires a stable sourceListingId");
    }
    if (observation.targetUrl !== undefined && (batch.completeness !== "preserve" || !observation.targetUrl.trim())) {
      throw new InvalidListingBatchError("targetUrl is only supported for exact existing-row enrichment");
    }
    const key = batch.completeness === "preserve"
      ? JSON.stringify([observation.sourceListingId, observation.targetUrl ?? null]) : observation.sourceListingId;
    if (seen.has(key)) {
      throw new InvalidListingBatchError(`Duplicate sourceListingId ${observation.sourceListingId} in batch`);
    }
    if (observation.listing.source !== batch.source) {
      throw new InvalidListingBatchError(`Listing source ${observation.listing.source} does not match batch ${batch.source}`);
    }
    seen.add(key);
  }
  const retiredIds = new Set<string>();
  for (const retirement of batch.retirements ?? []) {
    if (!retirement.id.trim() || retiredIds.has(retirement.id) || !retirement.reason.trim()) {
      throw new InvalidListingBatchError(`Invalid or duplicate retirement ID ${retirement.id}`);
    }
    if (!Number.isFinite(Date.parse(retirement.effectiveAt))) {
      throw new InvalidListingBatchError(`Retirement ${retirement.id} has an invalid effectiveAt`);
    }
    if (seen.has(retirement.id)) {
      throw new InvalidListingBatchError(`Cannot observe and retire ${retirement.id} in the same batch`);
    }
    retiredIds.add(retirement.id);
  }
}

function normalizeListing(id: string, source: string, listing: RawListing): RawListing {
  return { ...listing, id, source };
}

function sourceListingId(listing: RawListing): string {
  return listing.id ?? listing.url ?? `${listing.name}\u0000${listing.address}`;
}

function sameListing(a: RawListing, b: RawListing): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
