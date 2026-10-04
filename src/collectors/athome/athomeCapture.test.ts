import { describe, expect, it } from "vitest";
import { athomeDownloadedCapture } from "./athomeCapture";
import { parseAthomePage } from "./athome";
import { preparePortalRows } from "../../data-layer/ingestion/portalBatch.contract";
import { validateCapture } from "../shared/captureStore";

const url = "https://www.athome.co.jp/chintai/saitama/list/page2/?pref=11&cities=soka&cityCds=11221&sort=33&limit=30";
const time = "2026-09-22T06:01:41.499Z";
const html = `<html><head><script>unrelated()</script></head><body>
  <select name="SORT"><option value="33" selected>新着順</option></select>
  <div class="property-card" data-tracking="discard">
    <h2 class="property-title">テスト &amp; ホーム 3階建</h2>
    <div class="info-item--location">草加市金明町</div>
    <div class="info-item--station">東武伊勢崎線 「新田」駅 徒歩6分</div>
    <div class="info-item--type">賃貸マンション 3階建2020年5月</div>
    <div class="room-info-section"><script>doNotRun()</script><img src="tracking">
      <div class="price"><span class="rent">8.2万円</span><span>3,000円</span></div>
      <div class="fees"><span>なし</span><span>1ヶ月</span></div>
      <div class="layout-size"><span>3LDK</span><span>75.50m²</span></div>
      <a href="/chintai/1234567890/?tracking=discard">詳細を見る</a>
    </div>
  </div></body></html>`;

