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

  it("shows lease terms stated as no charge, without making them scored features", () => {
    const ur = { ...listing([]), keyMoneyYen: 0, costs: { agencyFeeYen: 0, renewalFeeYen: 0, guarantorRequired: false } };
    expect(normalizeListingAttributes(ur)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "noKeyMoney", category: "tenancy", labelJa: "礼金なし", state: true }),
      expect.objectContaining({ key: "noAgencyFee", labelJa: "仲介手数料なし", state: true }),
      expect.objectContaining({ key: "noRenewalFee", labelJa: "更新料なし", state: true }),
      expect.objectContaining({ key: "guarantorNotRequired", state: true }),
    ]));
    // Unstated or charged terms add nothing.
    const charged = { ...listing([]), keyMoneyYen: 80_000, costs: { renewalFeeYen: null } };
    expect(normalizeListingAttributes(charged)).toEqual([]);
  });
});

describe("1st floor or house", () => {
  const unit = (overrides: Partial<EnrichedListing>, floor?: string | null): EnrichedListing => {
    const base = { ...listing([]), ...overrides };
    base.building = { ...base.building, floor };
    base.attributes = normalizeListingAttributes(base);
    return base;
  };
  const state = (overrides: Partial<EnrichedListing>, floor?: string | null) =>
    featureState(unit(overrides, floor), "groundFloorOrHouse");

  it("is true for a unit whose lowest floor is the ground floor", () => {
    expect(state({}, "1階")).toBe(true);
    expect(state({}, "1-2階")).toBe(true);
    expect(state({}, "１階")).toBe(true);
    expect(state({}, "B1階")).toBe(true);
  });

  it("is false for an apartment on an upper floor, including a maisonette", () => {
    expect(state({}, "2階")).toBe(false);
    expect(state({}, "12階")).toBe(false);
    expect(state({}, "2-3階")).toBe(false);
  });

  it("is true for a house whatever floor the portal prints", () => {
    expect(state({ notes: "賃貸一戸建て 2階建1988年3月(築38年7ヶ月)・管理費0円" }, "2階")).toBe(true);
    expect(state({ notes: "賃貸テラスハウス 2階建2001年7月(築25年4ヶ月)" }, "-")).toBe(true);
    expect(state({ name: "八幡町戸建て" }, "2階")).toBe(true);
    expect(state({ name: "坂下町2丁目　貸家" }, null)).toBe(true);
  });

  it("trusts the portal's building type over a house-like name", () => {
    expect(state({ name: "ＪＴテラスハウス見沼代", notes: "賃貸アパート 2階建 2016年2月" }, "2階")).toBe(false);
  });

  it("stays unknown when neither the type nor the floor is known", () => {
    expect(state({}, "-")).toBeNull();
    expect(state({}, null)).toBeNull();
    expect(state({ notes: "賃貸マンション 10階建" }, undefined)).toBeNull();
  });
});
