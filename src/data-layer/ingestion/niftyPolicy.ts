import type { RawListing } from "../../domain/types";
import { trackingKey } from "../../domain/listingIdentity";
import type { ListingSourceSnapshot } from "../contracts";
import { exactReconciliation } from "./reconciliation";
import { sourceObservationFallbackTime, sourceSnapshotCaptureTime } from "../sourceObservationTime";
import type { ScrapeBatch } from "./contracts";
import type { SourcePolicy } from "./sourcePolicy";

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export function niftyMatchKeys(l: RawListing): string[] {
  return [l.id ?? l.url ?? trackingKey(l), `property:${trackingKey(l)}`, `market:${norm(l.address)}|${l.rent}|${l.sizeM2}|${l.layout}`];
}

/** Existing source identity/detail-preservation policy, independent of HTML and storage. */
export function mergeNiftyIncremental(existing: readonly RawListing[], fresh: readonly RawListing[]): { listings: RawListing[]; added: number; updated: number; overlaps: number } {
  const aliases = new Map(existing.flatMap((l) => niftyMatchKeys(l).map((k) => [k, l] as const)));
  const seen = new Set<string>(), used = new Set<RawListing>(), listings: RawListing[] = [];
  let added = 0, updated = 0;
  for (const l of fresh) {
    const keys = niftyMatchKeys(l);
    if (keys.some((k) => seen.has(k))) continue;
    const prior = keys.map((k) => aliases.get(k)).find(Boolean);
    keys.forEach((k) => seen.add(k));
    if (prior) {
      used.add(prior); updated++;
      listings.push({ ...prior, ...l, ...(l.parking?.available && prior.parking?.available && prior.parking.monthlyYen != null ? { parking: prior.parking } : {}), costs: { ...prior.costs, ...l.costs },
        ...(prior.tenancy || l.tenancy ? { tenancy: { ...prior.tenancy, ...l.tenancy } } : {}),
        building: { ...prior.building, ...l.building, features: [...new Set([...(prior.building?.features ?? []), ...(l.building?.features ?? [])])] } });
    } else { listings.push(l); added++; }
  }
  listings.push(...existing.filter((l) => !used.has(l) && !niftyMatchKeys(l).some((k) => seen.has(k))));
  return { listings, added, updated, overlaps: updated };
}

/**
 * Fields an older detail capture may still add to a row that has never had
 * them. Later list crawls advance a row's observation time but never carry
 * these, so newer-only merging would leave them unfillable from saved pages.
 */
const GAP_FILL_FIELDS = ["agency", "agencyInfo"] as const;

function gapFill(prior: RawListing, detail: RawListing): Partial<RawListing> | null {
  // A row that already names a different store keeps it: agency and agencyInfo describe one store.
  if (prior.agency != null && prior.agency !== detail.agency) return null;
  const fill = Object.fromEntries(GAP_FILL_FIELDS.filter((field) => prior[field] == null && detail[field] != null)
    .map((field) => [field, detail[field]]));
  return Object.keys(fill).length ? fill : null;
}

export function prepareNiftyBatch(request: ScrapeBatch, previous: ListingSourceSnapshot | null) {
  const aliases = new Map((previous?.listings ?? []).flatMap((l) => niftyMatchKeys(l).map((key) => [key, l] as const)));
  const priorTimes = (previous?.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const fills = new Map<RawListing, Partial<RawListing>>();
  // A later crawl retired these ads (usually superseded by a relisting); an old dump must not revive them.
  const retiredAt = new Map((previous?.archivedListings ?? []).map((archived) => [niftyMatchKeys(archived.listing)[0], archived.retiredAt]));
  const eligible = request.observations.filter((observation) => {
    const prior = niftyMatchKeys(observation.listing).map((key) => aliases.get(key)).find(Boolean);
    if (!prior) {
      const retired = request.mode === "detail-enrichment" ? retiredAt.get(niftyMatchKeys(observation.listing)[0]) : undefined;
      return !retired || (observation.observedAt !== null && Date.parse(observation.observedAt) > Date.parse(retired));
    }
    const previousTime = priorTimes[trackingKey(prior)] ?? sourceObservationFallbackTime(previous);
    // Detail imports only replace strictly older evidence. Discovery may replay
    // an equal timestamp, but cannot overwrite a newer captured price either.
    const delta = observation.observedAt === null ? -Infinity
      : Date.parse(observation.observedAt) - (previousTime ? Date.parse(previousTime) : -Infinity);
    const newer = request.mode === "detail-enrichment" ? delta > 0 : delta >= 0;
    // Undated or older captures cannot replace anything, only fill what is absent.
    const fill = !newer && request.mode === "detail-enrichment" ? gapFill(prior, observation.listing) : null;
    if (fill) fills.set(prior, { ...fill, ...fills.get(prior) });
    return newer;
  });
  const novel = eligible.filter((observation) => !niftyMatchKeys(observation.listing).some((key) => aliases.has(key))).length;
  const fresh = eligible.map((observation) => observation.listing);
  const existing = (previous?.listings ?? []).map((listing) => fills.has(listing) ? { ...listing, ...fills.get(listing) } : listing);
  const merged = mergeNiftyIncremental(existing, fresh);
  const observedAtByKey = { ...priorTimes };
  for (const observation of eligible) {
    if (observation.observedAt !== null) observedAtByKey[trackingKey(observation.listing)] = observation.observedAt;
  }
  const previousCaptureTime = previous ? sourceSnapshotCaptureTime(previous) : undefined;
  const observedAt = previousCaptureTime && Date.parse(previousCaptureTime) > Date.parse(request.capturedAt)
    ? previousCaptureTime : request.capturedAt;
  const reconciliation = exactReconciliation(request.source, previous, merged.listings, observedAt, {
    ...previous?.provenance, ...request.provenance,
    observedTrackingKeys: eligible.filter((observation) => observation.observedAt !== null).map((observation) => trackingKey(observation.listing)),
    observedAtByKey,
  });
  return { reconciliation, added: merged.added, updated: merged.updated + fills.size, novel, observedCount: eligible.length,
    ignored: request.observations.length - merged.added - merged.updated - fills.size,
    previousCount: previous?.listings.length ?? 0, currentCount: merged.listings.length };
}

export const niftySourcePolicy: SourcePolicy = {
  source: "nifty",
  host: "myhome.nifty.com",
  // Legacy detail-page dumps (`npm run import:nifty`) may add missing rows.
  // Parser 2 itemises fee notes (full-width thousands separators, no renewal fees).
  // Parser 4 adds the agency store; older captures may fill it in (GAP_FILL_FIELDS).
  listings: {
    prepare: prepareNiftyBatch,
    exactUrlDiscovery: false,
    detailImportProducer: "nifty-detail",
    detailImportParserVersions: ["1", "2", "3", "4"],
  },
};
