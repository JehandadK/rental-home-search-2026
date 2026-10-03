// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseNiftyPage } from "./nifty";
import { mergeNiftyIncremental } from "../../data-layer/ingestion/niftyPolicy";
import { niftyCaptureExpression } from "./niftyCapture";
const fixture = (layout = "2LDK") => `<div class="card"><header><h2>家の賃貸物件</h2><p>埼玉県草加市1丁目</p><li data-transport-access>新田駅 歩7分</li><dl><dt>築年数</dt><dd>築10年</dd></dl><dl><dt>総階数</dt><dd>3階建</dd></dl><span class="badge is-outline">駐車場あり</span></header><table class="result-bukken-table"><tbody class="click-area"><tr><td></td><td></td><td>2階</td><td><p>${layout}</p><p>50.5㎡</p></td><td class="bukken-info-rent"><p>8万円</p><p>5,000円</p></td><td><dl><dt>敷</dt><dd>不要</dd></dl><dl><dt>礼</dt><dd>1ヶ月</dd></dl></td></tr><tr><td><span class="badge is-outline">バス・トイレ別</span><a href="/rent/saitama/sokashi_ct/detail_aabbcc/">詳細</a></td></tr></tbody></table></div>`;
const BUILDING = "https://realestate-pctr.c.yimg.jp/abc";
const PLAN = "https://img4.athome.jp/image_files/index/bukken/1/1.jpeg?height=100&width=100";
const withPhotos = fixture()
  .replace("<h2>家の賃貸物件</h2>", `<h2>家の賃貸物件</h2><div class="thumbnail-wrap"><img class="lazyload thumbnail" src="/rent/assets/pc/img/lazy-load-pc.gif" data-src="${BUILDING}" alt="新田駅より徒歩7分の賃貸物件"></div>`)
  .replace("<tr><td></td><td></td>", `<tr><td><img class="lazyload thumbnail-parent" src="/rent/assets/pc/img/lazy-load-pc.gif" data-src="${BUILDING}" alt="建物画像"></td><td><img class="lazyload thumbnail" data-src="${PLAN}" alt="間取り図"><img class="lazyload thumbnail" data-src="/rent/assets/pc/img/noimage-photo-pc.png" alt="間取り図"></td>`);
describe("Nifty list-first collection", () => {
  it("keeps the building photo and floor plan, dropping no-image art", () => {
    expect(parseNiftyPage(withPhotos, "Soka", 2026)[0].photos).toEqual([
      { url: BUILDING, kind: "exterior", source: "nifty" },
      { url: "https://img4.athome.jp/image_files/index/bukken/1/1.jpeg?height=360&width=480", kind: "floorPlan", source: "nifty" },
    ]);
    expect(parseNiftyPage(fixture(), "Soka", 2026)[0]).not.toHaveProperty("photos");
  });
  it("carries the photos through the capture projection", async () => {
    const url = "https://myhome.nifty.com/rent/saitama/sokashi_ct/?sort=regDate-desc";
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = withPhotos + '<select name="sort"><option value="regDate-desc" selected>新着</option></select>';
    const html = await new Function("document", "location", `return ${niftyCaptureExpression(url)}`)(doc, { href: url });
    expect(parseNiftyPage(html, "Soka", 2026)).toEqual(parseNiftyPage(withPhotos, "Soka", 2026));
  });
  it("captures all essentials and amenities without a detail request", () => {
    const [l] = parseNiftyPage(fixture(), "Soka", 2026);
    expect(l).toMatchObject({ id: "nifty-aabbcc", name: "家", rent: 85000, sizeM2: 50.5, builtYear: 2016, depositYen: 0, keyMoneyYen: 80000, stationWalkMin: 7, parking: { available: true, monthlyYen: null } });
    expect(l.building?.features).toEqual(["駐車場あり", "バス・トイレ別"]);
  });
  it("excludes small layouts on the list page", () => expect(parseNiftyPage(fixture("1K"), "Soka")).toEqual([]));
  it("updates price using stable ad identity and retains expensive details", () => {
    const [l] = parseNiftyPage(fixture(), "Soka");
    const prior = { ...l, rent: 90000, parking: { ...l.parking!, monthlyYen: 6000 }, tenancy: { leaseType: "regular" as const } };
    const merged = mergeNiftyIncremental([prior], [l]);
    expect(merged.added).toBe(0);
    expect(merged.listings[0]).toMatchObject({ rent: 85000, parking: { monthlyYen: 6000 }, tenancy: { leaseType: "regular" } });
  });
});
