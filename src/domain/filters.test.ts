import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  agencyKey,
  agencyOptions,
  areaOptions,
  cityOptions,
  EMPTY_FILTERS,
  layoutFamily,
  layoutOptions,
  listingArea,
  matchesListing,
  type ListingFilters,
} from "./filters";
import { buildAgencyGazetteer, inferredAgency } from "./agencyNames";
import type { EnrichedListing } from "./types";

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

  it("'newOnly' follows the chosen window", () => {
    const fiveDaysOld = make({ firstSeenAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() });
    expect(matchesListing(fiveDaysOld, { ...EMPTY_FILTERS, newOnly: true, newWithinDays: 7 })).toBe(true);
    expect(matchesListing(fiveDaysOld, { ...EMPTY_FILTERS, newOnly: true, newWithinDays: 3 })).toBe(false);
    // The window alone narrows nothing until "new only" is on.
    expect(matchesListing(fiveDaysOld, { ...EMPTY_FILTERS, newWithinDays: 3 })).toBe(true);
  });
});

describe("UR filter", () => {
  const official = make({ source: "ur", name: "コンフォール松原 3-201" });
  const portal = make({ source: "suumo", name: "ＵＲコンフォール松原" });
  const other = make({ source: "suumo", name: "URBAN HOUSE" });

  it("shows UR rooms by default, and can hide them or show only them", () => {
    const filter = (ur: ListingFilters["ur"]) =>
      [official, portal, other].filter((listing) => matchesListing(listing, { ...EMPTY_FILTERS, ur }));
    expect(filter("show")).toEqual([official, portal, other]);
    expect(filter("hide")).toEqual([other]);
    expect(filter("only")).toEqual([official, portal]);
  });

  it("counts as active only when it narrows the set", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, ur: "only" })).toBe(1);
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

