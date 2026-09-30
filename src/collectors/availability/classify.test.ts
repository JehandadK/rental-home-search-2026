import { describe, expect, it } from "vitest";
import { classifyAdVisit, type AdVisit } from "./classify";

const visit = (over: Partial<AdVisit>): AdVisit => ({ requestedUrl: "", finalUrl: "", httpStatus: 200, title: "", text: "", ...over });

describe("classifyAdVisit (pages observed in the headed browser)", () => {
  it("AtHome: the 404 not-found page is gone", () => {
    const url = "https://www.athome.co.jp/chintai/1143327034/";
    expect(classifyAdVisit("athome", visit({ requestedUrl: url, finalUrl: url, httpStatus: 404,
      title: "お探しのページが見つかりません【アットホーム】｜不動産・物件・住宅情報" })).state).toBe("gone");
    // Without a status (Chrome bridge) the title alone is enough.
    expect(classifyAdVisit("athome", visit({ requestedUrl: url, finalUrl: url, httpStatus: null,
      title: "お探しのページが見つかりません【アットホーム】｜不動産・物件・住宅情報" })).state).toBe("gone");
  });

  it("AtHome: a normal ad page is listed", () => {
    const url = "https://www.athome.co.jp/chintai/1136467029/";
    expect(classifyAdVisit("athome", visit({ requestedUrl: url, finalUrl: url, title: "【アットホーム】アプリコットガーデンＣ １０２ １LDK", text: "お申込" })).state).toBe("listed");
  });

  it("SUUMO: 404 error page and redirect to the building page are gone; a live ad is listed", () => {
    const ad = "https://suumo.jp/chintai/jnc_000109447203/?bc=100524080638";
    expect(classifyAdVisit("suumo", visit({ requestedUrl: ad, finalUrl: ad, httpStatus: 404, title: "エラー｜SUUMO(スーモ)" })).state).toBe("gone");
    const moved = classifyAdVisit("suumo", visit({ requestedUrl: "https://suumo.jp/chintai/jnc_000108925491/?bc=1",
      finalUrl: "https://suumo.jp/library/tf_11/sc_11221/to_1001947450/?bs=040", title: "純ハイム/埼玉県草加市の物件情報【SUUMO】" }));
    expect(moved).toMatchObject({ state: "gone" });
    expect(moved.evidence).toContain("/library/");
    const live = "https://suumo.jp/chintai/jnc_000109828511/?bc=100526940814";
    // 成約 appears in live-page boilerplate and must not matter.
    expect(classifyAdVisit("suumo", visit({ requestedUrl: live, finalUrl: live, title: "【SUUMO】川口市差間戸建Ａ棟", text: "成約" })).state).toBe("listed");
  });

  it("RoomSpot: 404 and 掲載終了 are gone; a live ad is listed", () => {
    const ad = "https://www.roomspot.net/rent/1139288674810000004421";
    expect(classifyAdVisit("roomspot", visit({ requestedUrl: ad, finalUrl: `${ad}/`, httpStatus: 404, title: "パレスハイツ 203", text: "掲載終了 お申込" })).state).toBe("gone");
    expect(classifyAdVisit("roomspot", visit({ requestedUrl: ad, finalUrl: `${ad}/`, httpStatus: 200, title: "パレスハイツ 203", text: "掲載終了" })).state).toBe("gone");
    const live = "https://www.roomspot.net/rent/1139288674810000332294";
    expect(classifyAdVisit("roomspot", visit({ requestedUrl: live, finalUrl: `${live}/`, title: "ロイジェント 307", text: "お申込" })).state).toBe("listed");
  });

  it("Nifty: redirect to the building page is gone; the ad page (even 'no other rooms') is listed", () => {
    const gone = classifyAdVisit("nifty", visit({
      requestedUrl: "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_5f1067aba61e3f17880744642341514d/",
      finalUrl: "https://myhome.nifty.com/mansion-info/saitama/sokashi_ct/mansion_18468e53b6b63b6fbe13652b14932369/",
      title: "マイコープの詳細情報／埼玉県草加市の建物情報【ニフティ不動産】" }));
    expect(gone.state).toBe("gone");
    const ad = "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_63aeb294ac273e7a9de8fb8879eba592/";
    expect(classifyAdVisit("nifty", visit({ requestedUrl: ad, finalUrl: ad, title: "ＧＲＡＮＶＥＲＩＥ 00105", text: "ほかの部屋は見つかりませんでした" })).state).toBe("listed");
  });

  it("never calls blocked, busy, erroring or unrecognised pages gone", () => {
    const ad = "https://www.athome.co.jp/chintai/1136467029/";
    expect(classifyAdVisit("athome", visit({ requestedUrl: ad, finalUrl: ad, title: "認証にご協力ください。" })).state).toBe("unknown");
    expect(classifyAdVisit("nifty", visit({ requestedUrl: ad, finalUrl: ad, title: "", text: "ただいま込み合っております。少々お待ちください" })).state).toBe("unknown");
    expect(classifyAdVisit("suumo", visit({ requestedUrl: ad, finalUrl: ad, httpStatus: 503, title: "Service Unavailable" })).state).toBe("unknown");
    expect(classifyAdVisit("suumo", visit({ requestedUrl: ad, finalUrl: ad, title: "" })).state).toBe("unknown");
    // A redirect to a different site is not evidence.
    expect(classifyAdVisit("nifty", visit({ requestedUrl: "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_ab/", finalUrl: "https://example.com/login", title: "Login" })).state).toBe("unknown");
  });
});
