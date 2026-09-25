import { describe, expect, it } from "vitest";
import {
  areaOptions,
  cityOptions,
  EMPTY_FILTERS,
  layoutFamily,
  layoutOptions,
  listingArea,
  matchesListing,
  matchesScored,
  type ListingFilters,
} from "./filters";
import type { EnrichedListing } from "../types";
import type { ListingScore } from "./scoring";

const make = (over: Partial<EnrichedListing>): EnrichedListing => ({
  name: "L",
  address: "埼玉県草加市金明町１",
  city: "Soka",
  rent: 100_000,
  layout: "3LDK",
  sizeM2: 60,
  builtYear: 2010,
  stationWalkMin: 8,
  url: null,
  source: "test",
  geocoded: true,
  ...over,
});

const score = (total: number | null): ListingScore => ({ total, parts: [] });

describe("listingArea", () => {
  it("strips prefecture, city and block numbers", () => {
    expect(listingArea(make({ address: "埼玉県草加市金明町１" }))).toBe("金明町");
    expect(listingArea(make({ address: "埼玉県越谷市大字袋山" }))).toBe("大字袋山");
    expect(listingArea(make({ address: "埼玉県草加市谷塚町１２３４" }))).toBe("谷塚町");
    expect(listingArea(make({ address: "埼玉県越谷市千間台西一丁目" }))).toBe("千間台西");
  });
});

describe("layoutFamily", () => {
  it("extracts the leading room count", () => {
    expect(layoutFamily("3LDK")).toBe("3");
    expect(layoutFamily("2K")).toBe("2");
    expect(layoutFamily(null)).toBeNull();
    expect(layoutFamily("ワンルーム")).toBeNull();
  });
});

describe("option extractors", () => {
  const listings = [
    make({ address: "埼玉県草加市金明町１", city: "Soka", layout: "3LDK" }),
    make({ address: "埼玉県草加市金明町２", city: "Soka", layout: "2DK" }),
    make({ address: "埼玉県越谷市北越谷４", city: "Koshigaya", layout: "3K" }),
  ];

  it("counts areas by frequency and can scope them to selected cities", () => {
    expect(areaOptions(listings)[0]).toBe("金明町");
    expect(areaOptions(listings)).toContain("北越谷");
    expect(areaOptions(listings, ["Soka"])).toEqual(["金明町"]);
    expect(areaOptions(listings, ["Koshigaya"])).toEqual(["北越谷"]);
  });

  it("lists cities and layout families", () => {
    expect(cityOptions(listings)).toEqual(["Soka", "Koshigaya"]);
    expect(layoutOptions(listings)).toEqual(["2", "3"]);
  });
});

describe("matchesListing", () => {
  const base: ListingFilters = { ...EMPTY_FILTERS };

  it("passes everything with empty filters", () => {
    expect(matchesListing(make({}), base)).toBe(true);
  });

  it("filters by city", () => {
    expect(matchesListing(make({ city: "Soka" }), { ...base, cities: ["Koshigaya"] })).toBe(false);
    expect(matchesListing(make({ city: "Soka" }), { ...base, cities: ["Soka"] })).toBe(true);
  });

  it("includes only the named areas", () => {
    const f = { ...base, areas: ["金明町"], areaMode: "include" as const };
    expect(matchesListing(make({ address: "埼玉県草加市金明町１" }), f)).toBe(true);
    expect(matchesListing(make({ address: "埼玉県草加市青柳１" }), f)).toBe(false);
  });

  it("excludes the named areas (exclusive area filter)", () => {
    const f = { ...base, areas: ["金明町"], areaMode: "exclude" as const };
    expect(matchesListing(make({ address: "埼玉県草加市金明町１" }), f)).toBe(false);
    expect(matchesListing(make({ address: "埼玉県草加市青柳１" }), f)).toBe(true);
  });

  it("applies rent and size bounds", () => {
    expect(matchesListing(make({ rent: 120_000 }), { ...base, rentMax: 100_000 })).toBe(false);
    expect(matchesListing(make({ rent: 90_000 }), { ...base, rentMax: 100_000 })).toBe(true);
    expect(matchesListing(make({ sizeM2: 40 }), { ...base, sizeMin: 50 })).toBe(false);
    expect(matchesListing(make({ sizeM2: null }), { ...base, sizeMin: 50 })).toBe(false);
  });

  it("filters by layout family", () => {
    expect(matchesListing(make({ layout: "2DK" }), { ...base, layouts: ["3"] })).toBe(false);
    expect(matchesListing(make({ layout: "3LDK" }), { ...base, layouts: ["3"] })).toBe(true);
  });
});

