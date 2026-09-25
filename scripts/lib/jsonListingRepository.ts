import type {
  ListingIngestionResult,
  ListingObservationBatch,
  ListingRepository,
  ListingSourceSnapshot,
} from "../../src/data-layer/contracts";
import type { RawListing } from "../../src/types";
import { RevisionConflictError } from "../../src/data-layer/errors";
import { JsonSourceStore } from "./dataStore";

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
    const provenance = { ...previous?.provenance, ...batch.provenance };
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
}

function validateBatch(batch: ListingObservationBatch): void {
  if (!batch.source.trim()) throw new InvalidListingBatchError("Source is required");
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
    if (seen.has(observation.sourceListingId)) {
      throw new InvalidListingBatchError(`Duplicate sourceListingId ${observation.sourceListingId} in batch`);
    }
    if (observation.listing.source !== batch.source) {
      throw new InvalidListingBatchError(`Listing source ${observation.listing.source} does not match batch ${batch.source}`);
    }
    seen.add(observation.sourceListingId);
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