describe("agency filter", () => {
  const info = (name: string, brand: string, company: string | null, branch: string | null, address: string | null) =>
    ({ name, brand, company, branch, address, prefecture: null, city: null, phone: null, licence: null });
  const sokaCity = { id: "city:soka", name: "Soka", nameLocal: "草加市", prefecture: "埼玉県" };
  const koshigayaCity = { id: "city:koshigaya", name: "Koshigaya", nameLocal: "越谷市", prefecture: "埼玉県" };
  const gazetteer = buildAgencyGazetteer([sokaCity, koshigayaCity], [{ name: "北越谷", cityId: "city:koshigaya" }]);
  const branch = make({ id: "a", agencyInfo: info("シャーメゾンショップ　株式会社クイックホーム　北越谷店", "シャーメゾンショップ", "株式会社クイックホーム", "北越谷店", null) });
  const head = make({ id: "b", agencyInfo: info("シャーメゾンショップ　株式会社クイックホーム", "シャーメゾンショップ", "株式会社クイックホーム", null, "埼玉県草加市1") });
  const member = make({ id: "c", agencyInfo: info("シャーメゾンショップ　株式会社ベストハウジング", "シャーメゾンショップ", "株式会社ベストハウジング", null, null) });
  const independent = make({ id: "d", agency: "AnRe不動産" });
  const unknown = make({ id: "e" });
  const listings = [branch, head, member, independent, unknown];
  const shown = (filters: Partial<ListingFilters>) =>
    listings.filter((listing) => matchesListing(listing, { ...EMPTY_FILTERS, ...filters })).map((listing) => listing.id);

  it("includes a chain, an agency with all its stores, or single stores; unknown agencies are left out", () => {
    expect(shown({ agencies: [agencyKey("brand", "シャーメゾンショップ")] })).toEqual(["a", "b", "c"]);
    expect(shown({ agencies: [agencyKey("agency", "クイックホーム")] })).toEqual(["a", "b"]);
    // Every option the panel offers selects the listings it counts.
    for (const brand of agencyOptions(listings, gazetteer)) for (const agency of brand.agencies) {
      expect(shown({ agencies: [agency.key] })).toHaveLength(agency.count);
      for (const store of agency.stores) expect(shown({ agencies: [store.key] })).toHaveLength(store.count);
    }
    expect(shown({ agencies: [agencyKey("store", "シャーメゾンショップ　株式会社クイックホーム　北越谷店"), agencyKey("store", "AnRe不動産")] })).toEqual(["a", "d"]);
  });

  it("excludes them while keeping listings with no known agency", () => {
    expect(shown({ agencies: [agencyKey("agency", "クイックホーム")], agencyMode: "exclude" })).toEqual(["c", "d", "e"]);
    expect(shown({ agencyMode: "exclude" })).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("counts an unread RoomSpot ad under 中央ビル管理, never under one of its offices", () => {
    const read = make({ id: "r1", source: "roomspot", agencyInfo: info("株式会社中央ビル管理 越谷営業所", "中央ビル管理", "株式会社中央ビル管理", "越谷営業所", null) });
    const unread = make({ id: "r2", source: "roomspot" });
    const web = make({ id: "r2", source: "roomspot", agencyInfo: inferredAgency(unread)! });
    expect(web.agencyInfo).toMatchObject({ company: "株式会社中央ビル管理", branch: null, inferred: true });
    const both = [read, web];
    const pick = (key: string) => both.filter((listing) => matchesListing(listing, { ...EMPTY_FILTERS, agencies: [key] })).map((listing) => listing.id);
    expect(pick(agencyKey("agency", "中央ビル管理"))).toEqual(["r1", "r2"]);
    expect(pick(agencyKey("store", "株式会社中央ビル管理"))).toEqual([]);
    expect(agencyOptions(both, gazetteer)[0].agencies[0]).toMatchObject({ count: 2, stores: [expect.objectContaining({ name: "株式会社中央ビル管理 越谷営業所", count: 1 })] });
    // A store a page named, or an ad on another portal, is never replaced by a guess.
    expect(inferredAgency(read)).toBeNull();
    expect(inferredAgency(make({ source: "suumo" }))).toBeNull();
    expect(inferredAgency(make({ source: "suumo", sourceListings: [{ source: "roomspot", id: "x", url: "https://www.roomspot.net/rent/1" }] }))).toMatchObject({ inferred: true });
  });

  it("lists chains with their agencies and where each store is, then independent agencies", () => {
    expect(agencyOptions([...listings, branch], gazetteer)).toEqual([
      { key: "brand:シャーメゾンショップ", brand: "シャーメゾンショップ", brandEn: "Sha Maison Shop", count: 4, agencies: [
        { key: "agency:クイックホーム", agency: "クイックホーム", agencyEn: "Quick Home Co., Ltd.", count: 3, stores: [
          { key: "store:シャーメゾンショップ　株式会社クイックホーム　北越谷店", name: "シャーメゾンショップ　株式会社クイックホーム　北越谷店",
            branch: "北越谷店", place: "北越谷", city: koshigayaCity, count: 2 },
          { key: "store:シャーメゾンショップ　株式会社クイックホーム", name: "シャーメゾンショップ　株式会社クイックホーム",
            branch: null, place: null, city: sokaCity, count: 1 },
        ] },
        { key: "agency:ベストハウジング", agency: "ベストハウジング", agencyEn: "Best Housing Co., Ltd.", count: 1, stores: [
          { key: "store:シャーメゾンショップ　株式会社ベストハウジング", name: "シャーメゾンショップ　株式会社ベストハウジング",
            branch: null, place: null, city: null, count: 1 },
        ] },
      ] },
      { key: null, brand: null, brandEn: null, count: 1, agencies: [
        { key: "agency:AnRe不動産", agency: "AnRe不動産", agencyEn: "AnRe Real Estate", count: 1, stores: [
          { key: "store:AnRe不動産", name: "AnRe不動産", branch: null, place: null, city: null, count: 1 },
        ] },
      ] },
    ]);
  });
});
