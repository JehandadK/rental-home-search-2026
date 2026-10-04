/**
 * Reads persisted files into property-sync evidence. Pure mappers take file
 * contents (current or historical: git revisions, backups); `readCurrentEvidence`
 * reads today's files from data/.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AvailabilityCheckEvidence, PropertyEvidence, PropertySyncReport, SourceEvidence } from "../../data-layer/properties/contracts";
import { syncPropertyDocuments } from "../../data-layer/properties/service";
import { sourceObservationFallbackTime } from "../../data-layer/sourceObservationTime";
import { trackingKey } from "../../domain/listingIdentity";
import type { RawListing } from "../../domain/types";
import { readAvailabilityFile, type AvailabilityFile } from "./availabilityStore";
import { MANIFEST_PATH, RAW_PATH, listSources, type BuildManifest, type SourceFile } from "./dataStore";
import { JsonPropertyDocumentStore } from "./propertyDocumentStore";

const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Capture times exactly as the build trusts them (see restoreObservedLifecycle). */
export function sourceFileEvidence(file: SourceFile): SourceEvidence {
  const observedKeys = new Set(Array.isArray(file.provenance?.observedTrackingKeys) ? (file.provenance.observedTrackingKeys as string[]) : []);
  const times = (file.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const fallback = sourceObservationFallbackTime(file);
  const rows = (file.listings ?? []).map((listing) => {
    const key = trackingKey(listing);
    const at = times[key] ?? (file.completeSnapshot === true || observedKeys.has(key) ? fallback : undefined);
    return { listing: { ...listing, source: listing.source ?? file.source }, observedAt: isTime(at) ? at : null };
  });
  const archived = (file.archivedListings ?? [])
    .filter((entry) => entry.listing && isTime(entry.retiredAt))
    .map((entry) => ({ listing: { ...entry.listing, source: entry.listing.source ?? file.source }, retiredAt: entry.retiredAt, reason: entry.reason }));
  const journal = file.provenance?.ingestionJournal as { batches?: { evidence?: { sourceListingId?: string; observedAt?: string | null; captureId?: string }[] }[] } | undefined;
  const sightings = (journal?.batches ?? []).flatMap((batch) => batch.evidence ?? [])
    .filter((entry): entry is { sourceListingId: string; observedAt: string; captureId?: string } => typeof entry.sourceListingId === "string" && isTime(entry.observedAt))
    .map(({ sourceListingId, observedAt, captureId }) => ({ sourceListingId, observedAt, ...(captureId ? { captureId } : {}) }));
  return { source: file.source, rows, archived, sightings };
}

/** Every check in the file: the latest per ad plus its retained history. */
export function availabilityEvidence(file: AvailabilityFile): AvailabilityCheckEvidence[] {
  return Object.entries(file.records).flatMap(([key, record]) => {
    const { history = [], ...latest } = record;
    // Older history entries have no URL; they were checks of the record's ad.
    return [latest, ...history].map((check) => ({
      key, source: record.source, url: ("url" in check && check.url) || record.url,
      state: check.state, checkedAt: check.checkedAt, evidence: check.evidence, method: check.method,
    }));
  });
}

export async function readCurrentEvidence(via: string, recordedAt = new Date().toISOString()): Promise<PropertyEvidence> {
  const rows = existsSync(RAW_PATH) ? (JSON.parse(await readFile(RAW_PATH, "utf8")) as RawListing[]) : [];
  const manifest = existsSync(MANIFEST_PATH) ? (JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as BuildManifest) : null;
  return {
    recordedAt,
    via,
    canonical: { builtAt: manifest?.builtAt ?? null, rows },
    sources: (await listSources()).map(sourceFileEvidence),
    availability: availabilityEvidence(await readAvailabilityFile()),
  };
}

/** Fold every current data file into the property documents. */
export async function syncCurrentProperties(via: string, store = new JsonPropertyDocumentStore()): Promise<PropertySyncReport> {
  return syncPropertyDocuments(store, await readCurrentEvidence(via));
}
