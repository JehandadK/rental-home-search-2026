import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FILTERS } from "../filters";
import { listingKey } from "../listingKey";
import type { PlaceCatalog } from "../places";
import { defaultSelection } from "../placeSelection";
import { listingAdKeys } from "../possibleDuplicates";
import { scoreListing } from "../scoring";
import { DEFAULT_CONFIG, FEATURE_PARAMETERS } from "../scoringConfig";
import type { EnrichedListing } from "../types";
import { unpackListings, type WebPayload } from "../webPayload";
import { loadCurrentReferenceModel } from "../../storage/json/currentReference.contract";
import { FIELD_SPECS } from "./criteriaSchema";
import { describeCriteria, findPlaces } from "./describe";
import { describe as describeItem, explainScore } from "./explain";
import { recommend } from "./pipeline";
import {
  compareHomes,
  createRecommendationContext,
  explainHome,
  rankHomes,
  type RecommendationContext,
} from "./rankHomes";
import { decodeRequest } from "./request";

let CATALOG: PlaceCatalog;
beforeAll(async () => {
  CATALOG = (await loadCurrentReferenceModel()).catalog;
});

const NOW = new Date("2026-10-12T00:00:00.000Z");

const make = (id: string, over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  id,
  name: `Home ${id}`,
  address: "埼玉県草加市金明町１",
  city: "Soka",
  rent: 100_000,
  layout: "3LDK",
  sizeM2: 60,
  builtYear: 2015,
  stationWalkMin: 8,
  url: `https://www.athome.co.jp/chintai/${id.replace(/\D/g, "")}/`,
  source: "athome",
  geocoded: true,
  lat: 35.8282,
  lon: 139.8033,
  ...over,
});

/** Cheap, mid and dear homes, one with no size, one 1K. */
const HOMES = [
  make("athome-1", { rent: 150_000, stationWalkMin: 2 }),
  make("athome-2", { rent: 70_000, stationWalkMin: 15 }),
  make("athome-3", { rent: 110_000, stationWalkMin: 5 }),
  make("athome-4", { rent: 90_000, sizeM2: null, stationWalkMin: 9 }),
  make("athome-5", { rent: 60_000, layout: "1K", sizeM2: 20, stationWalkMin: 4 }),
];

let context: RecommendationContext;
beforeAll(() => {
  context = createRecommendationContext(HOMES, CATALOG);
});

const decode = (body: unknown) => {
  const result = decodeRequest(body, context.decode);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};
const rank = (body: unknown = {}) => rankHomes(context, decode(body), { now: NOW });
const keys = (result: ReturnType<typeof rank>) => result.results.map((home) => home.key);

