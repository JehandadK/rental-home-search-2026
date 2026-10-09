/**
 * Rented-out detection across portals.
 *
 * A property is "rented out" only when EVERY portal ad we know for it has been
 * seen gone (its own "no longer available" page). One live ad keeps it
 * available. This is separate from `sold`, which is inferred from a listing
 * being absent from crawls and is therefore weak evidence.
 *
 * Availability records are keyed per portal ad, so the same room can be gone
 * on one portal and still listed on another.
 */
import { sourceListings } from "./listingDedup";
import type { AdAvailability, RawListing, SourceListingReference } from "./types";

export type { AdAvailability } from "./types";

/** Availability records keyed by {@link adKey}. */
export type AvailabilityMap = Record<string, AdAvailability & { source: string; url: string }>;

/** How the ad id is embedded in each portal's URL. Tracking query strings are ignored. */
const AD_ID_PATTERNS: Record<string, RegExp> = {
  suumo: /\/chintai\/(jnc_\d+)/,
  athome: /\/chintai\/(\d+)\//,
  nifty: /\/(detail_[0-9a-f]+)/,
  roomspot: /\/rent\/(\d+)/,
  yahoo: /\/rent\/detail\/[^/]+\/(\d+)/,
};

/** Stable identity of one portal ad: `source|id`, else `source|url without query`. */
export function adKey(source: string, url: string | null | undefined, id?: string | null): string {
  if (url) {
    const match = AD_ID_PATTERNS[source]?.exec(url);
    if (match) return `${source}|${match[1]}`;
    return `${source}|${url.replace(/[?#].*$/, "")}`;
  }
  return `${source}|${id ?? ""}`;
}

/**
 * Row ids that embed the portal's own ad id, as each collector builds them.
 * SUUMO row ids are built from listing content (name, layout, rent) and are
 * neither unique nor stable, so they have no entry.
 */
const ROW_ID_PATTERNS: Record<string, { pattern: RegExp; adId: (match: RegExpExecArray) => string }> = {
  athome: { pattern: /^athome-(\d+)$/, adId: (m) => m[1] },
  nifty: { pattern: /^nifty-([0-9a-f]+)$/, adId: (m) => `detail_${m[1]}` },
  roomspot: { pattern: /^roomspot-(\d+)$/, adId: (m) => m[1] },
  yahoo: { pattern: /^yahoo-(\d+)$/, adId: (m) => m[1] },
};

/** The ad key a row id stands for, when the id embeds the portal's ad id. */
export function adKeyFromRowId(source: string, id: string | null | undefined): string | undefined {
  const rule = id ? ROW_ID_PATTERNS[source] : undefined;
  const match = rule?.pattern.exec(id!);
  return match ? `${source}|${rule!.adId(match)}` : undefined;
}

/**
 * One advertisement, as finely as the portal distinguishes them. Like
 * {@link adKey}, except:
 *  - a URL-less row with a portal-derived id gets the key its URL would have;
 *  - a SUUMO ad is its `jnc` page plus its `bc` code (SUUMO物件コード): a
 *    re-posted room gets a new `bc`, and an ended `bc` redirects away while
 *    the same `jnc` shows another room, so neither alone identifies an ad.
 */
export function listingAdKey(source: string, url: string | null | undefined, id?: string | null): string {
  if (!url) return adKeyFromRowId(source, id) ?? adKey(source, url, id);
  const bc = source === "suumo" ? /[?&]bc=(\d+)/.exec(url)?.[1] : undefined;
  return bc ? `${adKey(source, url, id)}|bc_${bc}` : adKey(source, url, id);
}

/** The more recent check; on a tie the existing value wins so re-applying records is a no-op. */
const newer = (a?: AdAvailability, b?: AdAvailability): AdAvailability | undefined =>
  !a ? b : !b ? a : Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a;

/** The latest known state of one ad, from its own record and an extra map (e.g. manual marks). */
export function adAvailability(ref: SourceListingReference, extra?: AvailabilityMap): AdAvailability | undefined {
  const record = extra?.[adKey(ref.source, ref.url, ref.id)];
  return newer(ref.availability, record && { state: record.state, checkedAt: record.checkedAt, evidence: record.evidence, method: record.method });
}

/** True when the listing has ads and every one of them is known to be gone. */
export function isRentedOut(listing: RawListing): boolean {
  const ads = sourceListings(listing);
  return ads.length > 0 && ads.every((ad) => ad.availability?.state === "gone");
}

/**
 * Overlay availability records onto a listing's ads. Returns the same object
 * when nothing changes, so unrelated rows keep their identity in memoised views.
 */
export function withAvailability<T extends RawListing>(listing: T, records: AvailabilityMap): T {
  const ads = sourceListings(listing);
  let changed = false;
  const merged = ads.map((ad) => {
    const availability = adAvailability(ad, records);
    if (availability === ad.availability) return ad;
    changed = true;
    return { ...ad, availability };
  });
  return changed ? { ...listing, sourceListings: merged } : listing;
}

/** Plain-language summary of one ad for tooltips: "gone on 2026-09-30 (HTTP 404 · …)". */
export function describeAvailability(availability: AdAvailability | undefined): string {
  if (!availability) return "not checked";
  const day = availability.checkedAt.slice(0, 10);
  const how = availability.method === "manual" ? "marked by hand" : "checked";
  return `${availability.state === "gone" ? "gone" : "still listed"} · ${how} ${day}${availability.evidence ? ` · ${availability.evidence}` : ""}`;
}
