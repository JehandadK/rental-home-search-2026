/**
 * Listing filters. Pure, testable predicates that narrow the listing set
 * before scoring/ranking. The headline feature is area (町名) filtering with
 * an include/exclude mode, so you can focus on — or rule out — specific
 * neighbourhoods.
 */
import type { EnrichedListing } from "../types";
import type { ListingScore } from "./scoring";
import { isNewListing, isSold } from "./lifecycle";
import type { MarkFilter } from "./marks";

export type AreaMode = "include" | "exclude";

/**
 * Which lifecycle states to show:
 *   all    — active and sold (sold are marked, never silently dropped)
 *   active — only currently advertised listings
 *   sold   — only sold listings (what did we miss?)
 */
export type StatusFilter = "all" | "active" | "sold";

export interface ListingFilters {
  /** Cities to keep (empty set = all cities). */
  cities: string[];
  /** Neighbourhoods (町名) named in the area filter. */
  areas: string[];
  /**
   * How `areas` is applied:
   *   include — keep only listings in the named areas
   *   exclude — drop listings in the named areas
   */
  areaMode: AreaMode;
  /** Rent bounds in yen; null = unbounded. */
  rentMin: number | null;
  rentMax: number | null;
  /** Floor-area bounds in ㎡; null = unbounded. */
  sizeMin: number | null;
  sizeMax: number | null;
  /** Layout prefixes to keep, e.g. "3" matches 3K/3DK/3LDK (empty = all). */
  layouts: string[];
  /** Minimum weighted score, 0–100. */
  minScore: number;
  /**
   * Parking requirement:
   *   any      — no constraint
   *   required — a space must be available (free or paid)
   *   free     — a space must be available at no monthly charge
   */
  parking: "any" | "required" | "free";
  /** Reject listings whose monthly parking charge exceeds this (yen). */
  parkingMaxYen: number | null;
  /** Lifecycle visibility: show sold listings or not. */
  status: StatusFilter;
  /** Keep only listings first seen within the NEW window (14 days). */
  newOnly: boolean;
  /**
   * How the user's decision marks narrow the set. The marks themselves are
   * user state and live in their own store, so this filter is applied by the
   * caller via matchesMarkFilter — matchesListing stays pure on listing data.
   */
  markFilter: MarkFilter;
}

export const EMPTY_FILTERS: ListingFilters = {
  cities: [],
  areas: [],
  areaMode: "include",
  rentMin: null,
  rentMax: null,
  sizeMin: null,
  sizeMax: null,
  layouts: [],
  minScore: 0,
  parking: "any",
  parkingMaxYen: null,
  status: "all",
  newOnly: false,
  markFilter: "all",
};

/**
 * Extract the neighbourhood (町名) from a Japanese address: drop the
 * prefecture and city, then strip any trailing block/丁目 numbers.
 * "埼玉県草加市金明町１" → "金明町"; "埼玉県越谷市大字袋山" → "大字袋山".
 */
export function listingArea(listing: EnrichedListing): string {
  let s = listing.address.replace(/^.*?[都道府県]/, "");
  s = s.replace(/^.*?[市区町村]/, "");
  s = s.replace(/[0-9０-９].*$/, "");
  s = s.replace(/[一二三四五六七八九十]+丁目.*$/, "");
  s = s.replace(/丁目.*$/, "");
  return s.trim();
}

/** The layout family digit, e.g. "3LDK" → "3", "ワンルーム" → "1". */
export function layoutFamily(layout: string | null): string | null {
  if (!layout) return null;
  const m = layout.match(/^(\d+)/);
  return m ? m[1] : null;
}

/** All distinct areas present in a listing set, sorted by frequency. */
export function areaOptions(
  listings: readonly EnrichedListing[],
  cities: readonly string[] = [],
): string[] {
  const counts = new Map<string, number>();
  for (const l of listings) {
    if (cities.length > 0 && (!l.city || !cities.includes(l.city))) continue;
    const area = listingArea(l);
    if (area) counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([area]) => area);
}

