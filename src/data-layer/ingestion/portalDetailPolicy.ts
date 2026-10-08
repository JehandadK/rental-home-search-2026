/**
 * AtHome and RoomSpot detail pages, read only for the agency store their list
 * pages leave out. A patch can add a store to an existing exact-URL row; it can
 * never discover, retire or reprice an ad, or clear anything already stored.
 */
import type { RawListing } from "../../domain/types";
import { trackingKey } from "../../domain/listingIdentity";
import type { ListingObservationBatch, ListingSourceSnapshot } from "../contracts";
import type { AgencyDetailOptions, DetailPatchBatch } from "./contracts";
import { addAgency, isListingAgency } from "./agencyPatch";
import { InvalidScrapeBatchError } from "./errors";

const PORTALS = ["athome", "roomspot"] as const;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Runtime allowlist: `agency` and `agencyInfo` only, both or neither, naming one
 * store. A page without the store block submits `{}`.
 */
export function validateAgencyDetailPatch(value: unknown): void {
  const valid = object(value) && Object.keys(value).every((key) => key === "agency" || key === "agencyInfo")
    && ((value.agency === undefined && value.agencyInfo === undefined)
      || (typeof value.agency === "string" && isListingAgency(value.agencyInfo) && value.agencyInfo.name === value.agency));
  if (!valid) throw new InvalidScrapeBatchError("Invalid or forbidden detail patch fields");
}

function persistedDetailTimes(previous: ListingSourceSnapshot): Record<string, string> {
  const times = previous.provenance?.detailObservedAtByUrl;
  if (times !== undefined && (!object(times) || !Object.values(times).every((at) => typeof at === "string" && Number.isFinite(Date.parse(at))))) {
    throw new InvalidScrapeBatchError("Invalid persisted detail observation times");
  }
  return { ...times as Record<string, string> | undefined };
}

/**
 * Current ads still missing their store (every ad with `force`), most recently
 * seen first: those are the pages most likely to still be up.
 */
export function selectAgencyDetailUrls(previous: ListingSourceSnapshot | null, options: AgencyDetailOptions, host: string): string[] {
  if (!object(options) || !(PORTALS as readonly unknown[]).includes(options.source) || typeof options.force !== "boolean") {
    throw new InvalidScrapeBatchError("Invalid agency detail selection options");
  }
  if (!previous || previous.source !== options.source) throw new InvalidScrapeBatchError(`${options.source} source missing`);
  const seenAt = (previous.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const time = (listing: RawListing) => Date.parse(seenAt[trackingKey(listing)] ?? "") || 0;
  const onHost = (url: string) => {
    try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === host && !parsed.username && !parsed.password; }
    catch { return false; }
  };
  const rows = previous.listings.filter((listing) => listing.url && onHost(listing.url) && listing.status !== "sold"
    && (options.force || !listing.agencyInfo));
  rows.sort((a, b) => time(b) - time(a) || a.url!.localeCompare(b.url!));
  return [...new Set(rows.map((listing) => listing.url!))];
}

/** Exact-ad-only enrichment, as for SUUMO: market observation times never advance here. */
export function preparePortalDetailBatch(request: DetailPatchBatch, previous: ListingSourceSnapshot | null) {
  if (!previous || previous.source !== request.source) throw new InvalidScrapeBatchError(`${request.source} source missing`);
  const byUrl = new Map<string, RawListing[]>();
  for (const listing of previous.listings) {
    if (listing.url) byUrl.set(listing.url, [...(byUrl.get(listing.url) ?? []), listing]);
  }
  const times = persistedDetailTimes(previous);
  const seen = new Set<string>();
  const observations: ListingObservationBatch["observations"][number][] = [];
  let updated = 0;
  for (const observation of request.observations) {
    const url = observation.evidence.url;
    const matches = byUrl.get(url);
    if (!matches) throw new InvalidScrapeBatchError(`Cannot enrich unknown source URL: ${url}`);
    if (seen.has(url)) continue;
    seen.add(url);
    // No freshness gate: adding a store never replaces one, so an older capture
    // (or a re-parse of one by a newer parser) can still fill what is missing.
    if (!times[url] || Date.parse(observation.observedAt) > Date.parse(times[url])) times[url] = observation.observedAt;
    let changed = false;
    for (const listing of matches) {
      const agency = addAgency(listing, observation.details);
      if (!agency) continue;
      changed = true;
      observations.push({ source: request.source, sourceListingId: listing.id ?? url, targetUrl: url,
        observedAt: observation.observedAt, listing: { ...listing, ...agency } });
    }
    if (changed) updated++;
  }
  const batch: ListingObservationBatch = {
    source: request.source, expectedRevision: previous.revision, observedAt: previous.scrapedAt,
    completeness: "preserve", observations,
    // The capture evidence lives in the ingestion journal; list provenance stays as it was.
    provenance: { ...previous.provenance, detailObservedAtByUrl: times },
  };
  return { batch, added: 0, updated, novel: 0, ignored: request.observations.length - updated,
    previousCount: previous.listings.length, currentCount: previous.listings.length };
}