describe("rankHomes", () => {
  it("ranks every home by total score, best first, as the pipeline does", () => {
    const result = rank({ page: { limit: 100 } });
    const pipeline = recommend({
      listings: HOMES, index: context.index, config: DEFAULT_CONFIG, filters: EMPTY_FILTERS, selection: defaultSelection(),
    });
    expect(keys(result)).toEqual(pipeline.ranked.map((row) => listingKey(row.listing)));
    expect(result.results.map((home) => home.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.counts).toEqual({ listings: 5, available: 5, afterFilters: 5, ranked: 5, returned: 5 });
  });

  it("pages through the ranking with offset and nextOffset", () => {
    const all = keys(rank({ page: { limit: 100 } }));
    const first = rank({ page: { limit: 2 } });
    const second = rank({ page: { limit: 2, offset: first.nextOffset } });
    const last = rank({ page: { limit: 2, offset: second.nextOffset } });
    expect([...keys(first), ...keys(second), ...keys(last)]).toEqual(all);
    expect(second.results[0].rank).toBe(3);
    expect(last.nextOffset).toBeNull();
  });

  it("sorts by one criterion's score, either way, with unknown values last", () => {
    const bySize = rank({ ranking: { sortBy: "size" }, page: { limit: 100 } });
    expect(bySize.results.at(-1)!.key).toBe("athome-4");
    expect(bySize.results[0].sortScore).toBeGreaterThanOrEqual(bySize.results[1].sortScore!);
    const ascending = rank({ ranking: { sortBy: "size", order: "asc" }, page: { limit: 100 } });
    expect(ascending.results[0].key).toBe("athome-5");
    expect(ascending.results.at(-1)!.key).toBe("athome-4");
    // Equal criterion scores keep the best total first, whichever way the criterion sorts.
    for (const order of ["asc", "desc"]) {
      const tied = rank({ ranking: { sortBy: "parkingAvailable", order }, page: { limit: 100 } }).results.map((home) => home.score!);
      expect(tied).toEqual([...tied].sort((a, b) => b - a));
    }
    const lowest = rank({ ranking: { order: "asc" }, page: { limit: 100 } });
    expect(keys(lowest)).toEqual(keys(rank({ page: { limit: 100 } })).reverse());
  });

  it("cuts on one criterion's score, dropping homes with no data for it", () => {
    const result = rank({ ranking: { minPartScores: { size: 50 } }, page: { limit: 100 } });
    expect(keys(result)).not.toContain("athome-4");
    expect(keys(result)).not.toContain("athome-5");
    for (const home of result.results) expect(home.breakdown.find((item) => item.key === "size")!.score).toBeGreaterThanOrEqual(50);
  });

  it("leaves out excluded homes", () => {
    expect(keys(rank({ state: { excludeKeys: ["athome-2"] } }))).not.toContain("athome-2");
  });

  it("applies filters before ranking", () => {
    const result = rank({ filters: { layouts: ["3"], rentMax: 120_000 } });
    expect(keys(result).sort()).toEqual(["athome-2", "athome-3", "athome-4"]);
    expect(result.counts.afterFilters).toBe(3);
  });

  it("says which single change brings homes back, as request paths", () => {
    const tooTight = rank({ filters: { rentMax: 50_000 } });
    expect(tooTight.results).toEqual([]);
    expect(tooTight.relaxationHints).toEqual([
      { id: "rent", label: "rent range", set: { "filters.rentMin": null, "filters.rentMax": null }, count: 5 },
    ]);
    const cut = rank({ ranking: { minPartScores: { size: 100, station: 0 } } });
    expect(cut.relaxationHints).toEqual([
      expect.objectContaining({ id: "minPartScores.size", set: { "ranking.minPartScores": { station: 0 } } }),
    ]);
    const excluded = rank({ state: { excludeKeys: HOMES.map(listingKey) } });
    expect(excluded.relaxationHints).toEqual([expect.objectContaining({ set: { "state.excludeKeys": [] }, count: 5 })]);
  });

  it("counts a filter hint through the later cuts, so applying it ranks that many homes", () => {
    const result = rank({ filters: { rentMax: 50_000 }, ranking: { minPartScores: { size: 90 } } });
    for (const hint of result.relaxationHints) {
      const applied = structuredClone(result.request) as Record<string, Record<string, unknown>>;
      for (const [path, value] of Object.entries(hint.set)) {
        const [group, field] = path.split(".");
        applied[group][field] = value;
      }
      expect(rank(applied).counts.ranked, hint.id).toBe(hint.count);
    }
    // Clearing the rent range alone still leaves the size cut, which every home fails.
    expect(rank({ filters: { rentMax: 50_000 }, ranking: { minPartScores: { size: 100 } } }).relaxationHints).toEqual([]);
  });

  it("returns hint values the caller may change freely", () => {
    const [hint] = rank({ filters: { cities: ["Soka"], rentMax: 1 } }).relaxationHints;
    (hint.set["filters.rentMin"] as unknown) = 5;
    expect(EMPTY_FILTERS.rentMin).toBeNull();
    const layouts = rank({ filters: { layouts: ["1"], rentMin: 100_000 } }).relaxationHints.find((h) => h.id === "layouts")!;
    expect(layouts.set["filters.layouts"]).toEqual([]);
    expect(layouts.set["filters.layouts"]).not.toBe(EMPTY_FILTERS.layouts);
  });

  it("returns the scoring it used, with where each value came from and how to change it", () => {
    const { scoring } = rank({ preset: "commuter", weights: { station: 18 }, places: { station: null } });
    const station = scoring.parameters.find((parameter) => parameter.key === "station")!;
    expect(station).toMatchObject({
      weight: 18, source: "request", set: "weights.station", direction: "lower-is-better",
      anchors: { fullScoreAt: 0, zeroScoreAt: 20, set: { zeroScoreAt: "anchors.walkZeroMinutes.station" } },
      places: { selection: "nearest of all", set: "places.station", source: "request" },
    });
    expect(scoring.parameters.find((parameter) => parameter.key === "rent")!.source).toBe("preset:commuter");
    expect(scoring.parameters).toHaveLength(12);
    // The summary details only weighted features and names the rest; the full view details every one.
    const weightedByDefault = FEATURE_PARAMETERS.filter((meta) => DEFAULT_CONFIG.featureWeights[meta.key] > 0).map((meta) => meta.key);
    expect(scoring.features.map((feature) => feature.key)).toEqual(weightedByDefault);
    expect(scoring.unweightedFeatures).toMatchObject({ set: "features.<key>.weight" });
    expect(scoring.unweightedFeatures.keys).toHaveLength(FEATURE_PARAMETERS.length - weightedByDefault.length);
    const withGas = rank({ features: { cityGas: { weight: 4 } } }).scoring;
    expect(withGas.features.map((feature) => feature.key)).toEqual(expect.arrayContaining(["cityGas", ...weightedByDefault]));
    expect(withGas.features.find((feature) => feature.key === "cityGas")).toMatchObject({ weight: 4, source: "request", set: "features.cityGas.weight" });
    expect(withGas.unweightedFeatures.keys).toHaveLength(FEATURE_PARAMETERS.length - weightedByDefault.length - 1);
    expect(rank({ view: "full" }).scoring.features).toHaveLength(FEATURE_PARAMETERS.length);
    const shares = [...scoring.parameters, ...scoring.features].reduce((sum, item) => sum + item.share, 0);
    expect(shares).toBeCloseTo(1, 2);
    expect(scoring.preset).toBe("commuter");
  });

  it("echoes a request that reproduces the ranking, and tweaks by one path", () => {
    const first = rank({ preset: "space", filters: { layouts: ["3"] }, travel: { mode: "bicycle" }, page: { limit: 3 } });
    const again = rank(first.request);
    expect(keys(again)).toEqual(keys(first));
    expect(again.results.map((home) => home.score)).toEqual(first.results.map((home) => home.score));
    expect(Object.keys(first.request)).not.toContain("state");

    // With caller state, the echo carries it, so resending still reproduces the ranking.
    const withState = rank({ filters: { markFilter: "hideRuledOut" }, state: { marks: { "athome-1": "not-interested" }, excludeKeys: ["athome-2"] } });
    expect(rank(withState.request).results.map((home) => home.key)).toEqual(keys(withState));
    expect((withState.request.state as Record<string, unknown>).marks).toEqual({ "athome-1": "not-interested" });

    const tweaked = structuredClone(first.request) as { weights: { station: number } };
    tweaked.weights.station = 20;
    expect(rank(tweaked).scoring.parameters.find((parameter) => parameter.key === "station")!.weight).toBe(20);
  });

  it("adds details only in the full view", () => {
    expect(rank().results[0].details).toBeUndefined();
    const full = rank({ view: "full" }).results[0];
    expect(full.details).toMatchObject({ moveIn: expect.objectContaining({ totalUpfront: expect.any(Number) }), location: { lat: 35.8282, lon: 139.8033 } });
    expect(full.breakdown.length).toBeGreaterThan(rank().results[0].breakdown.length);
  });

  it("summarises each home", () => {
    const home = rank({ travel: { includeParking: true } }).results.find((result) => result.key === "athome-3")!.home;
    expect(home).toMatchObject({
      name: "Home athome-3", city: "Soka", area: "金明町", layout: "3LDK", rent: 110_000, monthlyTotal: 110_000,
      status: "active", rentedOut: false, ur: false, ads: [{ source: "athome", url: "https://www.athome.co.jp/chintai/3/" }],
    });
    expect(home.station.minutes).toBe(5);
  });
});

describe("explainHome and compareHomes", () => {
  it("explains a home the filters hide, saying it is not ranked", () => {
    const explained = explainHome(context, decode({ filters: { layouts: ["3"] } }), "athome-5", { now: NOW })!;
    expect(explained).toMatchObject({ ranked: false, rankAmongRanked: null });
    expect(explained.home.rank).toBeNull();
    expect(explained.home.details).toBeDefined();
    expect(explainHome(context, decode({}), "nope")).toBeNull();
  });

  it("gives a ranked home its place", () => {
    const top = rank().results[0];
    expect(explainHome(context, decode({}), top.key)).toMatchObject({ ranked: true, rankAmongRanked: 1, home: { rank: 1, key: top.key } });
  });

  it("finds a merged home by a member's key", () => {
    const [lead, member] = HOMES;
    const decisions = { d: { verdict: "same", a: listingAdKeys(lead), b: listingAdKeys(member), decidedAt: "2026-10-11T00:00:00.000Z" } };
    const explained = explainHome(context, decode({ state: { duplicateDecisions: decisions } }), listingKey(member))!;
    expect(explained.home.key).toBe(listingKey(lead));
    expect(explained.home.home.ads).toHaveLength(2);
  });

  it("finds a merged member's lead by ad keys, even when ads have no URL", () => {
    const noUrl = (id: string, name: string) => make(id, { source: "suumo", url: null, name });
    const [other, lead, member] = [noUrl("suumo-o", "Other"), make("athome-7", { name: "Lead" }), noUrl("suumo-m", "Member")];
    const local = createRecommendationContext([other, lead, member], CATALOG);
    const decisions = { d: { verdict: "same", a: listingAdKeys(lead), b: listingAdKeys(member), decidedAt: "2026-10-11T00:00:00.000Z" } };
    const decoded = decodeRequest({ state: { duplicateDecisions: decisions } }, local.decode);
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.errors));
    expect(explainHome(local, decoded.value, listingKey(member))!.home.home.name).toBe("Lead");
  });

  it("compares homes, marking unknown keys and the gaps they share", () => {
    const comparison = compareHomes(context, decode({}), ["athome-4", "missing", "athome-4"]);
    expect(comparison.homes.map((home) => ("missing" in home ? "missing" : home.home.key))).toEqual(["athome-4", "missing", "athome-4"]);
    expect(comparison.sharedGaps).toContain("size");
  });
});

