/**
 * Listing filters. Pure, testable predicates that narrow the listing set
 * before scoring/ranking. The headline feature is area (町名) filtering with
 * an include/exclude mode, so you can focus on — or rule out — specific
 * neighbourhoods.
 */
import type { EnrichedListing, ListingAgency } from "./types";
import { agencyIdentity, agencyOf, type AgencyGazetteer } from "./agencyNames";
import type { ReferenceCity } from "./referenceData";
import { isNewListing, isSold, NEW_LISTING_WINDOW_DAYS } from "./lifecycle";
import type { MarkFilter } from "./marks";
import { isRentedOut } from "./availability";

export type AreaMode = "include" | "exclude";

/**
 * Which lifecycle states to show:
 *   all    — active and sold (sold are marked, never silently dropped)
 *   active — only currently advertised listings
 *   sold   — only sold listings (what did we miss?)
 */
export type StatusFilter = "all" | "active" | "sold";

/**
 * Properties whose every portal ad has been seen gone:
 *   hide — leave them out (default)
 *   show — keep them, marked
 *   only — only those (what did we lose?)
 */
export type RentedOutFilter = "hide" | "show" | "only";

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
  /**
   * Agencies named in the agency filter, as `agencyKey` values: a whole chain
   * ("brand:シャーメゾンショップ"), one company with all its stores
   * ("agency:ベストハウジング") or one store ("store:ハウスコム埼玉(株)草加店").
   */
  agencies: string[];
  /**
   * How `agencies` is applied, like `areaMode`. Most ads do not name their
   * agency yet: `include` keeps only listings known to match, `exclude` keeps
   * every listing not known to match (unknown agencies stay).
   */
  agencyMode: AreaMode;
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
  /** Visibility of properties rented out on every portal. */
  rentedOut: RentedOutFilter;
  /** Keep only listings first seen within the NEW window. */
  newOnly: boolean;
  /**
   * How many days a listing counts as new after it is first seen (1–14).
   * Drives the "new only" filter and the NEW badges, rings and count alike.
   */
  newWithinDays: number;
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
  agencies: [],
  agencyMode: "include",
  rentMin: null,
  rentMax: null,
  sizeMin: null,
  sizeMax: null,
  layouts: [],
  minScore: 0,
  parking: "any",
  parkingMaxYen: null,
  status: "all",
  rentedOut: "hide",
  newOnly: false,
  newWithinDays: NEW_LISTING_WINDOW_DAYS,
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

/** Filter key for a whole brand, one agency (company) or one store. */
export const agencyKey = (kind: "brand" | "agency" | "store", name: string): string => `${kind}:${name}`;

function storeFields(listing: EnrichedListing): Pick<ListingAgency, "name" | "brand" | "company" | "branch" | "address" | "inferred"> | null {
  const name = listing.agencyInfo?.name ?? listing.agency;
  if (!name) return null;
  const info = listing.agencyInfo;
  return { name, brand: info?.brand ?? null, company: info?.company ?? null, branch: info?.branch ?? null, address: info?.address ?? null,
    ...(info?.inferred ? { inferred: true as const } : {}) };
}

/** The agency keys a listing matches: its store, its company and its brand, when known. */
export function listingAgencyKeys(listing: EnrichedListing): string[] {
  const store = storeFields(listing);
  if (!store) return [];
  const { agency, groupKey } = agencyOf(store);
  // An inferred advertiser names a company, never one of its stores.
  return [...(store.inferred ? [] : [agencyKey("store", store.name)]), agencyKey("agency", groupKey),
    ...(store.brand && store.brand !== agency ? [agencyKey("brand", store.brand)] : [])];
}

export interface AgencyStoreOption {
  key: string;
  name: string;
  branch: string | null;
  /** The place the branch is named after ("北越谷"), and the city the store is in. */
  place: string | null;
  city: ReferenceCity | null;
  count: number;
}

export interface AgencyOption {
  key: string;
  /** "ベストハウジング", and its English name when every part has one. */
  agency: string;
  agencyEn: string | null;
  count: number;
  stores: AgencyStoreOption[];
}

export interface AgencyBrandOption {
  /** Null for the agencies that belong to no chain. */
  key: string | null;
  brand: string | null;
  brandEn: string | null;
  count: number;
  agencies: AgencyOption[];
}

/**
 * Every agency in a listing set: chains with their member agencies, then
 * independent agencies; each agency with its stores and where they are.
 * Most listings first throughout.
 */
export function agencyOptions(listings: readonly EnrichedListing[], gazetteer: AgencyGazetteer): AgencyBrandOption[] {
  const brands = new Map<string, AgencyBrandOption>();
  for (const listing of listings) {
    const store = storeFields(listing);
    if (!store) continue;
    const identity = agencyIdentity(store, gazetteer);
    const brandId = identity.brand ?? "";
    const brand = brands.get(brandId) ?? { key: identity.brand ? agencyKey("brand", identity.brand) : null,
      brand: identity.brand, brandEn: identity.brandEn, count: 0, agencies: [] };
    brands.set(brandId, brand);
    brand.count++;
    const key = agencyKey("agency", identity.groupKey);
    let agency = brand.agencies.find((option) => option.key === key);
    if (!agency) brand.agencies.push(agency = { key, agency: identity.agency, agencyEn: identity.agencyEn, count: 0, stores: [] });
    agency.count++;
    if (store.inferred) continue;
    let option = agency.stores.find((candidate) => candidate.name === store.name);
    if (!option) agency.stores.push(option = { key: agencyKey("store", store.name), name: store.name, branch: identity.branch,
      place: identity.place?.name ?? null, city: identity.city, count: 0 });
    option.count++;
  }
  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  return [...brands.values()]
    .map((brand) => ({ ...brand, agencies: brand.agencies.map((agency) => ({ ...agency, stores: agency.stores.sort(byCount) })).sort(byCount) }))
    // Chains first, then the independent agencies.
    .sort((a, b) => Number(a.key === null) - Number(b.key === null) || byCount(a, b));
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

  if (filters.agencies.length > 0) {
    const keys = listingAgencyKeys(listing);
    const byAgency = filters.agencies.some((key) => keys.includes(key));
    if (filters.agencyMode === "include" && !byAgency) return false;
    if (filters.agencyMode === "exclude" && byAgency) return false;
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
  if (filters.newOnly && !isNewListing(listing, new Date(), filters.newWithinDays)) return false;

  if (filters.rentedOut !== "show") {
    const rentedOut = isRentedOut(listing);
    if (filters.rentedOut === "hide" && rentedOut) return false;
    if (filters.rentedOut === "only" && !rentedOut) return false;
  }

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

/** Count how many filters are currently active (for the panel's badge). */
export function activeFilterCount(filters: ListingFilters): number {
  let n = 0;
  if (filters.cities.length) n++;
  if (filters.areas.length) n++;
  if (filters.agencies.length) n++;
  if (filters.rentMin != null || filters.rentMax != null) n++;
  if (filters.sizeMin != null || filters.sizeMax != null) n++;
  if (filters.layouts.length) n++;
  if (filters.minScore > 0) n++;
  if (filters.parking !== "any") n++;
  if (filters.parkingMaxYen != null) n++;
  if (filters.status !== "all") n++;
  if (filters.newOnly) n++;
  if (filters.rentedOut !== "hide") n++;
  if (filters.markFilter !== "all") n++;
  return n;
}
