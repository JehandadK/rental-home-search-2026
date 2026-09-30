import { describe, expect, it } from "vitest";
import { athomeKey, athomeObservationBatch, isAthomeOverlap, isFamilyLayout, mergeAthomeIncremental, parseAthomePage } from "./athome";
import type { RawListing } from "../../domain/types";

const make = (over: Partial<RawListing> = {}): RawListing => ({
  id: "athome-1119917524",
  name: "カーサレシェンテ",
  address: "埼玉県草加市氷川町",
  city: "Soka",
  rent: 72_000,
  layout: "2DK",
  sizeM2: 39.79,
  builtYear: 1991,
  stationWalkMin: 8,
  url: "https://www.athome.co.jp/chintai/1119917524/",
  source: "athome",
  ...over,
});

const fixture = `<!doctype html><div class="p-property">
<h2 class="p-property__title--building">カーサレシェンテ 2階建</h2>
<dl><dt><i title="所在地"></i></dt><dd><strong>草加市氷川町</strong></dd></dl>
<dl><dt><i title="交通"></i></dt><dd>東武伊勢崎線 「草加」駅 徒歩8分</dd></dl>
<dl><dt><i title="家"></i></dt><dd>賃貸アパート<br>2階建<br>1991年8月 (築35年)</dd></dl>
<div class="p-property__room--detailbox" data-bukken-no="1119917524">
 <div class="p-property__information-price"><b class="p-property__information-rent">6.9</b>万円<span>3,000円</span></div>
 <div class="p-property__room-keymoney"><p>1.5ヶ月</p><span>なし</span></div>
 <div class="p-property__room-floorplan"><div class="p-property__floor">2DK</div><span>39.79m²</span></div>
 <div class="p-property__information-facility"><ul><li>駐車場（近隣含む）</li><li class="p-property__information-facility_disabled-list">ペット相談</li><li>即入居可</li></ul></div>
 <a href="/chintai/1119917524/?DOWN=1">詳細を見る</a>
</div></div>`;

describe("isFamilyLayout", () => {
  it("keeps 2K+ and excludes one-room inventory", () => {
    expect(isFamilyLayout("2DK")).toBe(true);
    expect(isFamilyLayout("3LDK")).toBe(true);
    expect(isFamilyLayout("1LDK")).toBe(false);
    expect(isFamilyLayout("ワンルーム")).toBe(false);
  });
});

describe("parseAthomePage", () => {
  it("extracts scoring and relevant amenity fields from a list page", () => {
    const [listing] = parseAthomePage(fixture, "Soka");
    expect(listing).toMatchObject({
      id: "athome-1119917524",
      name: "カーサレシェンテ",
      address: "埼玉県草加市氷川町",
      city: "Soka",
      rent: 72_000,
      layout: "2DK",
      sizeM2: 39.79,
      builtYear: 1991,
      depositYen: 103_500,
      keyMoneyYen: 0,
      advertisedStation: "草加駅",
      stationWalkMin: 8,
      source: "athome",
    });
    expect(listing.parking).toMatchObject({ available: true, monthlyYen: null });
    expect(listing.building?.conditions).toEqual(["駐車場（近隣含む）", "即入居可"]);
  });
});

describe("AtHome missing amenity evidence", () => {
  const withoutFacilities = fixture.replace(/ <div class="p-property__information-facility">.*<\/div>\n/, "");

  it("preserves historical parking and conditions when a new list template omits them", () => {
    const [prior] = parseAthomePage(fixture, "Soka");
    const [fresh] = parseAthomePage(withoutFacilities, "Soka");
    expect(fresh.parking).toBeUndefined();
    expect(fresh.building?.conditions).toBeUndefined();
    const [merged] = mergeAthomeIncremental([prior], [{ ...fresh, rent: 73_000 }]).listings;
    expect(merged.rent).toBe(73_000);
    expect(merged.parking).toEqual(prior.parking);
    expect(merged.costs?.parking).toEqual(prior.parking);
    expect(merged.building?.conditions).toEqual(prior.building?.conditions);
  });

  it("does not preserve old paid parking over explicitly unavailable parking", () => {
    const [prior] = parseAthomePage(fixture, "Soka");
    prior.parking = { ...prior.parking!, monthlyYen: 8000 };
    const [fresh] = parseAthomePage(fixture.replace('<li>駐車場', '<li class="p-property__information-facility_disabled-list">駐車場'), "Soka");
    const [merged] = mergeAthomeIncremental([prior], [fresh]).listings;
    expect(merged.parking?.available).toBe(false);
    expect(merged.costs?.parking?.available).toBe(false);
    expect(merged.building?.conditions).not.toContain("駐車場（近隣含む）");
  });
});

describe("AtHome identity and incremental merge", () => {
  it("uses the stable property number", () => expect(athomeKey(make())).toBe("athome:1119917524"));

  it("recognizes a rent change as an overlap", () => {
    expect(isAthomeOverlap(make(), make({ id: "athome-999", url: "https://www.athome.co.jp/chintai/999/", rent: 70_000 }))).toBe(true);
  });

  it("retires an old source ID only when the merge proves a superseding alias", () => {
    const old = make();
    const replacement = make({ id: "athome-999", url: "https://www.athome.co.jp/chintai/999/", rent: 70_000 });
    const merged = mergeAthomeIncremental([old], [replacement]);
    const batch = athomeObservationBatch({
      previous: [old],
      current: merged.listings,
      expectedRevision: "revision-1",
      observedAt: "2026-09-25T00:00:00.000Z",
      observedAtByKey: {},
      provenance: {},
    });
    expect(batch.observations.map((observation) => observation.sourceListingId)).toEqual(["athome-999"]);
    expect(batch.retirements).toEqual([expect.objectContaining({
      id: "athome-1119917524",
      reason: expect.stringContaining("matching unit aliases"),
    })]);
  });

  it("updates observed records and preserves unseen history", () => {
    const old = make({ rent: 72_000 });
    const unseen = make({ id: "athome-2", name: "Other", address: "埼玉県越谷市蒲生", url: "https://www.athome.co.jp/chintai/2/" });
    const current = make({ rent: 70_000 });
    const result = mergeAthomeIncremental([old, unseen], [current]);
    expect(result.listings).toHaveLength(2);
    expect(result.listings[0].rent).toBe(70_000);
    expect(result.listings[1].name).toBe("Other");
    expect(result).toMatchObject({ added: 0, updated: 1, overlaps: 1 });
  });
});