describe("explainScore", () => {
  it("splits the total into contributions that add up to it", () => {
    const score = scoreListing(make("athome-9"), DEFAULT_CONFIG);
    const { breakdown } = explainScore(score, DEFAULT_CONFIG);
    const sum = breakdown.reduce((total, item) => total + (item.contribution ?? 0), 0);
    expect(sum).toBeCloseTo(score.total!, 1);
    expect(breakdown.every((item) => item.weight > 0)).toBe(true);
    for (let i = 1; i < breakdown.length; i++) expect(breakdown[i - 1].contribution ?? -1).toBeGreaterThanOrEqual(breakdown[i].contribution ?? -1);
  });

  it("names strengths, weaknesses and gaps", () => {
    const config = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights, rent: 20 } };
    const cheap = explainScore(scoreListing(make("athome-9", { rent: 50_000, sizeM2: null }), config), config);
    expect(cheap.reasons[0]).toBe("¥50,000/mo (scores 100/100, weight 20)");
    expect(cheap.gaps).toContain("size");
    const dear = explainScore(scoreListing(make("athome-9", { rent: 200_000 }), config), config);
    expect(dear.concerns[0]).toBe("¥200,000/mo (scores 0/100, weight 20)");
  });

  it("describes values in plain words", () => {
    const walk = { ...DEFAULT_CONFIG, travelMode: "walk" as const };
    const cycle = { ...DEFAULT_CONFIG, travelMode: "bicycle" as const };
    expect(describeItem({ key: "station", label: "Station", value: 6.04, detail: "草加" }, walk)).toBe("6 min walk to 草加, the nearest station");
    expect(describeItem({ key: "poi2", label: "Mosque", value: 3, detail: undefined }, cycle)).toBe("3 min by bicycle to the nearest mosque");
    expect(describeItem({ key: "kindergarten", label: "Kindergarten", value: 4 }, { ...walk, includeHoikuen: true }))
      .toBe("4 min walk to the nearest kindergarten or daycare");
    expect(describeItem({ key: "cityGas", label: "City gas", value: 1 }, walk)).toBe("City gas: yes");
    expect(describeItem({ key: "yearBuilt", label: "Age", value: 12 }, walk)).toBe("12 years old");
    expect(describeItem({ key: "size", label: "Size", value: null }, walk)).toBe("Size: not stated");
  });
});

