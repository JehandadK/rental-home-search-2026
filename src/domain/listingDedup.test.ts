import { describe, expect, it } from "vitest";
import type { RawListing } from "./types";
import { deduplicateListings, isSameProperty, mergeDuplicateListings } from "./listingDedup";

const make = (over: Partial<RawListing> = {}): RawListing => ({
  id: "suumo-1",
  name: "ＢＬＥＳＳ草加松原 Ｃ棟",
  address: "埼玉県草加市松江１",
  city: "Soka",
  rent: 110_900,
  layout: "2LDK",
  sizeM2: 72.75,
  builtYear: 2018,
  advertisedStation: "獨協大学前駅",
  stationWalkMin: 9,
  url: "https://suumo.example/1",
  source: "suumo",
  building: { floor: "3階" },
  ...over,
});

describe("cross-source listing deduplication", () => {
  it("matches portal ads when nearly all core values agree", () => {
    const athome = make({
      id: "athome-2",
      name: "ＢＬＥＳＳ草加松原　Ｃ棟",
      address: "埼玉県草加市松江１丁目",
      builtYear: 2019,
      url: "https://athome.example/2",
      source: "athome",
    });
    expect(isSameProperty(make(), athome)).toBe(true);
  });

  it("allows small rent and area noise but rejects important differences", () => {
    expect(isSameProperty(make(), make({ source: "athome", rent: 111_500, sizeM2: 72.8 }))).toBe(true);
    expect(isSameProperty(make(), make({ source: "athome", rent: 118_000 }))).toBe(false);
    expect(isSameProperty(make(), make({ source: "athome", sizeM2: 62 }))).toBe(false);
    expect(isSameProperty(make(), make({ source: "athome", layout: "3LDK" }))).toBe(false);
    expect(isSameProperty(make(), make({ source: "athome", building: { floor: "2階" } }))).toBe(false);
  });

  it("matches the same exact unit when portals label a convertible 2LDK plan as 3K", () => {
    const athome = make({
      id: "athome-6968473236",
      source: "athome",
      name: "原越谷ビル",
      address: "埼玉県越谷市越ヶ谷１丁目",
      rent: 75_000,
      layout: "2LDK",
      sizeM2: 66.7,
      builtYear: 1983,
      advertisedStation: "越谷駅",
      stationWalkMin: 3,
      building: { totalFloors: 3 },
    });
    const suumo = make({
      id: "suumo-原越谷ビル-3K-75000",
      name: "原越谷ビル",
      address: "埼玉県越谷市越ヶ谷１",
      rent: 75_000,
      layout: "3K",
      sizeM2: 66.7,
      builtYear: 1982,
      advertisedStation: "越谷駅",
      stationWalkMin: 3,
      building: { floor: "3階" },
    });

    expect(isSameProperty(athome, suumo)).toBe(true);
    expect(deduplicateListings([athome, suumo])).toHaveLength(1);
    expect(isSameProperty(athome, { ...suumo, name: "別のビル" })).toBe(false);
    expect(isSameProperty(athome, { ...suumo, stationWalkMin: 5 })).toBe(false);
  });

  it("matches the same house when portals label a 3DK plan as 3LDK and choose different stations", () => {
    const athome = make({
      id: "athome-1069992888",
      source: "athome",
      name: "花栗戸建Ⅰ",
      address: "埼玉県草加市花栗１丁目",
      rent: 120_000,
      layout: "3DK",
      sizeM2: 85.28,
      builtYear: 1993,
      advertisedStation: "草加駅",
      stationWalkMin: 20,
      building: { totalFloors: 2 },
    });
    const suumo = make({
      id: "suumo-花栗戸建I-3LDK-120000",
      name: "花栗戸建I",
      address: "埼玉県草加市花栗１",
      rent: 120_000,
      layout: "3LDK",
      sizeM2: 85.28,
      builtYear: 1992,
      advertisedStation: "獨協大学前駅",
      stationWalkMin: 20,
      building: { floor: "1-2階" },
    });

    expect(isSameProperty(athome, suumo)).toBe(true);
    expect(deduplicateListings([athome, suumo])).toHaveLength(1);
    expect(isSameProperty(athome, { ...suumo, stationWalkMin: 21 })).toBe(false);
  });

  it("treats a dash floor as unknown, not as a conflict", () => {
    const athome = make({
      id: "athome-2",
      source: "athome",
      name: "リーブルファイン草加稲荷Ⅲ２号棟",
      address: "埼玉県草加市稲荷５丁目",
      builtYear: 2022,
      building: { floor: "1階" },
    });
    const suumo = make({
      name: "リーブルファイン草加稲荷3－2号棟",
      builtYear: 2021,
      building: { floor: "-" },
    });
    expect(isSameProperty(suumo, athome)).toBe(true);
  });

  it("matches when one portal appends the floor or room number to the name", () => {
    const athome = make({
      id: "athome-2",
      source: "athome",
      name: "エスタディオ草加",
      address: "埼玉県草加市西町",
      builtYear: 2022,
      building: undefined,
    });
    const roomspot = make({
      id: "roomspot-3",
      source: "roomspot",
      name: "エスタディオ草加 1階",
      address: "埼玉県草加市 西町291-6",
      builtYear: 2022,
      building: { floor: "1階" },
    });
    expect(isSameProperty(athome, roomspot)).toBe(true);
    expect(deduplicateListings([athome, roomspot])).toHaveLength(1);
  });

  it("matches an unhyphenated full lot address and keeps it when merging", () => {
    const coarse = make({
      name: "フェリーチェ", address: "埼玉県草加市西町", rent: 105_000,
      layout: "2SLDK", sizeM2: 69.4, builtYear: 2012, stationWalkMin: 18,
      building: { floor: "2階" },
    });
    const exact = make({
      id: "nifty-felice", source: "nifty", name: "フェリーチェ",
      address: "埼玉県草加市西町544", rent: 105_000, layout: "2SLDK",
      sizeM2: 69.4, builtYear: 2013, stationWalkMin: 18,
      building: { floor: "2階" },
    });

    expect(isSameProperty(coarse, exact)).toBe(true);
    const [merged] = deduplicateListings([coarse, exact]);
    expect(merged.address).toBe("埼玉県草加市西町544");
    expect(merged.sourceListings?.map((r) => r.id)).toContain("nifty-felice");
  });

  it("still rejects different floors and distant rents", () => {
    const base = make({ name: "エスタディオ草加", address: "埼玉県草加市西町" });
    expect(isSameProperty(base, make({ id: "a2", source: "athome", name: "エスタディオ草加 2階", building: { floor: "2階" } }))).toBe(false);
    expect(isSameProperty(base, make({ id: "a3", source: "athome", name: "エスタディオ草加", rent: 95_000 }))).toBe(false);
  });

  it("orders merged references athome → suumo → nifty", () => {
    const nifty = make({ id: "nifty-1", source: "nifty", url: "https://nifty.example/1" });
    const athome = make({ id: "athome-2", source: "athome", url: "https://athome.example/2", builtYear: 2019 });
    const merged = mergeDuplicateListings(nifty, make());
    const all = mergeDuplicateListings(merged, athome);
    expect(all.source).toBe("athome");
    expect(all.url).toBe("https://athome.example/2");
    expect(all.sourceListings?.map(({ source }) => source)).toEqual(["athome", "suumo", "nifty"]);
  });

  it("keeps every portal's photos when cross-listed ads merge", () => {
    const photo = (url: string, source: string) => ({ url, kind: "photo" as const, source });
    const nifty = make({ id: "nifty-1", source: "nifty", url: "https://nifty.example/1", photos: [photo("https://img.example/n", "nifty"), photo("https://img.example/shared", "nifty")] });
    const athome = make({ id: "athome-2", source: "athome", url: "https://athome.example/2", photos: [photo("https://img.example/a", "athome"), photo("https://img.example/shared", "athome")] });
    expect(mergeDuplicateListings(nifty, athome).photos?.map(({ url }) => url)).toEqual([
      "https://img.example/a", "https://img.example/shared", "https://img.example/n",
    ]);
    expect(mergeDuplicateListings(make(), make({ id: "nifty-1", source: "nifty" }))).not.toHaveProperty("photos");
  });

  it("collapses one portal's repeat ads for the same unit, keeping both links", () => {
    expect(isSameProperty(make(), make({ id: "suumo-2" }))).toBe(false);
    const twin = make({ id: "suumo-2", url: "https://suumo.example/2" });
    const result = deduplicateListings([make(), twin]);
    expect(result).toHaveLength(1);
    expect(result[0].sourceListings?.map(({ url }) => url).sort()).toEqual([
      "https://suumo.example/1",
      "https://suumo.example/2",
    ]);
  });

  it("keeps same-portal ads for different units separate", () => {
    const otherFloor = make({ id: "suumo-2", building: { floor: "2階" } });
    const otherRent = make({ id: "suumo-3", rent: 118_000 });
    expect(deduplicateListings([make(), otherFloor])).toHaveLength(2);
    expect(deduplicateListings([make(), otherRent])).toHaveLength(2);
  });

  it("does not let a floorless ad attach a Yahoo ground-floor unit to a third-floor group", () => {
    const common = {
      name: "グランコート草加", address: "埼玉県草加市稲荷6丁目",
      layout: "3LDK", sizeM2: 70.72, builtYear: 1995, stationWalkMin: null,
    };
    const result = deduplicateListings([
      make({ ...common, id: "athome-building", source: "athome", rent: 87000, building: undefined }),
      make({ ...common, id: "nifty-103", source: "nifty", name: "グランコート草加 103", address: "埼玉県草加市稲荷6丁目16-1", rent: 85000, building: { floor: "1階" } }),
      make({ ...common, id: "nifty-303", source: "nifty", name: "グランコート草加 303", address: "埼玉県草加市稲荷6丁目16-1", rent: 87000, building: { floor: "3階" } }),
      make({ ...common, id: "suumo-103", source: "suumo", rent: 85000, building: { floor: "1階" } }),
      make({ ...common, id: "yahoo-0703661102", source: "yahoo", name: "グランコート草加(グランコートソウカ)", rent: 85000, building: { floor: "1階" } }),
    ]);
    expect(result).toHaveLength(2);
    const ground = result.find((r) => r.building?.floor === "1階")!;
    const third = result.find((r) => r.building?.floor === "3階")!;
    expect(ground.rent).toBe(85000);
    expect(ground.sourceListings?.map((r) => r.id).sort()).toEqual(["nifty-103", "suumo-103", "yahoo-0703661102"]);
    expect(third.sourceListings?.map((r) => r.id).sort()).toEqual(["athome-building", "nifty-303"]);
  });

  it("does not bridge conflicting floors through a same-source floorless ad", () => {
    const result = deduplicateListings([
      make({ id: "suumo-unknown", building: undefined }),
      make({ id: "suumo-third", building: { floor: "3階" } }),
      make({ id: "suumo-first", building: { floor: "1階" } }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.building?.floor === "1階")?.id).toBe("suumo-first");
  });

  it("folds stale history carrying the same portal detail id after facts were corrected", () => {
    const current = make({
      id: "athome-1126471933",
      source: "athome",
      name: "エステートピアゆうⅠ",
      address: "埼玉県草加市松江６丁目",
      rent: 70_500,
      sizeM2: 73.64,
      builtYear: 1998,
      building: { floor: "1-2階" },
      sourceListings: [
        { source: "athome", id: "athome-1126471933", url: "https://athome.example/current" },
        { source: "suumo", id: "suumo-estate", url: "https://suumo.example/current" },
      ],
    });
    const stale = make({
      id: "suumo-estate",
      name: "エステートピアゆうI",
      address: "埼玉県草加市松江６",
      rent: 70_500,
      sizeM2: 73.64,
      builtYear: 1994,
      building: { floor: "1-2階" },
    });

    const result = deduplicateListings([current, stale]);
    expect(result).toHaveLength(1);
    expect(result[0].sourceListings?.map(({ source }) => source)).toEqual(["athome", "suumo"]);
  });

  it("keeps the preferred record, fills missing details and retains every link", () => {
    // athome outranks suumo, so its presentation leads the merged row.
    const suumo = make({ parking: { available: true, monthlyYen: 7_700, location: "onsite", distanceM: null, raw: "敷地内7700円" } });
    const athome = make({
      id: "athome-2",
      source: "athome",
      url: "https://athome.example/2",
      builtYear: 2019,
      depositYen: 0,
      keyMoneyYen: 162_000,
      costs: { adminFeeYen: 2_900 },
      parking: null,
    });
    const merged = mergeDuplicateListings(suumo, athome);

    expect(merged.source).toBe("athome");
    expect(merged.costs?.adminFeeYen).toBe(2_900);
    expect(merged.parking?.monthlyYen).toBe(7_700);
    expect(merged.sourceListings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "athome", url: "https://athome.example/2" }),
      expect.objectContaining({ source: "suumo", url: "https://suumo.example/1" }),
    ]));
  });
});
