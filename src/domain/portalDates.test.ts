import { describe, expect, it } from "vitest";
import { parsePortalListingDates, portalListingDatesFrom } from "./portalDates";

describe("portal listing dates", () => {
  it("reads Nifty-style free text without mistaking 次回更新日 for 更新日", () => {
    expect(parsePortalListingDates("不動産会社情報を見る情報公開日：2026/08/29 次回更新日：2026/09/06バス・トイレ別")).toEqual({
      publishedOn: "2026-08-29", nextUpdateOn: "2026-09-06",
    });
  });

  it("reads Japanese-format dates packed into one value (Yahoo)", () => {
    expect(parsePortalListingDates("＜お問い合わせ先をご参照ください＞情報公開日：2026年7月17日　情報更新日：2026年9月9日　次回更新予定日：随時")).toEqual({
      publishedOn: "2026-07-17", updatedOn: "2026-09-09",
    });
  });

  it("reads detail-table rows", () => {
    expect(portalListingDatesFrom({ 情報更新日: "2026/9/28", 次回更新日: "2026/10/12", 賃料: "8.5万円" })).toEqual({ updatedOn: "2026-09-28", nextUpdateOn: "2026-10-12" });
    expect(portalListingDatesFrom(undefined, null)).toEqual({});
  });
});