describe("describeCriteria and findPlaces", () => {
  it("lists every field once, with its default and the values the data allows", () => {
    const catalogue = describeCriteria(context);
    const fields = catalogue.groups.flatMap((group) => group.fields);
    expect(fields.map((field) => field.path)).toEqual(FIELD_SPECS.map((spec) => spec.path));
    expect(fields.find((field) => field.path === "filters.cities")).toMatchObject({ type: "string[]", allowed: ["Soka"], default: [] });
    expect(fields.find((field) => field.path === "weights.station")).toMatchObject({ type: "number", min: 0, max: 20, default: 9 });
    expect(fields.find((field) => field.path === "places.poi2")).toMatchObject({ placeCategory: "mosque", default: null });
    expect(catalogue.presets.map((preset) => preset.id)).toContain("commuter");
    expect(catalogue.presets.find((preset) => preset.id === "balanced")!.weights).not.toBe(DEFAULT_CONFIG.weights);
    expect(catalogue.placeCategories.find((category) => category.parameter === "station")!.count).toBeGreaterThan(0);
  });

  it("finds places by name, category and distance", () => {
    const stations = findPlaces(CATALOG, { category: "station", near: { lat: 35.8282, lon: 139.8033 }, limit: 3 });
    expect(stations).toHaveLength(3);
    expect(stations.every((place) => place.category === "station")).toBe(true);
    expect(stations[0].distM!).toBeLessThanOrEqual(stations[1].distM!);
    const named = findPlaces(CATALOG, { q: "ＡＬ ＳＡＮＡＤ" });
    expect(named.map((place) => place.name)).toContain("Al Sanad School Japan");
    const ids = new Set(CATALOG.inCategory("station").map((place) => place.id));
    expect(decodeRequest({ places: { station: [stations[0].id] } }, context.decode).ok).toBe(ids.has(stations[0].id));
  });
});

