/**
 * The recommendation pipeline: from published listings and one person's
 * criteria to ranked, scored homes. Pure, no I/O.
 *
 * The dashboard and the recommendations API run the same stages, so the same
 * criteria give the same ranking in both. The dashboard memoises each stage on
 * its own inputs; `recommend` runs them all in one pass.
 *
 *   resolvePlaces            distances to the chosen places
 *   overlayAvailability      hand-made availability marks
 *   mergeConfirmedDuplicates "same home" answers
 *   filterCandidates         listing filters and the decision-mark filter
 *   scoreCandidates          the weighted score
 *   meetsMinScore            the minimum-score cut
 *   emptyResultHints         which filter to relax when nothing is left
 */
import { withAvailability, type AvailabilityMap } from "../availability";
import { relaxationHints, type RelaxationHint } from "../filterRelaxation";
import { matchesListing, type ListingFilters } from "../filters";
import { listingKey } from "../listingKey";
import { matchesMarkFilter, type MarkMap } from "../marks";
import { SCORED_CATEGORIES, type PlaceCatalog } from "../places";
import { applySelection, selectionAllowedSets, type PlaceSelection } from "../placeSelection";
import {
  applySameDecisions,
  carryToLeads,
  resolveDecisions,
  type DuplicateDecision,
  type ResolvedDecisions,
} from "../possibleDuplicates";
import { ProximityIndex } from "../proximityIndex";
import { scoreListing, type ScoredRow } from "../scoring";
import type { ScoringConfig } from "../scoringConfig";
import type { EnrichedListing } from "../types";

/**
 * The listing × place distance matrix for the scored categories. Build it once
 * per listing set: changing which places count is then a cheap reduction.
 */
export function buildProximityIndex(listings: readonly EnrichedListing[], catalog: PlaceCatalog): ProximityIndex {
  return new ProximityIndex(listings, catalog, SCORED_CATEGORIES);
}

/** Listings with every distance measured to the selected places. `index` must be built from `listings`. */
export function resolvePlaces(
  listings: readonly EnrichedListing[],
  index: ProximityIndex,
  selection: PlaceSelection,
): EnrichedListing[] {
  const allowedSets = selectionAllowedSets(selection);
  return listings.map((listing, i) => applySelection(listing, i, index, selection, allowedSets));
}

/** Overlay hand-made availability marks. With none, returns the input so memoised views keep their rows. */
export function overlayAvailability(
  listings: readonly EnrichedListing[],
  records: AvailabilityMap,
): readonly EnrichedListing[] {
  return Object.keys(records).length ? listings.map((listing) => withAvailability(listing, records)) : listings;
}

/** Show each group the person confirmed as one home as its lead listing. */
export function mergeConfirmedDuplicates(
  listings: readonly EnrichedListing[],
  leadOf: ResolvedDecisions["leadOf"],
): readonly EnrichedListing[] {
  return applySameDecisions(listings, { leadOf });
}

/**
 * Apply every score-independent filter, before scoring, so excluded rows never
 * pay for the move-in and distance calculations. `marks` are keyed by
 * listingKey and only matter when `filters.markFilter` is set.
 */
export function filterCandidates(
  listings: readonly EnrichedListing[],
  filters: ListingFilters,
  marks: MarkMap,
): EnrichedListing[] {
  return listings.filter(
    (listing) =>
      matchesListing(listing, filters) &&
      matchesMarkFilter(marks[listingKey(listing)], filters.markFilter),
  );
}

/** Score every candidate, keeping their order. */
export function scoreCandidates(candidates: readonly EnrichedListing[], config: ScoringConfig): ScoredRow[] {
  return candidates.map((listing) => ({ listing, score: scoreListing(listing, config) }));
}

/** Rows at or above the minimum score; an unscoreable row counts as -1. Returns the input when there is no cut. */
export function meetsMinScore(rows: ScoredRow[], minScore: number): ScoredRow[] {
  return minScore > 0 ? rows.filter(({ score }) => (score.total ?? -1) >= minScore) : rows;
}

/** Best score first; unscoreable rows last. Stable, so ties keep their input order. */
export function byScoreDesc(a: ScoredRow, b: ScoredRow): number {
  return (b.score.total ?? -1) - (a.score.total ?? -1);
}

/** 1-based rank of a total among rows: one more than the rows that score strictly higher. */
export function rankOf(rows: readonly ScoredRow[], total: number | null): number {
  const own = total ?? -1;
  return 1 + rows.filter(({ score }) => (score.total ?? -1) > own).length;
}

/**
 * For an empty result: each active filter whose clearing alone would bring
 * homes back, and how many, best first. Runs the full filter pipeline once
 * per active filter, so call it only when nothing matched.
 */
export function emptyResultHints(
  available: readonly EnrichedListing[],
  filters: ListingFilters,
  marks: MarkMap,
  config: ScoringConfig,
): RelaxationHint[] {
  const totals = new Map<EnrichedListing, number>();
  const totalOf = (listing: EnrichedListing) => {
    if (!totals.has(listing)) totals.set(listing, scoreListing(listing, config).total ?? -1);
    return totals.get(listing)!;
  };
  const countMatching = (relaxed: ListingFilters) => available.filter((listing) =>
    matchesListing(listing, relaxed)
    && matchesMarkFilter(marks[listingKey(listing)], relaxed.markFilter)
    && (relaxed.minScore <= 0 || totalOf(listing) >= relaxed.minScore),
  ).length;
  return relaxationHints(filters, countMatching);
}

/** Everything one ranking depends on. */
export interface RecommendationInput {
  /** The published, deduplicated listings. */
  listings: readonly EnrichedListing[];
  /** `buildProximityIndex(listings, catalog)`, built once and reused across requests. */
  index: ProximityIndex;
  config: ScoringConfig;
  filters: ListingFilters;
  selection: PlaceSelection;
  /** Caller-held state; never stored. */
  marks?: MarkMap;
  duplicateDecisions?: Readonly<Record<string, DuplicateDecision>>;
  availabilityMarks?: AvailabilityMap;
}

export interface Recommendation {
  /** Every home after places, availability and duplicate answers; before filters. */
  available: readonly EnrichedListing[];
  /** Homes passing the filters, scored, before the minimum-score cut, in listing order. */
  scored: ScoredRow[];
  /** Homes passing every filter and the minimum score, best first. */
  ranked: ScoredRow[];
  /** Filters to relax when `ranked` is empty but homes exist; empty otherwise. */
  relaxationHints: RelaxationHint[];
}

/** Run the whole pipeline once, as the dashboard does across its memoised stages. */
export function recommend(input: RecommendationInput): Recommendation {
  const { listings, index, config, filters, selection } = input;
  const { leadOf } = resolveDecisions(listings, input.duplicateDecisions ?? {});
  const marks = carryToLeads(input.marks ?? {}, leadOf);

  const resolved = resolvePlaces(listings, index, selection);
  const withMarks = overlayAvailability(resolved, input.availabilityMarks ?? {});
  const available = mergeConfirmedDuplicates(withMarks, leadOf);
  const candidates = filterCandidates(available, filters, marks);
  const scored = scoreCandidates(candidates, config);
  const ranked = [...meetsMinScore(scored, filters.minScore)].sort(byScoreDesc);
  const hints = ranked.length > 0 || available.length === 0
    ? []
    : emptyResultHints(available, filters, marks, config);
  return { available, scored, ranked, relaxationHints: hints };
}
