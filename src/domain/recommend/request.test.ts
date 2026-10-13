import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../scoringConfig";
import { BUILT_IN_PRESETS } from "../weightPresets";
import { closest, decodeQuery, decodeRequest, type DecodeContext, type DecodeResult, type FieldError } from "./request";

const CONTEXT: DecodeContext = {
  values: { cities: ["Soka", "Koshigaya"], layouts: ["1", "2", "3", "4"], areas: ["金明町", "谷塚"], agencies: ["agency:ベストハウジング"] },
  placeIds: (category) => new Set(category === "station" ? ["station:草加", "station:谷塚"] : []),
};

const ok = (result: DecodeResult) => {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};
const errors = (result: DecodeResult): FieldError[] => {
  if (result.ok) throw new Error("expected errors");
  return result.errors;
};

describe("decodeRequest", () => {
  it("resolves an empty request to the defaults, all from the default layer", () => {
    const { criteria, sources, warnings } = ok(decodeRequest(undefined, CONTEXT));
    expect(criteria.config).toEqual(DEFAULT_CONFIG);
    expect(criteria.page).toEqual({ limit: 10, offset: 0 });
    expect(new Set(Object.values(sources))).toEqual(new Set(["default"]));
    expect(warnings).toEqual([]);
  });

  it("applies a preset, then the fields the request sets, and says where each came from", () => {
    const commuter = BUILT_IN_PRESETS.find((preset) => preset.id === "commuter")!;
    const { criteria, sources } = ok(decodeRequest({ preset: "commuter", weights: { station: 20 } }, CONTEXT));
    expect(criteria.presetId).toBe("commuter");
    expect(criteria.config.weights).toEqual({ ...commuter.weights, station: 20 });
    expect(sources["weights.station"]).toBe("request");
    expect(sources["weights.rent"]).toBe("preset:commuter");
    expect(sources["features.cityGas.weight"]).toBe("default");
  });

  it("sets nested fields: features, anchors, travel, places, ranking and state", () => {
    const { criteria } = ok(decodeRequest({
      features: { cityGas: { weight: 3 }, fixedTermLease: { prefer: "prefer" } },
      anchors: { rentZeroScoreAbove: 150_000, walkZeroMinutes: { station: 15 } },
      travel: { mode: "bicycle", includeParking: true },
      places: { station: ["station:草加"], poi2: null },
      filters: { cities: ["Soka"], layouts: ["3"], rentMax: 130_000, areas: ["谷塚"], agencies: ["agency:unknown"] },
      ranking: { sortBy: "station", order: "asc", minScore: 40, minPartScores: { station: 50 } },
      page: { limit: 25, offset: 50 },
      view: "full",
      state: { excludeKeys: ["a"], marks: { b: "shortlisted" } },
    }, CONTEXT));
    expect(criteria.config.featureWeights.cityGas).toBe(3);
    expect(criteria.config.featurePreferences.fixedTermLease).toBe("prefer");
    expect(criteria.config.rentZeroScoreAbove).toBe(150_000);
    expect(criteria.config.walkZeroMinutes.station).toBe(15);
    expect(criteria.config.travelMode).toBe("bicycle");
    expect(criteria.selection.byParameter.station).toEqual(["station:草加"]);
    expect(criteria.filters).toMatchObject({ cities: ["Soka"], rentMax: 130_000, minScore: 40, agencies: ["agency:unknown"] });
    expect(criteria.ranking).toEqual({ sortBy: "station", order: "asc", minPartScores: { station: 50 } });
    expect(criteria.page).toEqual({ limit: 25, offset: 50 });
    expect(criteria.state.marks).toEqual({ b: "shortlisted" });
  });

  it("names unknown fields and suggests the closest one", () => {
    expect(errors(decodeRequest({ weights: { staton: 5 } }, CONTEXT))).toEqual([
      expect.objectContaining({ path: "weights.staton", message: "is not a known field", didYouMean: "station" }),
    ]);
    expect(errors(decodeRequest({ filter: {} }, CONTEXT))[0]).toMatchObject({ path: "filter", didYouMean: "filters" });
    expect(errors(decodeRequest({ weights: 5 }, CONTEXT))[0]).toMatchObject({ path: "weights", message: "must be an object" });
  });

  it("reports every bad value at once, with its path", () => {
    const found = errors(decodeRequest({
      weights: { station: 21, rent: "7" },
      page: { limit: 2.5 },
      travel: { mode: "car", includeParking: "yes" },
      filters: { cities: ["Sokaa"], layouts: "3" },
      places: { station: ["station:nowhere"] },
    }, CONTEXT));
    expect(found.map((error) => error.path).sort()).toEqual([
      "filters.cities[0]", "filters.layouts", "page.limit", "places.station[0]",
      "travel.includeParking", "travel.mode", "weights.rent", "weights.station",
    ]);
    expect(found.find((error) => error.path === "filters.cities[0]")).toMatchObject({ didYouMean: "Soka", allowed: ["Soka", "Koshigaya"] });
    expect(found.find((error) => error.path === "travel.mode")).toMatchObject({ allowed: ["walk", "bicycle"] });
    expect(found.find((error) => error.path === "weights.station")?.message).toBe("must be between 0 and 20");
  });

  it("checks criterion keys and scores in ranking.minPartScores", () => {
    expect(errors(decodeRequest({ ranking: { minPartScores: { staton: 50, rent: 120 } } }, CONTEXT))).toEqual([
      expect.objectContaining({ path: "ranking.minPartScores.staton", didYouMean: "station" }),
      expect.objectContaining({ path: "ranking.minPartScores.rent", message: "must be between 0 and 100" }),
    ]);
  });

  it("checks the caller's state maps", () => {
    const found = errors(decodeRequest({
      state: { marks: { a: "maybe" }, duplicateDecisions: { d: { verdict: "same", a: [], b: ["x"] } }, availabilityMarks: { k: { state: "gone" } } },
    }, CONTEXT));
    expect(found.map((error) => error.path)).toEqual(["state.marks.a", "state.duplicateDecisions.d", "state.availabilityMarks.k"]);
  });

  it("rejects anchors whose 100 and 0 ends are the wrong way round, and inverted ranges", () => {
    expect(errors(decodeRequest({ anchors: { rentFullScoreBelow: 300_000 } }, CONTEXT))[0]).toMatchObject({
      path: "anchors.rentFullScoreBelow",
      message: expect.stringContaining("must be below the value scoring 0"),
    });
    expect(errors(decodeRequest({ anchors: { sizeZeroScoreBelow: 80 } }, CONTEXT))[0].path).toBe("anchors.sizeFullScoreAbove");
    expect(errors(decodeRequest({ filters: { rentMin: 90_000, rentMax: 80_000 } }, CONTEXT))[0].path).toBe("filters.rentMin");
  });

  it("warns about requests that are valid but probably not meant", () => {
    const zero = Object.fromEntries(Object.keys(DEFAULT_CONFIG.weights).map((key) => [key, 0]));
    expect(ok(decodeRequest({ weights: zero }, CONTEXT)).warnings[0]).toContain("Every weight is 0");
    expect(ok(decodeRequest({ filters: { markFilter: "shortlist" } }, CONTEXT)).warnings[0]).toContain("state.marks is empty");
    expect(ok(decodeRequest({ ranking: { sortBy: "cityGas" } }, CONTEXT)).warnings[0]).toContain("weight 0");
  });

  it("rejects a body that is not an object", () => {
    expect(errors(decodeRequest([1], CONTEXT))).toEqual([{ path: "", message: "the request must be a JSON object" }]);
  });
});