/** All distinct cities present, in first-seen order. */
export function cityOptions(listings: readonly EnrichedListing[]): string[] {
  const seen: string[] = [];
  for (const l of listings) {
    if (l.city && !seen.includes(l.city)) seen.push(l.city);
  }
  return seen;
}

/** All distinct layout families present, sorted ascending. */
export function layoutOptions(listings: readonly EnrichedListing[]): string[] {
  const set = new Set<string>();
  for (const l of listings) {
    const fam = layoutFamily(l.layout);
    if (fam) set.add(fam);
  }
  return [...set].sort((a, b) => Number(a) - Number(b));
}

/** True when a listing passes every active filter (score-independent parts). */
export function matchesListing(listing: EnrichedListing, filters: ListingFilters): boolean {
  if (filters.cities.length > 0 && !(listing.city && filters.cities.includes(listing.city))) {
    return false;
  }

  if (filters.areas.length > 0) {
    const inArea = filters.areas.includes(listingArea(listing));
    if (filters.areaMode === "include" && !inArea) return false;
    if (filters.areaMode === "exclude" && inArea) return false;
  }

  if (filters.rentMin != null && listing.rent < filters.rentMin) return false;
  if (filters.rentMax != null && listing.rent > filters.rentMax) return false;

  if (filters.sizeMin != null && (listing.sizeM2 == null || listing.sizeM2 < filters.sizeMin)) {
    return false;
  }
  if (filters.sizeMax != null && (listing.sizeM2 == null || listing.sizeM2 > filters.sizeMax)) {
    return false;
  }

  if (filters.layouts.length > 0) {
    const fam = layoutFamily(listing.layout);
    if (!fam || !filters.layouts.includes(fam)) return false;
  }

  if (!matchesParking(listing, filters)) return false;

  if (filters.status === "active" && isSold(listing)) return false;
  if (filters.status === "sold" && !isSold(listing)) return false;
  if (filters.newOnly && !isNewListing(listing)) return false;

  return true;
}

/**
 * Parking constraints. Listings that simply never stated their parking are
 * kept — excluding them would silently hide most of the market rather than
 * answering the question asked.
 */
function matchesParking(listing: EnrichedListing, filters: ListingFilters): boolean {
  const parking = listing.parking ?? listing.costs?.parking ?? null;
  const stated = parking != null;

  if (filters.parking === "required" && stated && !parking.available) return false;
  if (filters.parking === "free" && stated && (!parking.available || (parking.monthlyYen ?? 0) > 0)) {
    return false;
  }

  if (filters.parkingMaxYen != null && stated && parking.available) {
    const cost = parking.monthlyYen;
    if (cost != null && cost > filters.parkingMaxYen) return false;
  }

  return true;
}

/** True when a scored listing passes the score-dependent filters too. */
export function matchesScored(
  listing: EnrichedListing,
  score: ListingScore,
  filters: ListingFilters,
): boolean {
  if (!matchesListing(listing, filters)) return false;
  if (filters.minScore > 0 && (score.total ?? -1) < filters.minScore) return false;
  return true;
}

/** Count how many filters are currently active (for the panel's badge). */
export function activeFilterCount(filters: ListingFilters): number {
  let n = 0;
  if (filters.cities.length) n++;
  if (filters.areas.length) n++;
  if (filters.rentMin != null || filters.rentMax != null) n++;
  if (filters.sizeMin != null || filters.sizeMax != null) n++;
  if (filters.layouts.length) n++;
  if (filters.minScore > 0) n++;
  if (filters.parking !== "any") n++;
  if (filters.parkingMaxYen != null) n++;
  if (filters.status !== "all") n++;
  if (filters.newOnly) n++;
  if (filters.markFilter !== "all") n++;
  return n;
}