describe("lifecycle filters", () => {
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  it("shows everything with the default 'all' status", () => {
    expect(matchesListing(make({ status: "sold" }), EMPTY_FILTERS)).toBe(true);
    expect(matchesListing(make({ status: "active" }), EMPTY_FILTERS)).toBe(true);
  });

  it("'active' hides sold listings, 'sold' shows only them", () => {
    const sold = make({ status: "sold" });
    const active = make({ status: "active" });
    expect(matchesListing(sold, { ...EMPTY_FILTERS, status: "active" })).toBe(false);
    expect(matchesListing(active, { ...EMPTY_FILTERS, status: "active" })).toBe(true);
    expect(matchesListing(sold, { ...EMPTY_FILTERS, status: "sold" })).toBe(true);
    expect(matchesListing(active, { ...EMPTY_FILTERS, status: "sold" })).toBe(false);
  });

  it("'newOnly' keeps only recently discovered listings", () => {
    const fresh = make({ firstSeenAt: recent });
    const old = make({ firstSeenAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() });
    const legacy = make({ firstSeenAt: null });
    const f = { ...EMPTY_FILTERS, newOnly: true };
    expect(matchesListing(fresh, f)).toBe(true);
    expect(matchesListing(old, f)).toBe(false);
    expect(matchesListing(legacy, f)).toBe(false);
  });
});

describe("matchesScored", () => {
  it("applies the minimum-score gate on top of listing filters", () => {
    const l = make({});
    expect(matchesScored(l, score(40), { ...EMPTY_FILTERS, minScore: 50 })).toBe(false);
    expect(matchesScored(l, score(60), { ...EMPTY_FILTERS, minScore: 50 })).toBe(true);
    expect(matchesScored(l, score(null), { ...EMPTY_FILTERS, minScore: 1 })).toBe(false);
  });
});

describe("parking filters", () => {
  const park = (available: boolean, monthlyYen: number | null) =>
    make({ costs: { parking: { available, monthlyYen, location: "onsite", distanceM: null, raw: "x" } } });

  it("'required' drops listings that state no parking", () => {
    const f = { ...EMPTY_FILTERS, parking: "required" as const };
    expect(matchesListing(park(false, null), f)).toBe(false);
    expect(matchesListing(park(true, 7000), f)).toBe(true);
  });

  it("'free' keeps only zero-cost spaces", () => {
    const f = { ...EMPTY_FILTERS, parking: "free" as const };
    expect(matchesListing(park(true, 0), f)).toBe(true);
    expect(matchesListing(park(true, 7000), f)).toBe(false);
    expect(matchesListing(park(false, null), f)).toBe(false);
  });

  it("caps the monthly parking charge", () => {
    const f = { ...EMPTY_FILTERS, parkingMaxYen: 8000 };
    expect(matchesListing(park(true, 7000), f)).toBe(true);
    expect(matchesListing(park(true, 11000), f)).toBe(false);
  });

  it("keeps listings that never stated their parking", () => {
    // Most of the market omits it; excluding them would hide real options.
    const unknown = make({});
    expect(matchesListing(unknown, { ...EMPTY_FILTERS, parking: "required" })).toBe(true);
    expect(matchesListing(unknown, { ...EMPTY_FILTERS, parkingMaxYen: 5000 })).toBe(true);
  });
});
