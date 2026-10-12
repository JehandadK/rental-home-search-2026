import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withAvailability, type AvailabilityMap } from "../availability";
import { relaxationHints } from "../filterRelaxation";
import { EMPTY_FILTERS, matchesListing, type ListingFilters } from "../filters";
import { listingKey } from "../listingKey";
import { matchesMarkFilter, type MarkMap } from "../marks";
import { SCORED_CATEGORIES, type PlaceCatalog } from "../places";
import { applySelection, defaultSelection, selectionAllowedSets, type PlaceSelection } from "../placeSelection";
import {
  applySameDecisions,
  carryToLeads,
  listingAdKeys,
  resolveDecisions,
  type DuplicateDecision,
} from "../possibleDuplicates";
import { ProximityIndex } from "../proximityIndex";
import { scoreListing, type ScoredRow } from "../scoring";
import { DEFAULT_CONFIG, type ScoringConfig } from "../scoringConfig";
import type { EnrichedListing } from "../types";
import { unpackListings, type WebPayload } from "../webPayload";
import { applyPreset, BUILT_IN_PRESETS } from "../weightPresets";
import { loadCurrentReferenceModel } from "../../storage/json/currentReference.contract";
import {
  buildProximityIndex,
  byScoreDesc,
  filterCandidates,
  meetsMinScore,
  overlayAvailability,
  rankOf,
  recommend,
  type RecommendationInput,
} from "./pipeline";

let CATALOG: PlaceCatalog;
beforeAll(async () => {
  CATALOG = (await loadCurrentReferenceModel()).catalog;
});

const make = (over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  id: "athome-1",
  name: "ベレオ ヴィラ リーブス東川口",
  address: "埼玉県草加市金明町１",
  city: "Soka",
  rent: 100_000,
  layout: "3LDK",
  sizeM2: 60,
  builtYear: 2015,
  stationWalkMin: 8,
  url: "https://www.athome.co.jp/chintai/1/",
  source: "athome",
  geocoded: true,
  lat: 35.8282,
  lon: 139.8033,
  ...over,
});

const row = (total: number | null, id = String(total)): ScoredRow => ({
  listing: make({ id }),
  score: { total, parts: [] },
});

const input = (listings: EnrichedListing[], over: Partial<RecommendationInput> = {}): RecommendationInput => ({
  listings,
  index: buildProximityIndex(listings, CATALOG),
  config: DEFAULT_CONFIG,
  filters: EMPTY_FILTERS,
  selection: defaultSelection(),
  ...over,
});

describe("pipeline stages", () => {
  it("returns the input itself when there is nothing to overlay or cut", () => {
    const listings = [make()];
    expect(overlayAvailability(listings, {})).toBe(listings);
    const rows = [row(10)];
    expect(meetsMinScore(rows, 0)).toBe(rows);
  });

  it("cuts on the minimum score, counting an unscoreable row as -1", () => {
    expect(meetsMinScore([row(40), row(60), row(null)], 50).map((r) => r.score.total)).toEqual([60]);
  });

  it("sorts best first, unscoreable last, and keeps ties in input order", () => {
    const rows = [row(50, "a"), row(null, "n"), row(80, "b"), row(50, "c")];
    expect([...rows].sort(byScoreDesc).map((r) => r.listing.id)).toEqual(["b", "a", "c", "n"]);
  });

  it("ranks a total by how many rows score strictly higher", () => {
    const rows = [row(80), row(50), row(50), row(null)];
    expect(rankOf(rows, 80)).toBe(1);
    expect(rankOf(rows, 50)).toBe(2);
    expect(rankOf(rows, null)).toBe(4);
  });

  it("applies the decision-mark filter with marks keyed by listing", () => {
    const [keep, drop] = [make({ id: "athome-1" }), make({ id: "athome-2" })];
    const marks: MarkMap = { [listingKey(drop)]: "not-interested" };
    expect(filterCandidates([keep, drop], { ...EMPTY_FILTERS, markFilter: "hideRuledOut" }, marks)).toEqual([keep]);
    expect(filterCandidates([keep, drop], EMPTY_FILTERS, marks)).toEqual([keep, drop]);
  });
});

