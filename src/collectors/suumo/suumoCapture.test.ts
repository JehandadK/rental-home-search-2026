import { describe, expect, it } from "vitest";
import { parsePage } from "./suumo";
import { assertParsedFamilies } from "../shared/captureValidation";
import type { PageCapture } from "../shared/captureStore";

const html = `<div class="cassetteitem">
  <div class="cassetteitem_content-title">Test rental</div>
  <div class="cassetteitem_detail-col1">埼玉県草加市西町</div>
  <div class="cassetteitem_detail-col2"><div class="cassetteitem_detail-text">東武伊勢崎線/草加駅 歩15分</div></div>
  <div class="cassetteitem_detail-col3"><div>築10年</div></div>
  <table class="cassetteitem_other"><tbody><tr class="js-cassette_link">
    <td></td><td></td><td>2階</td>
    <td><span class="cassetteitem_price--rent">8万円</span><span class="cassetteitem_price--administration">4000円</span></td>
    <td><span class="cassetteitem_price--deposit">8万円</span><span class="cassetteitem_price--gratuity">-</span></td>
    <td><span class="cassetteitem_madori">3LDK</span><span class="cassetteitem_menseki">70m2</span></td>
    <td><a href="/chintai/jnc_123/?bc=123456">detail</a></td>
  </tr></tbody></table>
</div>`;
const capture: PageCapture = {
  schemaVersion: 1, source: "suumo", city: "Soka",
  url: "https://suumo.jp/chintai/saitama/sc_soka/?po1=09", page: 1,
  capturedAt: "2026-09-24T05:00:00.000Z", httpStatus: 200, html,
};

describe("native SUUMO captures", () => {
  it("reuses the list parser without starting the CLI collector", () => {
    const rows = parsePage(html, 2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Test rental", rent: 84000, layout: "3LDK", sizeM2: 70,
      builtYear: 2016, depositYen: 80000, keyMoneyYen: 0,
      building: { floor: "2階" }, stationWalkMin: 15,
    });
    expect(() => assertParsedFamilies(capture, rows)).not.toThrow();
  });
  it("rejects a silent parsing failure when SUUMO family units are present", () => {
    expect(() => assertParsedFamilies(capture, [])).toThrow("Family units were present but none parsed");
  });
});
