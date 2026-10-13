/**
 * Ranked, explained homes for one resolved request: what the recommendations
 * API returns, without the transport (versions, timestamps, HTTP).
 *
 *   createRecommendationContext  once per listing snapshot
 *   rankHomes                    a page of ranked homes, with the scoring used
 *   explainHome                  one home under the criteria, filters or not
 *   compareHomes                 a few homes side by side
 */
import { isRentedOut } from "../availability";
import { areaOptions, cityOptions, layoutOptions, listingAgencyKeys, listingArea, type ListingFilters } from "../filters";
import { isNewListing } from "../lifecycle";
import { sourceListings } from "../listingDedup";
import { listingKey } from "../listingKey";
import { listingAdKeys } from "../possibleDuplicates";
import { listingPhotos } from "../listingPhotos";
import { computeMoveInCosts, monthlyOutlay, parkingMonthlyYen } from "../moveInCost";
import type { PlaceCatalog } from "../places";
import type { ProximityIndex } from "../proximityIndex";
import { scoreListing, sharedGaps, type ScoredRow } from "../scoring";
import type { EnrichedListing, ScoringCriterionKey } from "../types";
import { isUrListing } from "../ur";
import { toRequestObject, type Criteria, type DataValues } from "./criteriaSchema";
import { scoringSummary, type ScoringSummary } from "./describe";
import { explainScore, type BreakdownItem } from "./explain";
import { buildProximityIndex, recommend, type Recommendation } from "./pipeline";
import type { DecodeContext, DecodedRequest } from "./request";

/** One listing snapshot, prepared once and shared by every request. */
export interface RecommendationContext {
  listings: readonly EnrichedListing[];
  catalog: PlaceCatalog;
  index: ProximityIndex;
  values: Record<DataValues, readonly string[]>;
  decode: DecodeContext;
}

export function createRecommendationContext(listings: readonly EnrichedListing[], catalog: PlaceCatalog): RecommendationContext {
  const values: Record<DataValues, readonly string[]> = {
    cities: cityOptions(listings),
    layouts: layoutOptions(listings),
    areas: areaOptions(listings),
    agencies: [...new Set(listings.flatMap(listingAgencyKeys))].sort(),
  };
  const placeIds = new Map<string, ReadonlySet<string>>();
  return {
    listings,
    catalog,
    index: buildProximityIndex(listings, catalog),
    values,
    decode: {
      values,
      placeIds: (category) => {
        let ids = placeIds.get(category);
        if (!ids) placeIds.set(category, ids = new Set(catalog.inCategory(category).map((place) => place.id)));
        return ids;
      },
    },
  };
}

