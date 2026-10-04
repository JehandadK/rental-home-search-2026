import type { RawListing } from "../../domain/types";
import type { ListingSourceSnapshot } from "../contracts";
import { trackingKey } from "../../domain/listingIdentity";
import { sourceObservationFallbackTime, sourceSnapshotCaptureTime } from "../sourceObservationTime";
import { exactReconciliation } from "./reconciliation";
import type { ScrapeBatch } from "./contracts";
import type { SourcePolicy } from "./sourcePolicy";

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

function merge(source: BrowserPortal, existing: readonly RawListing[], fresh: readonly RawListing[]) {
  const match = (row: RawListing) => portalDiscoveryKeys(source, row);
  const byAlias = new Map<string, RawListing>();
  for (const row of existing) for (const alias of match(row)) if (!byAlias.has(alias)) byAlias.set(alias, row);
  // Rooms in one building often share name/address/size, so the shared `property:` alias
  // cannot make two rows with different source IDs the same ad within one batch.
  const seen = new Map<string, string | null>(), used = new Set<RawListing>(), listings: RawListing[] = [];
  const conflicts = (alias: string, id: string | null | undefined) => {
    if (!seen.has(alias)) return false;
    const seenId = seen.get(alias);
    return seenId == null || id == null || seenId === id;
  };
  let added = 0, updated = 0, overlaps = 0;
  for (const row of fresh) {
    const aliases = match(row);
    if (aliases.some((alias) => conflicts(alias, row.id))) { overlaps++; continue; }
    const prior = aliases.map((alias) => byAlias.get(alias)).find((candidate) => candidate && !used.has(candidate));
    aliases.forEach((alias) => seen.set(alias, row.id ?? null));
    if (!prior) { listings.push(row); added++; continue; }
    used.add(prior); updated++; overlaps++;
    // The same ad (source ID) keeps its stored locator: AtHome list hrefs carry a
    // changing sibling-room query, which is not evidence of a new advertisement.
    const locator = prior.id === row.id && prior.url ? { url: prior.url } : {};
    if (source === "athome") {
      const parking = row.parking == null ? prior.parking
        : row.parking.available !== false && row.parking.monthlyYen == null && prior.parking?.monthlyYen != null ? prior.parking : row.parking;
      listings.push({ ...prior, ...row, ...locator, parking, building: { ...prior.building, ...row.building }, costs: { ...prior.costs, ...row.costs, parking: parking ?? null } });
    } else {
      listings.push({ ...prior, ...row, ...locator,
        ...(prior.costs || row.costs ? { costs: { ...prior.costs, ...row.costs } } : {}),
        ...(prior.building || row.building ? { building: { ...prior.building, ...row.building } } : {}),
        ...(prior.tenancy || row.tenancy ? { tenancy: { ...prior.tenancy, ...row.tenancy } } : {}) });
    }
  }
  for (const prior of existing) {
    // Stored rows superseded by a fresh alias are still absorbed (and archived by the caller).
    if (used.has(prior) || match(prior).some((alias) => seen.has(alias))) continue;
    listings.push(prior);
  }
  return { listings, added, updated, overlaps };
}

export function preparePortalBatch(request: ScrapeBatch, previous: ListingSourceSnapshot | null) {
  const source = request.source as BrowserPortal;
  const match = (row: RawListing) => portalDiscoveryKeys(source, row);
  const byAlias = new Map<string, RawListing[]>();
  for (const row of previous?.listings ?? []) for (const key of match(row)) byAlias.set(key, [...(byAlias.get(key) ?? []), row]);
  const times = { ...previous?.provenance?.observedAtByKey as Record<string, string> | undefined };
  // Every stored row an observation could update or supersede must be no newer than it.
  const eligible = request.observations.filter((observation) => {
    const priors = new Set(match(observation.listing).flatMap((key) => byAlias.get(key) ?? []));
    return [...priors].every((prior) => {
      const at = times[trackingKey(prior)] ?? sourceObservationFallbackTime(previous);
      return at === undefined || Date.parse(observation.observedAt!) >= Date.parse(at);
    });
  });
  const merged = merge(source, previous?.listings ?? [], eligible.map((observation) => observation.listing));
  for (const observation of eligible) {
    // A cached page staged after a fresher one must not move stored evidence backwards.
    const key = trackingKey(observation.listing), at = times[key];
    if (at === undefined || Date.parse(observation.observedAt!) > Date.parse(at)) times[key] = observation.observedAt!;
  }
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

export const athomeSourcePolicy: SourcePolicy = {
  source: "athome",
  host: "www.athome.co.jp",
  listings: { prepare: preparePortalBatch, exactUrlDiscovery: false },
  portalDiscovery: {
    keys: (row) => portalDiscoveryKeys("athome", row),
    provenanceCity: (city) => new URL(city.url).pathname.split("/")[3],
    capturedBy: "scripts/scrape-athome.ts",
  },
};

export const roomspotSourcePolicy: SourcePolicy = {
  source: "roomspot",
  host: "www.roomspot.net",
  listings: { prepare: preparePortalBatch, exactUrlDiscovery: false },
  portalDiscovery: {
    keys: (row) => portalDiscoveryKeys("roomspot", row),
    provenanceCity: (city) => city.label,
    capturedBy: "scripts/scrape-roomspot.ts via Pi Control Chrome",
  },
};
