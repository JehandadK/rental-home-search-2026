import type { RawListing } from "../../types";
import type { ListingSourceSnapshot } from "../contracts";
import { trackingKey } from "../../domain/listingIdentity";
import { sourceObservationBatch } from "../sourceObservationBatch";
import { sourceObservationFallbackTime, sourceSnapshotCaptureTime } from "../sourceObservationTime";
import { exactReconciliation } from "./reconciliation";
import type { ScrapeBatch } from "./contracts";

export type BrowserPortal = "athome" | "roomspot";
const norm = (value: string | null | undefined) => (value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export function athomeKey(row: RawListing): string {
  const id = row.id?.match(/athome-(\d+)/)?.[1] ?? row.url?.match(/\/chintai\/(\d+)/)?.[1];
  return id ? `athome:${id}` : `property:${trackingKey(row)}`;
}
export function roomspotKey(row: RawListing): string {
  const id = row.id?.match(/roomspot-(\d+)/)?.[1] ?? row.url?.match(/\/rent\/(\d+)/)?.[1];
  return id ? `roomspot:${id}` : `property:${trackingKey(row)}`;
}
function keys(source: BrowserPortal, row: RawListing): string[] {
  return [...new Set([source === "athome" ? athomeKey(row) : roomspotKey(row), `property:${trackingKey(row)}`,
    `market:${norm(row.address)}|${row.rent}|${row.sizeM2 ?? ""}|${norm(row.layout)}`])];
}
export const athomeMatchKeys = (row: RawListing) => keys("athome", row);
export const roomspotMatchKeys = (row: RawListing) => keys("roomspot", row);
export const isAthomeOverlap = (a: RawListing, b: RawListing) => athomeMatchKeys(b).some((key) => athomeMatchKeys(a).includes(key));
export const isRoomspotOverlap = (a: RawListing, b: RawListing) => roomspotMatchKeys(b).some((key) => roomspotMatchKeys(a).includes(key));
export const portalDiscoveryKeys = (source: BrowserPortal, row: RawListing) => [...(row.url ? [`url:${row.url}`] : []), ...keys(source, row)];

function merge(source: BrowserPortal, existing: readonly RawListing[], fresh: readonly RawListing[], publicPolicy: boolean) {
  const match = (row: RawListing) => publicPolicy ? portalDiscoveryKeys(source, row) : keys(source, row);
  const byAlias = new Map<string, RawListing>();
  for (const row of existing) for (const alias of match(row)) if (!byAlias.has(alias)) byAlias.set(alias, row);
  const seen = new Set<string>(), used = new Set<RawListing>(), listings: RawListing[] = [];
  let added = 0, updated = 0, overlaps = 0;
  for (const row of fresh) {
    const aliases = match(row);
    if (aliases.some((alias) => seen.has(alias))) { overlaps++; continue; }
    const prior = aliases.map((alias) => byAlias.get(alias)).find(Boolean);
    aliases.forEach((alias) => seen.add(alias));
    if (!prior) { listings.push(row); added++; continue; }
    used.add(prior); updated++; overlaps++;
    if (source === "athome") {
      const parking = row.parking == null ? prior.parking
        : row.parking.available !== false && row.parking.monthlyYen == null && prior.parking?.monthlyYen != null ? prior.parking : row.parking;
      listings.push({ ...prior, ...row, parking, building: { ...prior.building, ...row.building }, costs: { ...prior.costs, ...row.costs, parking: parking ?? null } });
    } else {
      listings.push({ ...prior, ...row, ...(publicPolicy ? {
        ...(prior.costs || row.costs ? { costs: { ...prior.costs, ...row.costs } } : {}),
        ...(prior.building || row.building ? { building: { ...prior.building, ...row.building } } : {}),
        ...(prior.tenancy || row.tenancy ? { tenancy: { ...prior.tenancy, ...row.tenancy } } : {}),
      } : {}) });
    }
  }
  for (const prior of existing) {
    if (used.has(prior) || match(prior).some((alias) => seen.has(alias))) continue;
    if (!publicPolicy) match(prior).forEach((alias) => seen.add(alias));
    listings.push(prior);
  }
  return { listings, added, updated, overlaps };
}
export const mergeAthomeIncremental = (existing: readonly RawListing[], fresh: readonly RawListing[]) => merge("athome", existing, fresh, false);
export const mergeRoomspotIncremental = (existing: readonly RawListing[], fresh: readonly RawListing[]) => merge("roomspot", existing, fresh, false);

/** Compatibility batch builders; new collectors submit observations to the public service instead. */
type LegacyBatchInput = Omit<Parameters<typeof sourceObservationBatch>[0], "source" | "matchKeys"> & { completeness?: "incremental" | "complete" };
function legacyBatch(source: BrowserPortal, input: LegacyBatchInput) {
  if (input.current.some((row) => !row.id)) throw new Error(`${source} listing has no stable source ID`);
  const batch = sourceObservationBatch({ ...input, source, matchKeys: (row) => keys(source, row) });
  return { ...batch, completeness: input.completeness ?? "incremental" as const,
    retirements: batch.retirements?.map((entry) => ({ ...entry, reason: `Superseded by a newer ${source} advertisement with matching unit aliases` })) };
}
export const athomeObservationBatch = (input: LegacyBatchInput) => legacyBatch("athome", input);
export const roomspotObservationBatch = (input: LegacyBatchInput) => legacyBatch("roomspot", input);

export function preparePortalBatch(request: ScrapeBatch, previous: ListingSourceSnapshot | null) {
  const source = request.source as BrowserPortal;
  const match = (row: RawListing) => portalDiscoveryKeys(source, row);
  const byAlias = new Map<string, RawListing>();
  for (const row of previous?.listings ?? []) for (const key of match(row)) if (!byAlias.has(key)) byAlias.set(key, row);
  const times = { ...previous?.provenance?.observedAtByKey as Record<string, string> | undefined };
  const eligible = request.observations.filter((observation) => {
    const prior = match(observation.listing).map((key) => byAlias.get(key)).find(Boolean);
    const at = prior ? times[trackingKey(prior)] ?? sourceObservationFallbackTime(previous) : undefined;
    return at === undefined || Date.parse(observation.observedAt!) >= Date.parse(at);
  });
  const merged = merge(source, previous?.listings ?? [], eligible.map((observation) => observation.listing), true);
  for (const observation of eligible) times[trackingKey(observation.listing)] = observation.observedAt!;
  const previousAt = previous ? sourceSnapshotCaptureTime(previous) : undefined;
  const observedAt = previousAt && Date.parse(previousAt) > Date.parse(request.capturedAt) ? previousAt : request.capturedAt;
  const novelRows = eligible.filter((observation) => !match(observation.listing).some((key) => byAlias.has(key)));
  const provenance: Record<string, unknown> = { ...previous?.provenance, ...request.provenance, newListings: merged.added,
    ...(source === "athome" ? { newListingIds: [...new Set(novelRows.map((observation) => observation.listing.id!))] } : {}),
    observedTrackingKeys: [...new Set(eligible.map((observation) => trackingKey(observation.listing)))], observedAtByKey: times };
  // A direct collector run is not part of an earlier native capture run.
  if (request.scraper.name !== "native-capture") delete provenance.captureRunId;
  const reconciliation = exactReconciliation(request.source, previous, merged.listings, observedAt, provenance);
  return { reconciliation, added: merged.added, updated: merged.updated, novel: novelRows.length, observedCount: eligible.length,
    ignored: request.observations.length - merged.added - merged.updated,
    previousCount: previous?.listings.length ?? 0, currentCount: merged.listings.length };
}
