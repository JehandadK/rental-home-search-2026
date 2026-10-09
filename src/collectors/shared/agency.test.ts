import { describe, expect, it } from "vitest";
import { parseLicence, parseMunicipality, parsePhone, splitAgencyName, toListingAgency } from "./agency";

describe("splitAgencyName", () => {
  // Store names as the portals printed them, 2026-09 and 2026-10.
  it.each([
    ["シャーメゾンショップ　株式会社クイックホーム　北越谷店", "シャーメゾンショップ", "株式会社クイックホーム", "北越谷店"],
    ["シャーメゾンショップ　株式会社市川不動産　鳩ヶ谷店", "シャーメゾンショップ", "株式会社市川不動産", "鳩ヶ谷店"],
    ["センチュリー21(株)丸吉住宅センター", "センチュリー21", "株式会社丸吉住宅センター", null],
    ["センチュリー21三愛ホーム 三愛ホーム(株)", "センチュリー21", "三愛ホーム株式会社", null],
    ["ハウスコム埼玉(株)草加店", "ハウスコム", "ハウスコム埼玉株式会社", "草加店"],
    ["いい部屋ネット大東建託リーシング(株)越谷店", "いい部屋ネット", "大東建託リーシング株式会社", "越谷店"],
    ["ポラスの賃貸 Room'Spot春日部営業所(株)中央ビル管理", "Room'Spot", "株式会社中央ビル管理", "春日部営業所"],
    ["(株)ハウスパートナー新小岩店", "ハウスパートナー", "株式会社ハウスパートナー", "新小岩店"],
    ["アエラス西葛西店 (株)アエラス", "アエラス", "株式会社アエラス", "西葛西店"],
    ["株式会社中央ビル管理 北千住営業所", "中央ビル管理", "株式会社中央ビル管理", "北千住営業所"],
    ["ハウス・トゥ・ハウス・ネットサービス株式会社　川口店 ハウス・トゥ・ハウス川口店", "ハウス・トゥ・ハウス", "ハウス・トゥ・ハウス・ネットサービス株式会社", "川口店"],
    ["独立行政法人都市再生機構　ＵＲ都市機構　せんげん台現地案内所", "UR都市機構", "独立行政法人都市再生機構", "せんげん台現地案内所"],
    ["株式会社三和不動産越谷店", "三和不動産", "株式会社三和不動産", "越谷店"],
    ["有限会社マルフク不動産", "マルフク不動産", "有限会社マルフク不動産", null],
    ["AnRe不動産", "AnRe不動産", null, null],
  ])("%s", (name, brand, company, branch) => {
    expect(splitAgencyName(name)).toEqual({ brand, company, branch });
  });
});

describe("parseMunicipality", () => {
  it.each([
    ["〒134-0088 東京都江戸川区西葛西６丁目８－１０", "東京都", "江戸川区"],
    ["埼玉県越谷市千間台東1-1-12", "埼玉県", "越谷市"],
    ["埼玉県北葛飾郡杉戸町清地", "埼玉県", "杉戸町"],
    ["埼玉県さいたま市南区南浦和", "埼玉県", "さいたま市"],
    // Names that contain 市/区/村 before the real suffix.
    ["東京都新宿区市谷本村町", "東京都", "新宿区"],
    ["東京都武蔵村山市本町", "東京都", "武蔵村山市"],
    ["千葉県市川市八幡", "千葉県", "市川市"],
    ["東京都町田市原町田", "東京都", "町田市"],
    // AtHome list pages drop the prefecture.
    ["草加市氷川町", null, "草加市"],
    ["葛飾区新小岩", null, "葛飾区"],
  ])("%s", (address, prefecture, city) => {
    expect(parseMunicipality(address)).toEqual({ prefecture, city });
  });
});

describe("contact fields", () => {
  it("normalises licence numbers", () => {
    expect(parseLicence("国土交通大臣免許（３）第８５２２号")).toBe("国土交通大臣(3)第8522号");
    expect(parseLicence(" 免許番号： 埼玉県知事（１３）第７２７７号 / （公社）埼玉県宅地建物取引業協会会員")).toBe("埼玉県知事(13)第7277号");
    expect(parseLicence("（公社）全日本不動産協会")).toBeNull();
  });

  it("keeps the first phone number", () => {
    expect(parsePhone("03-6456-0315 ／03-6456-0316")).toBe("03-6456-0315");
    expect(parsePhone("0800-1700231")).toBe("0800-1700231");
    expect(parsePhone("営業時間：10:00～19:00")).toBeNull();
  });
});

describe("toListingAgency", () => {
  it("drops the postcode from the address and keeps the printed name", () => {
    expect(toListingAgency({ name: " アエラス西葛西店 (株)アエラス ", address: "〒134-0088 東京都江戸川区西葛西６丁目" }))
      .toMatchObject({ name: "アエラス西葛西店 (株)アエラス", address: "東京都江戸川区西葛西6丁目", city: "江戸川区", phone: null, licence: null });
  });

  it("is null when the page names no store", () => {
    expect(toListingAgency({ name: "  ", address: "東京都足立区" })).toBeNull();
  });
});
