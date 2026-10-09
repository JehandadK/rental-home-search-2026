import { describe, expect, it } from "vitest";
import type { EnrichedListing } from "./types";
import { featureState, normalizeListingAttributes } from "./listingAttributes";

const listing = (features: string[], conditions: string[] = []): EnrichedListing => ({
  name: "Test", address: "埼玉県草加市", rent: 80_000, layout: "2LDK", sizeM2: 50,
  builtYear: 2020, stationWalkMin: 10, url: null, source: "test", geocoded: false,
  building: { features, conditions },
});

describe("normalizeListingAttributes", () => {
  it("translates known Japanese features into stable bilingual attributes", () => {
    const attributes = normalizeListingAttributes(listing([
      "バス・トイレ別", "インターネット使用料無料", "都市ガス", "ペット不可",
    ]));
    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "bathToiletSeparate", labelEn: "Separate bath and toilet", state: true }),
      expect.objectContaining({ key: "internetFree", labelJa: "インターネット無料", state: true }),
      expect.objectContaining({ key: "cityGas", state: true }),
      expect.objectContaining({ key: "petAllowed", state: false }),
    ]));
  });

  it("preserves unmapped source properties instead of discarding them", () => {
    const attributes = normalizeListingAttributes(listing(["太陽光発電システム"]));
    expect(attributes[0]).toMatchObject({ category: "other", raw: "太陽光発電システム", state: null });
  });

  it("keeps unknown distinct from false for scoring", () => {
    const unknown = listing([]);
    const explicitNo = listing(["ペット不可"]);
    unknown.attributes = normalizeListingAttributes(unknown);
    explicitNo.attributes = normalizeListingAttributes(explicitNo);
    expect(featureState(unknown, "petAllowed")).toBeNull();
    expect(featureState(explicitNo, "petAllowed")).toBe(false);
  });
});