/** The essentials of a home, for a ranked list. */
export interface HomeSummary {
  name: string;
  address: string;
  city: string | null;
  /** 町名, as filters.areas matches it. */
  area: string;
  layout: string | null;
  sizeM2: number | null;
  builtYear: number | null;
  /** Advertised rent, including 管理費・共益費. */
  rent: number;
  /** Rent, recurring extras and (with travel.includeParking) parking. */
  monthlyTotal: number;
  parkingYen: number | null;
  station: { name: string | null; minutes: number | null };
  status: "active" | "sold";
  isNew: boolean;
  rentedOut: boolean;
  ur: boolean;
  /** Each portal ad for this home. */
  ads: { source: string; url: string | null }[];
  photo: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface RankedHome {
  /** 1 = best; null for a home `explainHome` found outside the ranking. */
  rank: number | null;
  key: string;
  /** The weighted total, 0–100; null when nothing could be scored. */
  score: number | null;
  /** When ranking.sortBy is a criterion: that criterion's 0–100 score. */
  sortScore?: number | null;
  home: HomeSummary;
  reasons: string[];
  concerns: string[];
  breakdown: BreakdownItem[];
  gaps: ScoringCriterionKey[];
  /** Only with view "full". */
  details?: HomeDetails;
}

export interface HomeDetails {
  moveIn: ReturnType<typeof computeMoveInCosts>;
  costs: EnrichedListing["costs"] | null;
  tenancy: EnrichedListing["tenancy"] | null;
  building: EnrichedListing["building"] | null;
  attributes: EnrichedListing["attributes"];
  photos: ReturnType<typeof listingPhotos>;
  sources: ReturnType<typeof sourceListings>;
  location: { lat: number; lon: number } | null;
  agency: string | null;
}

/** A change to the request that would bring homes back, as request paths and their new values. */
export interface RequestHint {
  id: string;
  label: string;
  set: Record<string, unknown>;
  /** Homes that would be ranked with only this change. */
  count: number;
}

export interface RankingResult {
  scoring: ScoringSummary;
  filters: Omit<ListingFilters, "minScore">;
  ranking: Criteria["ranking"] & { minScore: number };
  /** The fully resolved request: resend it to get this ranking again, or change one path to tweak. `state` appears only when sent. */
  request: Record<string, unknown>;
  counts: {
    /** Homes in the data. */
    listings: number;
    /** After "same home" answers merged duplicates. */
    available: number;
    /** Passing filters.*. */
    afterFilters: number;
    /** Also passing ranking.minScore, ranking.minPartScores and state.excludeKeys. */
    ranked: number;
    returned: number;
  };
  results: RankedHome[];
  /** page.offset for the next page; null on the last page. */
  nextOffset: number | null;
  /** When nothing is ranked: single changes that would bring homes back, most first. */
  relaxationHints: RequestHint[];
  warnings: string[];
}

/** Request path of each filter field, for hints. */
const filterPath = (field: keyof ListingFilters) => (field === "minScore" ? "ranking.minScore" : `filters.${field}`);

const partScore = (row: ScoredRow, key: ScoringCriterionKey) => row.score.parts.find((part) => part.key === key)?.score ?? null;

function run(context: RecommendationContext, criteria: Criteria, options: { hints?: boolean } = {}): Recommendation {
  return recommend({
    listings: context.listings,
    index: context.index,
    config: criteria.config,
    filters: criteria.filters,
    selection: criteria.selection,
    marks: criteria.state.marks,
    duplicateDecisions: criteria.state.duplicateDecisions,
    availabilityMarks: criteria.state.availabilityMarks,
  }, options);
}

/** Homes after the score cuts and exclusions that come after the pipeline, in ranking order. */
function finalRows(rows: readonly ScoredRow[], criteria: Criteria, skip?: ScoringCriterionKey | "exclude"): ScoredRow[] {
  const excluded = new Set(skip === "exclude" ? [] : criteria.state.excludeKeys);
  const cuts = Object.entries(criteria.ranking.minPartScores).filter(([key]) => key !== skip) as [ScoringCriterionKey, number][];
  const kept = rows.filter((row) =>
    !excluded.has(listingKey(row.listing))
    && cuts.every(([key, min]) => (partScore(row, key) ?? -1) >= min));
  const { sortBy, order } = criteria.ranking;
  if (sortBy === "score") return order === "desc" ? kept : orderAscending(kept, (row) => row.score.total);
  // Homes with no value for the criterion go last either way; ties keep the best total first.
  const direction = order === "desc" ? 1 : -1;
  return kept.slice().sort((a, b) => {
    const [x, y] = [partScore(a, sortBy), partScore(b, sortBy)];
    if (x == null || y == null) return Number(x == null) - Number(y == null);
    return direction * (y - x) || (b.score.total ?? -1) - (a.score.total ?? -1);
  });
}

/** Lowest first, but homes with no value still last. */
function orderAscending(rows: ScoredRow[], value: (row: ScoredRow) => number | null): ScoredRow[] {
  const known = rows.filter((row) => value(row) != null).reverse();
  return [...known, ...rows.filter((row) => value(row) == null)];
}

export function rankHomes(
  context: RecommendationContext,
  decoded: DecodedRequest,
  options: { now?: Date } = {},
): RankingResult {
  const { criteria } = decoded;
  const recommendation = run(context, criteria);
  const rows = finalRows(recommendation.ranked, criteria);
  const { offset, limit } = criteria.page;
  const page = rows.slice(offset, offset + limit);
  const now = options.now ?? new Date();
  const { minScore, ...filters } = criteria.filters;

  return {
    scoring: scoringSummary(decoded, context.catalog),
    filters,
    ranking: { ...criteria.ranking, minScore },
    request: toRequestObject(criteria, (spec) => spec.group !== "state" || !isEmpty(spec.read(criteria))),
    counts: {
      listings: context.listings.length,
      available: recommendation.available.length,
      afterFilters: recommendation.scored.length,
      ranked: rows.length,
      returned: page.length,
    },
    results: page.map((row, i) => rankedHome(row, offset + i + 1, criteria, now)),
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    relaxationHints: rows.length === 0 && recommendation.available.length > 0 ? hintsFor(context, recommendation, criteria) : [],
    warnings: decoded.warnings,
  };
}

const isEmpty = (value: unknown) =>
  Array.isArray(value) ? value.length === 0 : typeof value === "object" && value !== null && Object.keys(value).length === 0;

/**
 * Each single change that would bring homes back, as request paths. A filter
 * hint is counted through the later cuts too, so applying it really does
 * rank that many homes; hints that would still rank none are left out.
 */
function hintsFor(context: RecommendationContext, recommendation: Recommendation, criteria: Criteria): RequestHint[] {
  const hints: RequestHint[] = [];
  for (const hint of recommendation.relaxationHints) {
    const relaxed: Criteria = { ...criteria, filters: { ...criteria.filters, ...hint.patch } };
    const count = finalRows(run(context, relaxed, { hints: false }).ranked, relaxed).length;
    if (count === 0) continue;
    hints.push({
      id: hint.id,
      label: hint.label,
      set: Object.fromEntries(Object.entries(hint.patch).map(([field, value]) => [filterPath(field as keyof ListingFilters), structuredClone(value)])),
      count,
    });
  }
  // Homes passed the filters but not the later cuts: say which cut to drop.
  if (recommendation.ranked.length > 0) {
    for (const key of Object.keys(criteria.ranking.minPartScores) as ScoringCriterionKey[]) {
      const count = finalRows(recommendation.ranked, criteria, key).length;
      if (count === 0) continue;
      const { [key]: _dropped, ...rest } = criteria.ranking.minPartScores;
      hints.push({ id: `minPartScores.${key}`, label: `minimum ${key} score`, set: { "ranking.minPartScores": rest }, count });
    }
    if (criteria.state.excludeKeys.length) {
      const count = finalRows(recommendation.ranked, criteria, "exclude").length;
      if (count > 0) hints.push({ id: "excludeKeys", label: "excluded homes", set: { "state.excludeKeys": [] }, count });
    }
  }
  return hints.sort((a, b) => b.count - a.count);
}

function rankedHome(row: ScoredRow, rank: number | null, criteria: Criteria, now: Date): RankedHome {
  const { listing, score } = row;
  const full = criteria.view === "full";
  const explanation = explainScore(score, criteria.config, { all: full });
  const { sortBy } = criteria.ranking;
  return {
    rank,
    key: listingKey(listing),
    score: score.total == null ? null : Math.round(score.total * 10) / 10,
    ...(sortBy !== "score" ? { sortScore: partScore(row, sortBy) } : {}),
    home: homeSummary(row, criteria, now),
    ...explanation,
    ...(full ? { details: homeDetails(listing, criteria) } : {}),
  };
}

export function homeSummary({ listing, score }: ScoredRow, criteria: Criteria, now: Date = new Date()): HomeSummary {
  const station = score.parts.find((part) => part.key === "station");
  return {
    name: listing.name,
    address: listing.address,
    city: listing.city ?? null,
    area: listingArea(listing),
    layout: listing.layout,
    sizeM2: listing.sizeM2,
    builtYear: listing.builtYear,
    rent: listing.rent,
    monthlyTotal: monthlyOutlay(listing, criteria.config.includeParking),
    parkingYen: parkingMonthlyYen(listing),
    station: { name: station?.detail ?? listing.advertisedStation ?? null, minutes: station?.value ?? null },
    status: listing.status === "sold" ? "sold" : "active",
    isNew: isNewListing(listing, now, criteria.filters.newWithinDays),
    rentedOut: isRentedOut(listing),
    ur: isUrListing(listing),
    ads: sourceListings(listing).map((ad) => ({ source: ad.source, url: ad.url })),
    photo: listingPhotos(listing)[0]?.url ?? null,
    firstSeenAt: listing.firstSeenAt ?? null,
    lastSeenAt: listing.lastSeenAt ?? null,
  };
}

function homeDetails(listing: EnrichedListing, criteria: Criteria): HomeDetails {
  return {
    moveIn: computeMoveInCosts(listing, criteria.config.moveIn),
    costs: listing.costs ?? null,
    tenancy: listing.tenancy ?? null,
    building: listing.building ?? null,
    attributes: listing.attributes ?? [],
    photos: listingPhotos(listing),
    sources: sourceListings(listing),
    location: listing.lat != null && listing.lon != null ? { lat: listing.lat, lon: listing.lon } : null,
    agency: listing.agencyInfo?.name ?? listing.agency ?? null,
  };
}

export interface HomeExplanation {
  home: RankedHome;
  /** Whether the home passes every filter and cut of the request. */
  ranked: boolean;
  /** Its place among the ranked homes, when it is ranked. */
  rankAmongRanked: number | null;
}

/**
 * One home in full under the given criteria, even when a filter would hide it.
 * Null when no home has this key (after "same home" merges, a merged member's
 * key finds its lead).
 */
export function explainHome(
  context: RecommendationContext,
  decoded: DecodedRequest,
  key: string,
  options: { now?: Date } = {},
): HomeExplanation | null {
  const criteria: Criteria = { ...decoded.criteria, view: "full" };
  const recommendation = run(context, criteria);
  const rows = finalRows(recommendation.ranked, criteria);
  return explainIn(context, recommendation, rows, criteria, key, options.now ?? new Date())?.explanation ?? null;
}

function explainIn(
  context: RecommendationContext,
  recommendation: Recommendation,
  rows: readonly ScoredRow[],
  criteria: Criteria,
  key: string,
  now: Date,
): { explanation: HomeExplanation; row: ScoredRow } | null {
  const listing = findHome(recommendation.available, key, context.listings);
  if (!listing) return null;
  const position = rows.findIndex((row) => row.listing === listing);
  const row: ScoredRow = rows[position] ?? { listing, score: scoreListing(listing, criteria.config) };
  const rank = position >= 0 ? position + 1 : null;
  return { explanation: { home: rankedHome(row, rank, criteria, now), ranked: rank != null, rankAmongRanked: rank }, row };
}

export const MAX_COMPARE_HOMES = 6;

export interface HomeComparison {
  homes: (HomeExplanation | { key: string; missing: true })[];
  /** Weighted criteria none of the found homes has data for. */
  sharedGaps: ScoringCriterionKey[];
}

/** Up to MAX_COMPARE_HOMES homes side by side, each explained in full; unknown keys come back as missing. */
export function compareHomes(
  context: RecommendationContext,
  decoded: DecodedRequest,
  keys: readonly string[],
  options: { now?: Date } = {},
): HomeComparison {
  const criteria: Criteria = { ...decoded.criteria, view: "full" };
  const recommendation = run(context, criteria);
  const rows = finalRows(recommendation.ranked, criteria);
  const now = options.now ?? new Date();
  const found = keys.slice(0, MAX_COMPARE_HOMES).map((key) => ({ key, result: explainIn(context, recommendation, rows, criteria, key, now) }));
  return {
    homes: found.map(({ key, result }) => result?.explanation ?? { key, missing: true as const }),
    sharedGaps: [...sharedGaps(found.flatMap(({ result }) => (result ? [result.row.score] : [])))],
  };
}

/** The shown home with this key, or the lead a merged member's key now belongs to. */
function findHome(
  available: readonly EnrichedListing[],
  key: string,
  original: readonly EnrichedListing[],
): EnrichedListing | undefined {
  const direct = available.find((listing) => listingKey(listing) === key);
  if (direct) return direct;
  const member = original.find((listing) => listingKey(listing) === key);
  if (!member) return undefined;
  const ads = new Set(listingAdKeys(member));
  return available.find((listing) => listingAdKeys(listing).some((ad) => ads.has(ad)));
}