describe("offline native-download AtHome capture", () => {
  it("projects public fields, verifies metadata, and parses through the existing importer", () => {
    const capture = athomeDownloadedCapture(html, url, time);
    expect(capture).toMatchObject({ city: "Soka", page: 2, capturedAt: time, sortedNewest: true, httpStatus: 200 });
    expect(() => validateCapture(capture)).not.toThrow();
    const rows = parseAthomePage(capture.html, capture.city);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "テスト & ホーム", address: "埼玉県草加市金明町", rent: 85000,
      sizeM2: 75.5, layout: "3LDK", builtYear: 2020, depositYen: 0, keyMoneyYen: 82000,
      stationWalkMin: 6, url: "https://www.athome.co.jp/chintai/1234567890/" });
    expect(capture.html).not.toMatch(/script|tracking|img|unrelated|doNotRun/);
  });

  it("accepts a Tokyo ward's city path and prefixes its addresses with 東京都, not 埼玉県", () => {
    const ward = html.replace("草加市金明町", "葛飾区高砂7丁目");
    const capture = athomeDownloadedCapture(ward, "https://www.athome.co.jp/chintai/tokyo/katsushika-city/list/page3/?sort=33", time);
    expect(capture).toMatchObject({ city: "Katsushika", page: 3 });
    expect(parseAthomePage(capture.html, capture.city)[0].address).toBe("東京都葛飾区高砂7丁目");
    // A Soka card on the Katsushika page, or the ward under the wrong prefecture path, is rejected.
    expect(() => athomeDownloadedCapture(html, "https://www.athome.co.jp/chintai/tokyo/katsushika-city/list/?sort=33", time)).toThrow("wrong city");
    expect(() => athomeDownloadedCapture(ward, "https://www.athome.co.jp/chintai/saitama/katsushika-city/list/?sort=33", time)).toThrow("Invalid AtHome capture URL");
  });

  it("keeps the building carousel and loaded floor plans as full-size photos", () => {
    const withPhotos = html
      .replace('<h2 class="property-title">', `<div class="image-item swiper-slide"><img class="swiper-lazy" alt="物件画像" data-src="https://www.athome.co.jp/image_files/path/AAA==" src="https://www.athome.co.jp/image_files/path/AAA==?width=340&height=195&margin=true"></div>
        <div class="image-item swiper-slide"><img class="swiper-lazy" alt="物件画像" data-src="https://www.athome.co.jp/image_files/path/BBB==" src="/static_app_contents/x/assets/common/loading_g.gif"></div>
        <h2 class="property-title">`)
      .replace('<div class="price">', `<div class="room-image zoom-icon"><img alt="テスト 101 3LDKの間取り図" src="https://www.athome.co.jp/image_files/path/CCC==?width=120&height=120&margin=true"></div>
        <div class="new-icon"><img alt="NEW" src="/static_app_contents/x/assets/common/icon_new.svg"></div><div class="price">`);
    const capture = athomeDownloadedCapture(withPhotos, url, time);
    expect(capture.html).not.toMatch(/icon_new|swiper|tracking/);
    expect(parseAthomePage(capture.html, capture.city)[0].photos).toEqual([
      { url: "https://www.athome.co.jp/image_files/path/AAA==", kind: "photo", source: "athome" },
      { url: "https://www.athome.co.jp/image_files/path/BBB==", kind: "photo", source: "athome" },
      { url: "https://www.athome.co.jp/image_files/path/CCC==", kind: "floorPlan", source: "athome" },
    ]);
  });

  it("preserves unknown amenities rather than erasing historical parking", () => {
    const fresh = parseAthomePage(athomeDownloadedCapture(html, url, time).html, "Soka")[0];
    // The modern card template carries no amenity list, so the parser must not invent one.
    expect(fresh.parking).toBeUndefined();
    expect(fresh.building?.conditions).toBeUndefined();
    const parking = { available: true, monthlyYen: 8000, raw: "駐車場8000円", location: "onsite" as const, distanceM: null };
    const prior = { ...fresh, parking, building: { ...fresh.building, conditions: ["都市ガス"] } };
    const merged = preparePortalRows("athome", [prior], [fresh]).listings[0];
    expect(merged.parking).toEqual(parking);
    expect(merged.building?.conditions).toEqual(["都市ガス"]);
  });

  it("keeps a zero-family building marker without claiming exhaustion", () => {
    const capture = athomeDownloadedCapture(html.replace("3LDK", "1LDK"), url, time);
    expect(() => validateCapture(capture)).not.toThrow();
    expect(parseAthomePage(capture.html, "Soka")).toEqual([]);
  });

  it("rejects an unverified sort and a blocked page", () => {
    expect(() => athomeDownloadedCapture(html.replace('value="33"', 'value="16"'), url, time)).toThrow("sort not verified");
    expect(() => athomeDownloadedCapture("<h1>Verification</h1>", url, time)).toThrow();
    expect(() => athomeDownloadedCapture('<select name="SORT"><option value="33">new</option></select>', url, time)).toThrow("No AtHome property cards");
  });

  it("rejects mismatched city filters, card addresses, URLs and timestamps", () => {
    expect(() => athomeDownloadedCapture(html, url.replace("11221", "11203"), time)).toThrow("Invalid AtHome capture");
    expect(() => athomeDownloadedCapture(html.replace("草加市", "川口市"), url, time)).toThrow("wrong city");
    expect(() => athomeDownloadedCapture(html, url.replace("www.athome.co.jp", "example.com"), time)).toThrow("Invalid AtHome capture");
    expect(() => athomeDownloadedCapture(html, url, "invalid")).toThrow("Invalid AtHome capture");
  });

  it("accepts city-path results, taking the city from the path", () => {
    const cityUrl = "https://www.athome.co.jp/chintai/saitama/soka-city/list/page3/?sort=33";
    expect(athomeDownloadedCapture(html, cityUrl, time)).toMatchObject({ city: "Soka", page: 3, url: cityUrl });
    expect(athomeDownloadedCapture(html, cityUrl.replace("page3/", ""), time).page).toBe(1);
    expect(() => athomeDownloadedCapture(html, cityUrl.replace("soka", "kawaguchi"), time)).toThrow("wrong city");
    for (const bad of [cityUrl.replace("sort=33", "sort=95"), cityUrl.replace("soka-city", "constructor-city"), cityUrl.replace("saitama", "tokyo")]) {
      expect(() => athomeDownloadedCapture(html, bad, time)).toThrow("Invalid AtHome capture");
    }
  });

  it("fails on malformed family cards rather than silently dropping records", () => {
    for (const broken of [html.replace("75.50m²", "unknown"), html.replace("8.2万円", "unknown"), html.replace("1234567890", "invalid"), html.replace("3LDK", "")]) {
      expect(() => athomeDownloadedCapture(broken, url, time)).toThrow();
    }
  });

  it("rejects offsite detail URLs", () => {
    expect(() => athomeDownloadedCapture(html.replace('href="/chintai/', 'href="https://example.com/chintai/'), url, time)).toThrow("valid ID");
  });
});
