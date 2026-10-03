import { describe, expect, it } from "vitest";
import { isFamilyLayout, parseRoomspotPage } from "./roomspot";
import { mergeRoomspotIncremental, roomspotKey, roomspotObservationBatch } from "../../data-layer/ingestion/portalPolicy";
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
    expect(mergeRoomspotIncremental([{ ...fresh, photos }], [fresh]).listings[0].photos).toEqual(photos);
  });
  it("retires an old source ID only when the merge proves a superseding alias", () => {
    const old = make();
    const replacement = make({ id: "roomspot-67890", url: "https://www.roomspot.net/rent/67890", rent: 88_000 });
    const merged = mergeRoomspotIncremental([old], [replacement]);
    const batch = roomspotObservationBatch({
      previous: [old],
      current: merged.listings,
      expectedRevision: "revision-1",
      observedAt: "2026-09-25T00:00:00.000Z",
      observedAtByKey: {},
      provenance: {},
    });
    expect(batch.observations.map((observation) => observation.sourceListingId)).toEqual(["roomspot-67890"]);
    expect(batch.retirements).toEqual([expect.objectContaining({
      id: "roomspot-12345",
      reason: expect.stringContaining("matching unit aliases"),
    })]);
  });

  it("does not infer retirement from an incremental absence without a matching alias", () => {
    const old = make();
    const other = make({ id: "roomspot-2", name: "Other", address: "埼玉県越谷市蒲生", url: "https://www.roomspot.net/rent/2" });
    const batch = roomspotObservationBatch({
      previous: [old, other],
      current: [other],
      expectedRevision: "revision-1",
      observedAt: "2026-09-25T00:00:00.000Z",
      observedAtByKey: {},
      provenance: {},
    });
    expect(batch.retirements).toEqual([]);
  });

  it("uses stable ids and preserves unseen history", () => {
    expect(roomspotKey(make())).toBe("roomspot:12345");
    const other = make({ id: "roomspot-2", name: "Other", address: "埼玉県越谷市蒲生", url: "https://www.roomspot.net/rent/2" });
    const result = mergeRoomspotIncremental([make(), other], [make({ rent: 88_000 })]);
    expect(result.listings).toHaveLength(2); expect(result.listings[0].rent).toBe(88_000);
  });
});
