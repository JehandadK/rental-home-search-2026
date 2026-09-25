// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseNiftyPage, mergeNiftyIncremental } from "./nifty";
import { niftyCaptureExpression } from "./niftyCapture";
const fixture = (layout = "2LDK") => `<div class="card"><header><h2>家の賃貸物件</h2><p>埼玉県草加市1丁目</p><li data-transport-access>新田駅 歩7分</li><dl><dt>築年数</dt><dd>築10年</dd></dl><dl><dt>総階数</dt><dd>3階建</dd></dl><span class="badge is-outline">駐車場あり</span></header><table class="result-bukken-table"><tbody class="click-area"><tr><td></td><td></td><td>2階</td><td><p>${layout}</p><p>50.5㎡</p></td><td class="bukken-info-rent"><p>8万円</p><p>5,000円</p></td><td><dl><dt>敷</dt><dd>不要</dd></dl><dl><dt>礼</dt><dd>1ヶ月</dd></dl></td></tr><tr><td><span class="badge is-outline">バス・トイレ別</span><a href="/rent/saitama/sokashi_ct/detail_aabbcc/">詳細</a></td></tr></tbody></table></div>`;
describe("Nifty list-first collection", () => {
  it("captures all essentials and amenities without a detail request", () => {
    const [l] = parseNiftyPage(fixture(), "Soka", 2026);
    expect(l).toMatchObject({ id: "nifty-aabbcc", name: "家", rent: 85000, sizeM2: 50.5, builtYear: 2016, depositYen: 0, keyMoneyYen: 80000, stationWalkMin: 7, parking: { available: true, monthlyYen: null } });
    expect(l.building?.features).toEqual(["駐車場あり", "バス・トイレ別"]);
  });
  it("excludes small layouts on the list page", () => expect(parseNiftyPage(fixture("1K"), "Soka")).toEqual([]));
  it("projects the already-loaded DOM without any fetch, preserving parser fields", async () => {
    const url = "https://myhome.nifty.com/rent/saitama/sokashi_ct/?sort=regDate-desc";
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = fixture() + '<select name="sort"><option value="regDate-desc" selected>新着</option></select>';
    const html = await new Function("document", "location", `return ${niftyCaptureExpression(url)}`)(doc, { href: url });
    expect(parseNiftyPage(html, "Soka", 2026)).toEqual(parseNiftyPage(fixture(), "Soka", 2026));
  });
  it("updates price using stable ad identity and retains expensive details", () => {
    const [l] = parseNiftyPage(fixture(), "Soka");
    const prior = { ...l, rent: 90000, parking: { ...l.parking!, monthlyYen: 6000 }, tenancy: { leaseType: "regular" as const } };
    const merged = mergeNiftyIncremental([prior], [l]);
    expect(merged.added).toBe(0);
    expect(merged.listings[0]).toMatchObject({ rent: 85000, parking: { monthlyYen: 6000 }, tenancy: { leaseType: "regular" } });
  });
});
