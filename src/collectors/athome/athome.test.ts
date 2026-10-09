import { describe, expect, it } from "vitest";
import { isFamilyLayout, parseAthomeAgency, parseAthomePage } from "./athome";
import { athomeKey } from "../../data-layer/ingestion/portalPolicy";
import { preparePortalRows } from "../../data-layer/ingestion/portalBatch.contract";
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
    const [merged] = preparePortalRows("athome", [prior], [{ ...fresh, rent: 73_000 }]).listings;
    expect(merged.rent).toBe(73_000);
    expect(merged.parking).toEqual(prior.parking);
    expect(merged.costs?.parking).toEqual(prior.parking);
    expect(merged.building?.conditions).toEqual(prior.building?.conditions);
  });

  it("does not preserve old paid parking over explicitly unavailable parking", () => {
    const [prior] = parseAthomePage(fixture, "Soka");
    prior.parking = { ...prior.parking!, monthlyYen: 8000 };
    const [fresh] = parseAthomePage(fixture.replace('<li>駐車場', '<li class="p-property__information-facility_disabled-list">駐車場'), "Soka");
    const [merged] = preparePortalRows("athome", [prior], [fresh]).listings;
    expect(merged.parking?.available).toBe(false);
    expect(merged.costs?.parking?.available).toBe(false);
    expect(merged.building?.conditions).not.toContain("駐車場（近隣含む）");
  });
});

describe("AtHome identity and live merge", () => {
  it("uses the stable property number", () => expect(athomeKey(make())).toBe("athome:1119917524"));

  it("keeps two same-size rooms of one building that appear in the same batch", () => {
    const a = make(), b = make({ id: "athome-2", url: "https://www.athome.co.jp/chintai/2/" });
    expect(preparePortalRows("athome", [], [a, b])).toMatchObject({ added: 2, listings: [{ id: a.id }, { id: b.id }] });
    // A stored room is claimed by one fresh row only; the sibling is a new room, not its update.
    const merged = preparePortalRows("athome", [a], [a, b]);
    expect(merged.listings.map((row) => row.id)).toEqual([a.id, b.id]);
    expect(merged).toMatchObject({ added: 1, updated: 1, retirements: [] });
    // The same ad seen twice (same ID) is still one row.
    expect(preparePortalRows("athome", [], [a, { ...a, rent: 73_000 }]).listings).toHaveLength(1);
  });
});

describe("parseAthomeAgency", () => {
  // 掲載不動産会社 as AtHome printed it on 2026-10-08 (trimmed).
  const detail = `<div class="company-info-area" id="section5"><div class="company-info-area__inner">
<h2 class="company-info-area__title">掲載不動産会社</h2><div class="post"><div class="company-info-area__head">
<div class="head__name post-title__left"><a href="/ahto/a-nishikasai.html">アエラス西葛西店 (株)アエラス</a></div></div>
<table class="company-info-area__inner-list info"><tbody>
<tr><th>所在地</th><td colspan="3"> 〒134-0088 東京都江戸川区西葛西６丁目８－１０ 朝日生命西葛西ビル ７階 <a class="button map-icon-button"><img alt="地図アイコン"></a></td></tr>
<tr><th>交通</th><td colspan="3"><span>東京メトロ東西線/西葛西駅 徒歩1分</span></td></tr>
<tr class="item"><th>免許番号</th><td class="item">国土交通大臣免許（３）第８５２２号</td><th>TEL/FAX</th><td>03-6456-0315 ／<br>03-6456-0316</td></tr>
</tbody></table></div></div></div>`;

  it("reads the listing company, its branch and the city it is in", () => {
    expect(parseAthomeAgency(detail)).toEqual({ name: "アエラス西葛西店 (株)アエラス", brand: "アエラス", company: "株式会社アエラス",
      branch: "西葛西店", address: "東京都江戸川区西葛西6丁目8-10 朝日生命西葛西ビル 7階", prefecture: "東京都", city: "江戸川区",
      phone: "03-6456-0315", licence: "国土交通大臣(3)第8522号" });
  });

  it("returns null for a page without the company block", () => {
    expect(parseAthomeAgency("<div class=\"p-property\"></div>")).toBeNull();
  });
});
