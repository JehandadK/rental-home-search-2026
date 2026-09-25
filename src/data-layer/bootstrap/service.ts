import type { LegacyListing, ListingRepository } from "../contracts";
import { contentFingerprint } from "../contentIdentity";
import type { SourceBootstrap, SourceBootstrapAudit, SourceBootstrapRequest, SourceBootstrapResult } from "./contracts";
import { invalidBootstrap, legacySource, nonempty, object, validateJsonValue, validateLegacyListing } from "./validation";
export { InvalidSourceBootstrapError } from "./validation";

/** Validated historical initialization. Existing sources are never reconciled or overwritten. */
export class SourceBootstrapService implements SourceBootstrap {
  constructor(private readonly repository: ListingRepository, private readonly now = () => new Date()) {}

  async bootstrapSources(input: SourceBootstrapRequest, onSource?: (result: SourceBootstrapResult) => void): Promise<readonly SourceBootstrapResult[]> {
    validateRequest(input);
    // Own the input across awaits; preserve property order and every JSON value.
    const request = JSON.parse(JSON.stringify(input)) as SourceBootstrapRequest;
    const groups = new Map<string, LegacyListing[]>();
    for (const listing of request.input.records) {
      const source = legacySource(listing);
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source)!.push(listing);
    }
    const fingerprint = await contentFingerprint(request.input.records);
    const results: SourceBootstrapResult[] = [];
    let importedAt: string | undefined;
    for (const [source, listings] of groups) {
      const previous = await this.repository.readSource(source);
      let result: SourceBootstrapResult;
      if (previous) {
        result = { source, status: "skipped", count: listings.length, revision: previous.revision };
      } else {
        importedAt ??= this.now().toISOString();
        const bootstrapAudit: SourceBootstrapAudit = {
          schemaVersion: 1, migration: request.migration, operationId: request.operationId,
          actor: request.actor, reason: request.reason, importedAt, captureSemantics: "historical-only",
          input: { datasetId: request.input.datasetId, recordCount: request.input.records.length, fingerprint },
          source, recordCount: listings.length, recordsFingerprint: await contentFingerprint(listings),
        };
        // The authoritative existence/revision check is repeated under the storage
        // lock. A racing creator conflicts; do not retry or silently overwrite it.
        const created = await this.repository.initializeHistoricalSource({ source, importedAt, listings,
          provenance: { migratedFrom: request.input.datasetId, note: "captured before the per-source store existed", bootstrapAudit },
        }, { expectedRevision: null });
        result = { source, status: "created", count: listings.length, revision: created.revision };
      }
      results.push(result);
      onSource?.(result);
    }
    return results;
  }
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function validateRequest(request: SourceBootstrapRequest): void {
  validateJsonValue(request);
  if (!object(request) || !keys(request, ["schemaVersion", "migration", "operationId", "actor", "reason", "input"]) || request.schemaVersion !== 1) invalidBootstrap("Invalid bootstrap request/schemaVersion");
  if (!object(request.migration) || !keys(request.migration, ["name", "version"]) || request.migration.name !== "legacy-source-split" || request.migration.version !== "1") invalidBootstrap("Unsupported bootstrap migration/version");
  if (!nonempty(request.operationId) || !nonempty(request.actor) || !nonempty(request.reason)) invalidBootstrap("Bootstrap operationId, actor and reason are required");
  if (!object(request.input) || !keys(request.input, ["datasetId", "records"]) || !nonempty(request.input.datasetId) || !Array.isArray(request.input.records)) invalidBootstrap("Invalid legacy dataset input");
  // Validate every group before even reading a target source. A bad later row
  // must not leave an earlier source initialized from an invalid input dataset.
  for (const listing of request.input.records) validateLegacyListing(listing);
}