describe("decodeQuery", () => {
  it("reads dotted keys with typed values", () => {
    const { criteria } = ok(decodeQuery([
      ["preset", "commuter"],
      ["weights.station", "14"],
      ["travel.includeParking", "true"],
      ["filters.layouts", "3,4"],
      ["filters.cities", "Soka"],
      ["filters.cities", "Koshigaya"],
      ["filters.rentMax", "null"],
      ["places.station", "station:草加"],
      ["places.poi1", "null"],
      ["ranking.minPartScores.station", "50"],
      ["state.marks", '{"a":"shortlisted"}'],
    ], CONTEXT));
    expect(criteria.presetId).toBe("commuter");
    expect(criteria.config.weights.station).toBe(14);
    expect(criteria.config.includeParking).toBe(true);
    expect(criteria.filters.layouts).toEqual(["3", "4"]);
    expect(criteria.filters.cities).toEqual(["Soka", "Koshigaya"]);
    expect(criteria.filters.rentMax).toBeNull();
    expect(criteria.selection.byParameter).toMatchObject({ station: ["station:草加"], poi1: null });
    expect(criteria.ranking.minPartScores).toEqual({ station: 50 });
    expect(criteria.state.marks).toEqual({ a: "shortlisted" });
  });

  it("never writes outside the request: prototype keys are unknown fields", () => {
    for (const key of ["__proto__.polluted", "constructor.prototype.polluted", "weights.__proto__.polluted"]) {
      expect(errors(decodeQuery([[key, "yes"]], CONTEXT))[0]).toMatchObject({ path: key, message: "is not a known field" });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reports a reserved or unknown criterion name under minPartScores instead of throwing", () => {
    for (const name of ["__proto__", "constructor", "staton"]) {
      const key = `ranking.minPartScores.${name}`;
      expect(errors(decodeQuery([[key, "5"]], CONTEXT))[0]).toMatchObject({ path: key, message: "is not a criterion key" });
    }
    expect(errors(decodeQuery([["ranking.minPartScores.staton", "5"]], CONTEXT))[0].didYouMean).toBe("station");
  });

  it("reports values that conflict for one field instead of dropping one", () => {
    expect(errors(decodeQuery([["ranking.minPartScores", "5"], ["ranking.minPartScores.school", "30"]], CONTEXT))[0].path)
      .toBe("ranking.minPartScores.school");
    const merged = ok(decodeQuery([["ranking.minPartScores", '{"station":50}'], ["ranking.minPartScores.school", "30"]], CONTEXT));
    expect(merged.criteria.ranking.minPartScores).toEqual({ station: 50, school: 30 });
    expect(errors(decodeQuery([["weights.station", "1"], ["weights.station", "2"]], CONTEXT))[0].path).toBe("weights.station");
  });

  it("reports an unknown key under a list field instead of dropping it", () => {
    expect(errors(decodeQuery([["filters.cities.bogus", "x"], ["filters.cities", "Soka"]], CONTEXT))[0].path).toBe("filters.cities.bogus");
  });

  it("takes per-criterion minimums one key at a time or as JSON, and rejects an empty one", () => {
    const one = ok(decodeQuery([["ranking.minPartScores.station", "50"]], CONTEXT));
    const json = ok(decodeQuery([["ranking.minPartScores", '{"station":50}']], CONTEXT));
    expect(json.criteria.ranking.minPartScores).toEqual(one.criteria.ranking.minPartScores);
    expect(errors(decodeQuery([["ranking.minPartScores.station", ""]], CONTEXT))[0].path).toBe("ranking.minPartScores.station");
  });

  it("gives the same errors as the body form", () => {
    expect(errors(decodeQuery([["weights.station", "lots"]], CONTEXT))).toEqual([{ path: "weights.station", message: '"lots" is not a number' }]);
    expect(errors(decodeQuery([["weights.staton", "5"]], CONTEXT))[0]).toMatchObject({ path: "weights.staton", didYouMean: "station" });
    expect(errors(decodeQuery([["weights.station", "99"]], CONTEXT))[0].message).toBe("must be between 0 and 20");
  });
});

describe("closest", () => {
  it("suggests only near misses", () => {
    expect(closest("staton", ["station", "school"])).toBe("station");
    expect(closest("STATION", ["station"])).toBe("station");
    expect(closest("xyz", ["station", "school"])).toBeUndefined();
  });
});
