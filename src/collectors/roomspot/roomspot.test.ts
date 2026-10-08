import { describe, expect, it } from "vitest";
import { isFamilyLayout, parseRoomspotAgency, parseRoomspotPage } from "./roomspot";
import { roomspotKey } from "../../data-layer/ingestion/portalPolicy";
import { preparePortalRows } from "../../data-layer/ingestion/portalBatch.contract";
import type { RawListing } from "../../domain/types";

const fixture = `<article class="data"><h2>テストハイツ</h2><table class="spec">
<tr><td class="kokoku-list-data__address">埼玉県草加市谷塚町1-2</td></tr>
<tr><td class="kokoku-list-data__access">東武スカイツリーライン 谷塚駅 徒歩5分</td></tr>
<tr><td class="kokoku-list-data__age">2018年3月</td></tr></table>
<table class="room_data"><tbody><tr><td><a href="https://www.roomspot.net/rent/12345">テストハイツ 201</a></td>
<td class="kokoku-list-condition__floor">2階</td>
<td class="kokoku-list-condition__price"><strong>8万5000</strong>円<span class="pc">5,000円</span></td>
<td class="kokoku-list-condition__deposit">敷金 1ヶ月 / 礼金 0ヶ月</td>
<td class="kokoku-list-condition__layout">2LDK / 55.2㎡</td></tr></tbody></table></article>`;

const make = (over: Partial<RawListing> = {}): RawListing => ({
  id: "roomspot-12345", name: "テストハイツ", address: "埼玉県草加市谷塚町1-2",
  city: "Soka", rent: 90_000, layout: "2LDK", sizeM2: 55.2, builtYear: 2018,
  stationWalkMin: 5, url: "https://www.roomspot.net/rent/12345", source: "roomspot", ...over,
});

describe("RoomSpot parser", () => {
  it("keeps only 2K+ layouts", () => {
    expect(isFamilyLayout("2DK")).toBe(true); expect(isFamilyLayout("1LDK")).toBe(false);
  });
  it("extracts relevant listing data", () => {
    expect(parseRoomspotPage(fixture, "Soka")[0]).toMatchObject({
      id: "roomspot-12345", name: "テストハイツ 2階", rent: 90_000,
      layout: "2LDK", sizeM2: 55.2, builtYear: 2018, depositYen: 85_000,
      keyMoneyYen: 0, advertisedStation: "谷塚駅", stationWalkMin: 5,
    });
  });
  it("reads a whole-man rent whose 万円 sits outside <strong>, ignoring the mobile admin-fee duplicate", () => {
    const whole = fixture.replace('<strong>8万5000</strong>円<span class="pc">5,000円</span>',
      '<strong class="color_em">12</strong>万円 <br><span class="sp"><div>(管理費：3,000円)</div></span><span class="pc"> 3,000円 </span>');
    expect(parseRoomspotPage(whole, "Soka")[0]).toMatchObject({ rent: 123_000, depositYen: 120_000, costs: { adminFeeYen: 3_000 } });
  });
  it("keeps the building exterior and the room's floor plan, skipping lazy-load stand-ins", () => {
    const withPhotos = fixture
      .replace('<h2>テストハイツ</h2>', '<h2>テストハイツ</h2><div class="tm_data"><figure class="wp-block-image img_4_3"><img class="ofi contain lazyload" data-src="https://property.es-img.jp/rent/img/1/1_10.jpg?iid=3" alt="テストハイツ(賃貸アパートの外観)"></figure></div>')
      .replace('<td><a href="https://www.roomspot.net/rent/12345">', '<td><div class="img_4_3"><img data-src="https://property.es-img.jp/rent/img/1/1_1.jpg?iid=4" alt="テストハイツ(賃貸アパート201の間取り)"><img data-src="https://www.roomspot.net/app/images/transparent.gif"></div><a href="https://www.roomspot.net/rent/12345">');
    expect(parseRoomspotPage(withPhotos, "Soka")[0].photos).toEqual([
      { url: "https://property.es-img.jp/rent/img/1/1_10.jpg?iid=3", kind: "exterior", source: "roomspot" },
      { url: "https://property.es-img.jp/rent/img/1/1_1.jpg?iid=4", kind: "floorPlan", source: "roomspot" },
    ]);
  });
  it("omits photos when a card has none, so a merge keeps earlier ones", () => {
    const [fresh] = parseRoomspotPage(fixture, "Soka");
    expect(fresh).not.toHaveProperty("photos");
    const photos = [{ url: "https://property.es-img.jp/rent/img/1/1_10.jpg", kind: "exterior" as const, source: "roomspot" }];
    expect(preparePortalRows("roomspot", [{ ...fresh, photos }], [fresh]).listings[0].photos).toEqual(photos);
  });
  it("uses stable ids", () => {
    expect(roomspotKey(make())).toBe("roomspot:12345");
  });
  it("updates the observed ad and keeps an unseen, unrelated one", () => {
    const other = make({ id: "roomspot-2", name: "Other", address: "埼玉県越谷市蒲生", url: "https://www.roomspot.net/rent/2" });
    const result = preparePortalRows("roomspot", [make(), other], [make({ rent: 88_000 })]);
    expect(result.listings.map((row) => [row.id, row.rent])).toEqual([["roomspot-12345", 88_000], ["roomspot-2", 90_000]]);
    expect(result.retirements).toEqual([]);
  });
});

describe("parseRoomspotAgency", () => {
  // 広告主情報 as RoomSpot printed it on 2026-10-08 (trimmed).
  const detail = `<div class="kokoku-detail-realtor spec spec_detail"><h2>ドルフクレセント八番館の広告主情報</h2>
<table class="spec_table_default col4"><tbody>
<tr><th class="kokoku-detail-realtor__name">店舗名称</th><td class="kokoku-detail-realtor__name"> 株式会社中央ビル管理 北千住営業所 </td>
<th class="kokoku-detail-realtor__staff">担当者</th><td class="kokoku-detail-realtor__staff"> </td></tr>
<tr><th class="kokoku-detail-realtor__address">事務所の所在地</th><td class="kokoku-detail-realtor__address"> 東京都足立区千住２丁目22マスミビル1階 </td>
<th class="kokoku-detail-realtor__tel">電話番号</th><td class="kokoku-detail-realtor__tel"><a href="tel:0120956776">0120-956-776</a></td></tr>
<tr><th class="kokoku-detail-realtor__license">宅建免許番号</th><td class="kokoku-detail-realtor__license"> 国土交通大臣（9）第3918号 </td>
<th class="kokoku-detail-realtor__code">不動産会社コード</th><td class="kokoku-detail-realtor__code"> 2003962 </td></tr>
</tbody></table></div>`;

  it("reads the advertising office, its brand and the city it is in", () => {
    expect(parseRoomspotAgency(detail)).toEqual({ name: "株式会社中央ビル管理 北千住営業所", brand: "中央ビル管理",
      company: "株式会社中央ビル管理", branch: "北千住営業所", address: "東京都足立区千住2丁目22マスミビル1階",
      prefecture: "東京都", city: "足立区", phone: "0120-956-776", licence: "国土交通大臣(9)第3918号" });
  });

  it("returns null for a page without the advertiser block", () => {
    expect(parseRoomspotAgency(fixture)).toBeNull();
  });
});
