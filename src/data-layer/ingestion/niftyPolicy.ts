import type { RawListing } from "../../types";
import { trackingKey } from "../../domain/listingIdentity";
import type { ListingSourceSnapshot } from "../contracts";
import { sourceObservationBatch } from "../sourceObservationBatch";
import { sourceObservationFallbackTime, sourceSnapshotCaptureTime } from "../sourceObservationTime";
import type { ScrapeBatch } from "./contracts";

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

export function prepareNiftyBatch(request: ScrapeBatch, previous: ListingSourceSnapshot | null) {
  const aliases = new Map((previous?.listings ?? []).flatMap((l) => niftyMatchKeys(l).map((key) => [key, l] as const)));
  const priorTimes = (previous?.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const eligible = request.observations.filter((observation) => {
    const prior = niftyMatchKeys(observation.listing).map((key) => aliases.get(key)).find(Boolean);
    if (!prior) return true;
    if (observation.observedAt === null) return false;
    const previousTime = priorTimes[trackingKey(prior)] ?? sourceObservationFallbackTime(previous);
    // Detail imports only replace strictly older evidence. Discovery may replay
    // an equal timestamp, but cannot overwrite a newer captured price either.
    const delta = Date.parse(observation.observedAt) - (previousTime ? Date.parse(previousTime) : -Infinity);
    return request.mode === "detail-enrichment" ? delta > 0 : delta >= 0;
  });
  const novel = eligible.filter((observation) => !niftyMatchKeys(observation.listing).some((key) => aliases.has(key))).length;
  const fresh = eligible.map((observation) => observation.listing);
  const merged = mergeNiftyIncremental(previous?.listings ?? [], fresh);
  const observedAtByKey = { ...priorTimes };
  for (const observation of eligible) {
    if (observation.observedAt !== null) observedAtByKey[trackingKey(observation.listing)] = observation.observedAt;
  }
  const previousCaptureTime = previous ? sourceSnapshotCaptureTime(previous) : undefined;
  const observedAt = previousCaptureTime && Date.parse(previousCaptureTime) > Date.parse(request.capturedAt)
    ? previousCaptureTime : request.capturedAt;
  const batch = sourceObservationBatch({
    source: request.source,
    previous: previous?.listings ?? [],
    current: merged.listings,
    expectedRevision: previous?.revision ?? null,
    observedAt,
    observedAtByKey,
    provenance: {
      ...previous?.provenance,
      ...request.provenance,
      observedTrackingKeys: eligible.filter((observation) => observation.observedAt !== null).map((observation) => trackingKey(observation.listing)),
      observedAtByKey,
    },
    matchKeys: niftyMatchKeys,
  });
  return { batch, added: merged.added, updated: merged.updated, novel,
    ignored: request.observations.length - merged.added - merged.updated,
    previousCount: previous?.listings.length ?? 0, currentCount: merged.listings.length };
}
