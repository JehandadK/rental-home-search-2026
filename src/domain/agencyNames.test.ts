import { describe, expect, it } from "vitest";
import { agencyIdentity, agencyPlace, buildAgencyGazetteer, cityOfAddress, englishBrandName, englishCompanyName, romanizeKana } from "./agencyNames";
import type { ReferenceCity } from "./referenceData";

const city = (id: string, name: string, nameLocal: string, prefecture: string): ReferenceCity => ({ id, name, nameLocal, prefecture });
const koshigaya = city("city:koshigaya", "Koshigaya", "越谷市", "埼玉県");
const soka = city("city:soka", "Soka", "草加市", "埼玉県");
const yashio = city("city:yashio", "Yashio", "八潮市", "埼玉県");
const urawa = city("city:urawa", "Saitama Urawa-ku", "さいたま市浦和区", "埼玉県");
const adachi = city("city:adachi", "Adachi", "足立区", "東京都");
const nakanoTokyo = city("city:nakano", "Nakano", "中野区", "東京都");
const nakanoNagano = city("city:nakano-nagano", "Nakano", "中野市", "長野県");
const gazetteer = buildAgencyGazetteer([koshigaya, soka, yashio, urawa, adachi, nakanoTokyo, nakanoNagano], [
  { name: "北越谷", cityId: "city:koshigaya" }, { name: "せんげん台", cityId: "city:koshigaya" },
  { name: "竹ノ塚", cityId: "city:adachi" }, { name: "北千住", cityId: "city:adachi" }, { name: "草加", cityId: "city:soka" },
]);

describe("romanizeKana", () => {
  it.each([["マルフク", "marufuku"], ["ルーミーズ", "rumizu"], ["シャッチョ", "shatcho"], ["クイック", "kuikku"], ["せんげん", "sengen"], ["タンイ", "tan'i"]])(
    "%s → %s", (kana, romaji) => expect(romanizeKana(kana)).toBe(romaji));
});

describe("English agency names", () => {
  it.each([
    ["株式会社クイックホーム", "Quick Home Co., Ltd."],
    ["株式会社セイコービル管理", "Seiko Building Management Co., Ltd."],
    ["ハウスコム埼玉株式会社", "Housecom Saitama Co., Ltd."],
    ["有限会社マルフク不動産", "Marufuku Real Estate Ltd."],
    ["株式会社丸吉住宅センター", "Maruyoshi Housing Center Co., Ltd."],
    ["Apaman Leasing株式会社", "Apaman Leasing Co., Ltd."],
    ["独立行政法人都市再生機構", "Urban Renaissance Agency"],
    // A kanji name with no known reading is not guessed.
    ["株式会社博進", null],
  ])("%s → %s", (company, english) => expect(englishCompanyName(company)).toBe(english));

  it("uses a chain's official English name", () => {
    expect(englishBrandName("シャーメゾンショップ")).toBe("Sha Maison Shop");
    expect(englishBrandName("センチュリー21")).toBe("CENTURY 21");
  });
});

describe("agencyPlace", () => {
  it.each([
    ["北越谷店", "北越谷", koshigaya],
    ["埼玉八潮店", "八潮", yashio],
    ["草加駅前店", "草加", soka],
    ["竹の塚店", "竹の塚", adachi],
    ["せんげん台現地案内所", "せんげん台", koshigaya],
    ["浦和店", "浦和", urawa],
    ["北千住東口店", "北千住", adachi],
  ])("%s → %s", (branch, name, expected) => expect(agencyPlace(branch, gazetteer)).toEqual({ name, city: expected }));

  it("leaves unknown or ambiguous places without a city", () => {
    expect(agencyPlace("住宅運営部", gazetteer)).toEqual({ name: "住宅運営部", city: null });
    expect(agencyPlace("中野店", gazetteer)).toEqual({ name: "中野", city: null });
    // The office's prefecture settles it.
    expect(agencyPlace("中野店", gazetteer, adachi)).toEqual({ name: "中野", city: nakanoTokyo });
    expect(agencyPlace(null, gazetteer)).toBeNull();
  });
});

describe("cityOfAddress", () => {
  it("finds the most specific city, wards included", () => {
    expect(cityOfAddress("埼玉県さいたま市浦和区高砂1-1", gazetteer)).toBe(urawa);
    expect(cityOfAddress("埼玉県越谷市千間台東1-1-12", gazetteer)).toBe(koshigaya);
    expect(cityOfAddress("東京都練馬区", gazetteer)).toBeNull();
  });
});

describe("agencyIdentity", () => {
  it("groups one company's stores, whatever their branch", () => {
    const store = (name: string, branch: string | null, address: string | null) =>
      agencyIdentity({ name, brand: "シャーメゾンショップ", company: "株式会社ベストハウジング", branch, address }, gazetteer);
    const branchStore = store("シャーメゾンショップ　株式会社ベストハウジング　草加店", "草加店", null);
    const headOffice = store("シャーメゾンショップ　株式会社ベストハウジング", null, "埼玉県草加市栄町3丁目4-6");
    expect(branchStore).toMatchObject({ groupKey: "ベストハウジング", agency: "ベストハウジング", agencyEn: "Best Housing Co., Ltd.",
      brand: "シャーメゾンショップ", brandEn: "Sha Maison Shop", place: { name: "草加", city: soka }, city: soka });
    expect(headOffice).toMatchObject({ groupKey: branchStore.groupKey, place: null, city: soka });
  });

  it("treats an agency named after itself as independent", () => {
    expect(agencyIdentity({ name: "有限会社マルフク不動産", brand: "マルフク不動産", company: "有限会社マルフク不動産", branch: null }, gazetteer))
      .toMatchObject({ brand: null, agency: "マルフク不動産", agencyEn: "Marufuku Real Estate Ltd." });
  });
});
