import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS } from "../../domain/filters";
import { DEFAULT_CONFIG, DEFAULT_FEATURE_PREFERENCES, DEFAULT_FEATURE_WEIGHTS } from "../../domain/scoringConfig";
import type { PlaceSelection } from "../../domain/placeSelection";
import {
  decodeCustomListings,
  decodeFilters,
  decodeHiddenColumns,
  decodeMarks,
  decodePlaceSelection,
  decodeScoringConfig,
} from "./decoders";

const DEFAULT_SELECTION: PlaceSelection = {
  byParameter: { poi1: ["poi:Al Sanad School Japan"], poi2: null, station: null, busStop: null, kindergarten: null, school: null },
};

/** Values the app itself could have saved before M6. */
const savedConfig = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights, rent: 3 }, travelMode: "bicycle" };
const savedFilters = { ...EMPTY_FILTERS, cities: ["Soka"], rentMax: 120_000, markFilter: "hide-ruled-out" };

/** Garbage a hand-edited or foreign value could contain. */
const CORRUPT: unknown[] = [undefined, null, 0, 42, "text", true, [], [1, 2], { unrelated: 1 }];

describe("user-state decoders", () => {
  it("decode app-saved values exactly as the pre-M6 loaders did", () => {
    // Pre-M6 loaders: spread saved JSON over the defaults.
    expect(decodeScoringConfig(savedConfig)).toEqual({
      ...DEFAULT_CONFIG, ...savedConfig,
      weights: { ...DEFAULT_CONFIG.weights, ...savedConfig.weights },
      featureWeights: { ...DEFAULT_FEATURE_WEIGHTS, ...savedConfig.featureWeights },
      featurePreferences: { ...DEFAULT_FEATURE_PREFERENCES, ...savedConfig.featurePreferences },
      walkZeroMinutes: { ...DEFAULT_CONFIG.walkZeroMinutes, ...savedConfig.walkZeroMinutes },
      moveIn: { ...DEFAULT_CONFIG.moveIn, ...savedConfig.moveIn },
    });
    expect(decodeFilters(savedFilters)).toEqual({ ...EMPTY_FILTERS, ...savedFilters });
    expect(decodeMarks({ a: "shortlisted", b: "no-foreigners" })).toEqual({ a: "shortlisted", b: "no-foreigners" });
    const custom = [{ name: "Manual", rent: 80_000, address: "埼玉県草加市", lat: 35.8, lon: 139.8, geocoded: true }];
    expect(decodeCustomListings(custom)).toEqual(custom);
    const curated = { byParameter: { station: ["station:草加", "station:谷塚"], poi2: ["mosque:A", "mosque:B"] } };
    expect(decodePlaceSelection(curated, DEFAULT_SELECTION)).toEqual({
      byParameter: { ...DEFAULT_SELECTION.byParameter, ...curated.byParameter },
    });
    expect(decodeHiddenColumns(["rent", "size"], new Set(["rent", "size", "city"]))).toEqual(new Set(["rent", "size"]));
  });

  it("migrate the v1 single Baitul Aman mosque target to nearest-of-all", () => {
    const legacy = { byParameter: { poi2: ["poi:Baitul Aman Masjid (蒲生モスク)"] } };
    expect(decodePlaceSelection(legacy, DEFAULT_SELECTION).byParameter.poi2).toBeNull();
    const oneOtherMosque = { byParameter: { poi2: ["mosque:Yashio Masjid"] } };
    expect(decodePlaceSelection(oneOtherMosque, DEFAULT_SELECTION).byParameter.poi2).toEqual(["mosque:Yashio Masjid"]);
  });

  it("fall back to defaults for missing or corrupt values", () => {
    for (const raw of CORRUPT) {
      // Config and filters keep unknown extra keys, as the pre-M6 spread did; only the shape is checked.
      if (!(typeof raw === "object" && raw !== null && !Array.isArray(raw))) {
        expect(decodeScoringConfig(raw)).toEqual(DEFAULT_CONFIG);
        expect(decodeFilters(raw)).toEqual(EMPTY_FILTERS);
      }
      expect(decodeMarks(raw)).toEqual({});
      expect(decodePlaceSelection(raw, DEFAULT_SELECTION)).toEqual(DEFAULT_SELECTION);
      expect(decodeHiddenColumns(raw, new Set(["rent"]))).toEqual(new Set());
    }
    expect(decodeCustomListings("text")).toEqual([]);
  });

  it("drop only the malformed parts of a partly corrupt value", () => {
    const config = decodeScoringConfig({ weights: "heavy", moveIn: [1], travelMode: "bicycle" });
    expect(config.weights).toEqual(DEFAULT_CONFIG.weights);
    expect(config.moveIn).toEqual(DEFAULT_CONFIG.moveIn);
    expect(config.travelMode).toBe("bicycle");
    expect(decodeMarks({ a: "shortlisted", b: "maybe", c: 3 })).toEqual({ a: "shortlisted" });
    expect(decodeCustomListings([{ name: "ok", rent: 1 }, { name: "no rent" }, null, "x"])).toEqual([{ name: "ok", rent: 1 }]);
    expect(decodePlaceSelection({ byParameter: { station: "草加", school: [1], busStop: null } }, DEFAULT_SELECTION))
      .toEqual({ byParameter: { ...DEFAULT_SELECTION.byParameter, busStop: null } });
    expect(decodeHiddenColumns(["rent", "gone", 7], new Set(["rent"]))).toEqual(new Set(["rent"]));
  });
});