describe("recommend", () => {
  it("ranks the filtered homes best first", () => {
    const listings = [
      make({ id: "athome-1", rent: 150_000 }),
      make({ id: "athome-2", rent: 70_000 }),
      make({ id: "athome-3", rent: 110_000, layout: "1K" }),
    ];
    const result = recommend(input(listings, { filters: { ...EMPTY_FILTERS, layouts: ["3"] } }));
    expect(result.ranked.map((r) => r.listing.id)).toEqual(["athome-2", "athome-1"]);
    expect(result.scored).toHaveLength(2);
    expect(result.available).toHaveLength(3);
    expect(result.relaxationHints).toEqual([]);
  });

  it("says which filter to relax when nothing is left", () => {
    const listings = [make({ id: "athome-1", rent: 150_000 }), make({ id: "athome-2", rent: 90_000 })];
    const result = recommend(input(listings, { filters: { ...EMPTY_FILTERS, rentMax: 50_000 } }));
    expect(result.ranked).toEqual([]);
    expect(result.relaxationHints).toEqual([expect.objectContaining({ id: "rent", count: 2 })]);
  });

  it("shows homes confirmed as one once, and carries a member's mark to the lead", () => {
    const athome = make();
    const nifty = make({
      id: "nifty-0a1b2c",
      source: "nifty",
      url: "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_0a1b2c/",
    });
    const same: DuplicateDecision = {
      verdict: "same", a: listingAdKeys(athome), b: listingAdKeys(nifty), decidedAt: "2026-10-11T05:00:00.000Z",
    };
    const marks: MarkMap = { [listingKey(nifty)]: "not-interested" };
    const shown = recommend(input([athome, nifty], { duplicateDecisions: { d: same } }));
    expect(shown.available).toHaveLength(1);
    const hidden = recommend(input([athome, nifty], {
      duplicateDecisions: { d: same },
      marks,
      filters: { ...EMPTY_FILTERS, markFilter: "hideRuledOut" },
    }));
    expect(hidden.ranked).toEqual([]);
  });

  it("drops a home whose every ad was marked gone when rented-out homes are hidden", () => {
    const listing = make();
    const [key] = listingAdKeys(listing);
    const gone: AvailabilityMap = {
      [key]: { state: "gone", checkedAt: "2026-10-12T00:00:00.000Z", evidence: "marked by hand", method: "manual", source: "athome", url: listing.url! },
    };
    expect(recommend(input([listing])).ranked).toHaveLength(1);
    expect(recommend(input([listing], { availabilityMarks: gone })).ranked).toEqual([]);
  });
});

/**
 * The dashboard's pipeline as it was written inline in App.tsx before the
 * stages moved here. `recommend` must give exactly what it gave.
 */
function inlinePipeline(
  listings: readonly EnrichedListing[],
  catalog: PlaceCatalog,
  config: ScoringConfig,
  filters: ListingFilters,
  selection: PlaceSelection,
  savedMarks: MarkMap,
  availabilityMarks: AvailabilityMap,
  decisions: Record<string, DuplicateDecision>,
) {
  const { leadOf } = resolveDecisions(listings, decisions);
  const marks = carryToLeads(savedMarks, leadOf);
  const index = new ProximityIndex(listings, catalog, SCORED_CATEGORIES);
  const allowedSets = selectionAllowedSets(selection);
  const resolved = listings.map((listing, i) => applySelection(listing, i, index, selection, allowedSets));
  const withMarks = Object.keys(availabilityMarks).length
    ? resolved.map((listing) => withAvailability(listing, availabilityMarks))
    : resolved;
  const available = applySameDecisions(withMarks, { leadOf });
  const candidates = available.filter((listing) =>
    matchesListing(listing, filters) && matchesMarkFilter(marks[listingKey(listing)], filters.markFilter));
  const scored = candidates.map((listing) => ({ listing, score: scoreListing(listing, config) }));
  const filtered = filters.minScore > 0
    ? scored.filter(({ score }) => (score.total ?? -1) >= filters.minScore)
    : scored;
  let hints: ReturnType<typeof relaxationHints> = [];
  if (filtered.length === 0 && available.length > 0) {
    const totalOf = (listing: EnrichedListing) => scoreListing(listing, config).total ?? -1;
    hints = relaxationHints(filters, (relaxed) => available.filter((listing) =>
      matchesListing(listing, relaxed)
      && matchesMarkFilter(marks[listingKey(listing)], relaxed.markFilter)
      && (relaxed.minScore <= 0 || totalOf(listing) >= relaxed.minScore)).length);
  }
  const ranked = [...filtered].sort((a, b) => (b.score.total ?? -1) - (a.score.total ?? -1));
  return { ranked, hints };
}

