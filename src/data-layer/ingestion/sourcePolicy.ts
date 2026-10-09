/**
 * Per-source ingestion rules, looked up by source ID.
 *
 * The data layer owns identity, deduplication, and merge decisions for every
 * source, so each site's rules live in a `SourcePolicy`. The ingestion service
 * validates and commits batches generically and asks the registry for the
 * policy; a new site adds one policy file (plus its collector) and registers
 * it in sourcePolicies.ts, without editing the service.
 */
import type { RawListing } from "../../domain/types";
import type { ListingObservationBatch, ListingSourceSnapshot, SourceReconciliation } from "../contracts";
import type { DetailPatchBatch, ScrapeBatch } from "./contracts";

interface PreparedCounts {
  added: number;
  updated: number;
  novel: number;
  ignored: number;
  previousCount: number;
  currentCount: number;
  /** Accepted observations, when the policy counts them itself. */
  observedCount?: number;
}

/** A policy's decision for one batch: exact-row reconciliation or a preserving batch. */
export type PreparedIngestion = PreparedCounts & (
  | { reconciliation: SourceReconciliation }
  | { batch: ListingObservationBatch }
);

export interface SourcePolicy {
  readonly source: string;
  /** Listing and evidence URLs must be https URLs on this host. */
  readonly host: string;
  /** Full-listing observations (`observationKind: "listing"`). */
  readonly listings: {
    prepare(batch: ScrapeBatch, previous: ListingSourceSnapshot | null): PreparedIngestion;
    /**
     * SUUMO-style discovery: the exact source URL is the observation identity,
     * every listing carries its display ID, a direct batch has at least one
     * observation, and no observation is newer than its batch capture.
     */
    readonly exactUrlDiscovery: boolean;
    /** Producer name when this source also accepts legacy detail-page listing imports. */
    readonly detailImportProducer?: string;
    /**
     * Parser versions accepted from the detail-import producer (default ["1"]).
     * A producer that changes how it parses a capture bumps its version and
     * puts it in the run identity, so re-parsing an imported capture is a new
     * batch rather than a replay conflict.
     */
    readonly detailImportParserVersions?: readonly string[];
  };
  /** Partial detail observations for existing exact source URLs. */
  readonly detailPatches?: {
    readonly producer: string;
    /** Parser versions accepted from the detail producer (default ["1"]); see `detailImportParserVersions`. */
    readonly parserVersions?: readonly string[];
    validate(details: unknown): void;
    prepare(batch: DetailPatchBatch, previous: ListingSourceSnapshot | null): PreparedIngestion;
  };
  /** Staged bounded portal discovery (`beginPortalDiscovery`). */
  readonly portalDiscovery?: {
    /** Aliases that make a stored or staged row "known"/"seen". */
    keys(row: RawListing): string[];
    /** City label recorded in the committed batch's provenance. */
    provenanceCity(city: { label: string; url: string }): string;
    readonly capturedBy: string;
  };
}

export class SourcePolicyRegistry {
  private readonly bySource = new Map<string, SourcePolicy>();

  constructor(policies: readonly SourcePolicy[]) {
    for (const policy of policies) {
      if (this.bySource.has(policy.source)) throw new Error(`Duplicate source policy: ${policy.source}`);
      this.bySource.set(policy.source, policy);
    }
  }

  get(source: unknown): SourcePolicy | undefined {
    return typeof source === "string" ? this.bySource.get(source) : undefined;
  }

  get sources(): readonly string[] {
    return [...this.bySource.keys()];
  }
}