describe("rankHomes on the published listings", () => {
  let published: RecommendationContext;
  beforeAll(async () => {
    const payload = JSON.parse(await readFile(join(process.cwd(), "public/data/listings.json"), "utf-8")) as WebPayload;
    // A sample keeps the suite fast; the full index takes ~2 s.
    published = createRecommendationContext(unpackListings(payload).slice(0, 2_000), CATALOG);
  });

  it("ranks the real data, explains every result, and reproduces from its own request", () => {
    const decoded = decodeRequest({ preset: "commuter", filters: { layouts: ["3"], rentMax: 130_000 }, page: { limit: 20 } }, published.decode);
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.errors));
    const result = rankHomes(published, decoded.value, { now: NOW });
    expect(result.results).toHaveLength(20);
    expect(result.counts.ranked).toBeGreaterThan(20);
    for (const home of result.results) {
      const sum = home.breakdown.reduce((total, item) => total + (item.contribution ?? 0), 0);
      expect(sum).toBeCloseTo(home.score!, 0);
    }
    const again = decodeRequest(result.request, published.decode);
    if (!again.ok) throw new Error(JSON.stringify(again.errors));
    expect(rankHomes(published, again.value, { now: NOW }).results.map((home) => home.key)).toEqual(result.results.map((home) => home.key));
  });
});