describe("recommend on the published listings", () => {
  let listings: EnrichedListing[];
  let index: ProximityIndex;
  beforeAll(async () => {
    const payload = JSON.parse(await readFile(join(process.cwd(), "public/data/listings.json"), "utf-8")) as WebPayload;
    listings = unpackListings(payload);
    index = buildProximityIndex(listings, CATALOG);
  });

  const commuter = applyPreset(DEFAULT_CONFIG, BUILT_IN_PRESETS.find((preset) => preset.id === "commuter")!);
  const scenarios: {
    name: string;
    config: ScoringConfig;
    filters: ListingFilters;
    station?: boolean;
    marks?: boolean;
    /** Join the first two listings as one home, mark the third's ads gone, and rule out the second. */
    userState?: boolean;
  }[] = [
    { name: "defaults", config: DEFAULT_CONFIG, filters: EMPTY_FILTERS },
    {
      name: "a preset with tight filters",
      config: commuter,
      filters: { ...EMPTY_FILTERS, rentMax: 130_000, layouts: ["3"], parking: "required", minScore: 50, status: "active" },
    },
    {
      name: "bicycle, parking in rent, one station, marks hidden",
      config: { ...DEFAULT_CONFIG, travelMode: "bicycle", includeParking: true, includeHoikuen: true },
      filters: { ...EMPTY_FILTERS, markFilter: "hideRuledOut" },
      station: true,
      marks: true,
    },
    { name: "nothing matches", config: DEFAULT_CONFIG, filters: { ...EMPTY_FILTERS, rentMax: 1, layouts: ["3"] } },
    {
      name: "duplicate answers, availability marks, and a hint only the minimum score can fix",
      config: DEFAULT_CONFIG,
      filters: { ...EMPTY_FILTERS, minScore: 99.9, markFilter: "hideRuledOut" },
      userState: true,
    },
  ];

  it.each(scenarios)("gives the dashboard's ranking: $name", ({ config, filters, station, marks: withMarks, userState }) => {
    const selection = defaultSelection();
    if (station) selection.byParameter.station = [CATALOG.inCategory("station")[0].id];
    let marks: MarkMap = withMarks
      ? Object.fromEntries(listings.slice(0, 50).map((listing) => [listingKey(listing), "not-interested" as const]))
      : {};
    let duplicateDecisions: Record<string, DuplicateDecision> = {};
    let availabilityMarks: AvailabilityMap = {};
    if (userState) {
      const [lead, member, gone] = listings;
      duplicateDecisions = {
        d: { verdict: "same", a: listingAdKeys(lead), b: listingAdKeys(member), decidedAt: "2026-10-11T05:00:00.000Z" },
      };
      availabilityMarks = Object.fromEntries(listingAdKeys(gone).map((key) => [key, {
        state: "gone" as const, checkedAt: "2026-10-12T00:00:00.000Z", evidence: "marked by hand", method: "manual" as const,
        source: gone.source, url: gone.url ?? "",
      }]));
      marks = { [listingKey(member)]: "not-interested" };
    }

    const expected = inlinePipeline(listings, CATALOG, config, filters, selection, marks, availabilityMarks, duplicateDecisions);
    const actual = recommend({ listings, index, config, filters, selection, marks, duplicateDecisions, availabilityMarks });
    if (userState) {
      expect(expected.hints.map((hint) => hint.id)).toContain("minScore");
      expect(actual.available).toHaveLength(listings.length - 1);
    }

    // Every scenario must rank something or explain why not; empty against empty proves nothing.
    expect(expected.ranked.length + expected.hints.length).toBeGreaterThan(0);
    const summary = (rows: ScoredRow[]) => rows.map(({ listing, score }) => [listingKey(listing), score.total]);
    expect(summary(actual.ranked)).toEqual(summary(expected.ranked));
    expect(actual.relaxationHints).toEqual(expected.hints);
  });
});
