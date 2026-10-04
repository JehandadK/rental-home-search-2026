/**
 * Pure helpers for SUUMO's fast "new listings only" refresh.
 *
 * The same room is often advertised by several agencies, so SUUMO's `bc`
 * value alone is NOT a property identity. Matching uses several aliases:
 *   1. bc / jnc source id (exact advertisement),
 *   2. name + address + size (same property despite rent changes),
 *   3. address + rent + size + layout (same room under a generic title).
 *
 * Incremental refresh overlays freshly scraped summary fields onto existing
 * records while preserving expensive detail-page data (parking), and never
 * removes unseen records — absence can only be established by a full audit.
 */
import type { RawListing } from "../../domain/types";
import { trackingKey } from "../../domain/listingIdentity";

const norm = (value: string | null | undefined): string =>
  (value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** Stable primary identity, useful for logs and exact advertisement matching. */
export function suumoKey(listing: RawListing): string {
  const bc = listing.url?.match(/[?&]bc=(\d+)/)?.[1];
  if (bc) return `bc:${bc}`;
  const jnc = listing.url?.match(/\/jnc_(\d+)/)?.[1];
  if (jnc) return `jnc:${jnc}`;
  return `property:${trackingKey(listing)}`;
}

/** Ordered aliases from strongest to broadest same-room evidence. */
export function suumoMatchKeys(listing: RawListing): string[] {
  const keys = [suumoKey(listing), `property:${trackingKey(listing)}`];
  // Different agencies commonly use different names for an identical room.
  // Address + rent + area + layout is sufficiently specific for this app's
  // one-representative-room-per-building model.
  keys.push(
    `market:${norm(listing.address)}|${listing.rent}|${listing.sizeM2 ?? ""}|${norm(listing.layout)}`,
  );
  return [...new Set(keys)];
}

/** New ingestion also honors an exact ad URL when a page lacks bc/jnc parameters. */
export function suumoDiscoveryMatchKeys(listing: RawListing): string[] {
  return [...new Set([...(listing.url ? [`url:${listing.url}`] : []), ...suumoMatchKeys(listing)])];
}

/** True when two records have any strong source/property/market alias in common. */
export function isSuumoOverlap(a: RawListing, b: RawListing): boolean {
  const aKeys = new Set(suumoMatchKeys(a));
  return suumoMatchKeys(b).some((key) => aKeys.has(key));
}

/**
 * Fresh records first. Only aliases explained by this discovery are compacted,
 * not unseen old duplicates; the caller archives the replaced rows.
 */
export function mergeSuumoObserved(
  existing: readonly RawListing[],
  discovered: readonly RawListing[],
): { listings: RawListing[]; added: number; updated: number; overlaps: number } {
  const matchKeys = suumoDiscoveryMatchKeys;
  const existingByAlias = new Map<string, RawListing>();
  for (const listing of existing) {
    for (const alias of matchKeys(listing)) {
      if (!existingByAlias.has(alias)) existingByAlias.set(alias, listing);
    }
  }

  const seenAliases = new Set<string>();
  const consumedExisting = new Set<RawListing>();
  const listings: RawListing[] = [];
  let added = 0;
  let updated = 0;
  let overlaps = 0;

  for (const fresh of discovered) {
    const aliases = matchKeys(fresh);
    if (aliases.some((alias) => seenAliases.has(alias))) {
      overlaps++;
      continue;
    }

    const priors = aliases
      .map((alias) => existingByAlias.get(alias))
      .filter((listing): listing is RawListing => listing != null);
    // Prefer the overlapping agency record that already has slow detail data.
    const prior = priors.find((listing) => listing.parking != null) ?? priors[0];
    aliases.forEach((alias) => seenAliases.add(alias));

    if (prior) {
      overlaps++;
      updated++;
      consumedExisting.add(prior);
      matchKeys(prior).forEach((alias) => seenAliases.add(alias));
      // Fresh summary fields win; slow detail-page parking survives until a
      // forced parking backfill explicitly replaces it.
      listings.push({ ...prior, ...fresh, ...(prior.parking ? { parking: prior.parking } : {}) });
    } else {
      added++;
      listings.push(fresh);
    }
  }

  for (const prior of existing) {
    if (consumedExisting.has(prior)) continue;
    // Also suppress a prior duplicate if its aliases overlap a discovery that
    // already represented it. This gracefully compacts historical agency ads.
    if (matchKeys(prior).some((alias) => seenAliases.has(alias))) continue;
    listings.push(prior);
  }

  return { listings, added, updated, overlaps };
}
