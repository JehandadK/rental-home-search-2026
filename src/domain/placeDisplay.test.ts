import { describe, expect, it } from "vitest";
import type { CatalogPlace } from "./places";
import { placeDetails, placeLabel, placeName, placeTags } from "./placeDisplay";

const place = (over: Partial<CatalogPlace>): CatalogPlace => ({
  id: "school:x", recordId: "school:x", category: "school", name: "越谷市立蒲生小学校", lat: 35.87, lon: 139.8, ...over,
});

const gamo = place({
  address: "埼玉県越谷市登戸町33-17",
  attributes: {
    nameEn: "Gamo Elementary School", phone: "048-986-3711", website: "https://example.jp/gamo",
    specialSupportClass: true, specialSupportKinds: "知的障害、自閉症・情緒障害", resourceRoom: "難聴・言語障害",
    japaneseLanguageClass: true, japaneseSupport: "日本語指導員が巡回", japaneseSupportEn: "Japanese-language instructors visit",
    pupils: 512, pupilsYear: "2025", note: "令和8年9月から新校舎", noteEn: "In a new building since September 2026",
  },
});

describe("place names", () => {
  it("reads in the chosen language, and keeps its own name where no English one is known", () => {
    expect(placeName(gamo, "en")).toBe("Gamo Elementary School");
    expect(placeName(gamo, "ja")).toBe("越谷市立蒲生小学校");
    const unnamed = place({ name: "深田保育所", category: "childcare" });
    expect(placeName(unnamed, "en")).toBe("深田保育所");
    expect(placeName(place({ category: "shop", name: "Super19" }), "ja")).toBe("Super19");
  });

  it("labels the map without the operator", () => {
    expect(placeLabel(gamo, "ja")).toBe("蒲生小学校");
    expect(placeLabel(gamo, "en")).toBe("Gamo Elementary");
    expect(placeLabel(place({ name: "市立大沢小学校" }), "ja")).toBe("大沢小学校");
    expect(placeLabel(place({ name: "認定こども園わかばの森ナーサリー", category: "childcare" }), "ja")).toBe("わかばの森ナーサリー");
    expect(placeLabel(place({ name: "草加ひので幼稚園", category: "childcare", attributes: { nameEn: "Soka Hinode Kindergarten" } }), "en")).toBe("Soka Hinode Kindergarten");
    expect(placeLabel(place({ name: "草加ひので幼稚園", category: "childcare" }), "ja")).toBe("草加ひので幼稚園");
  });

  it("tags a Japanese-language class and a resource room", () => {
    expect(placeTags(gamo, "en").map((tag) => tag.text)).toEqual(["Japanese class", "Resource room"]);
    expect(placeTags(gamo, "ja").map((tag) => tag.text)).toEqual(["日本語教室", "通級"]);
    expect(placeTags(place({}), "en")).toEqual([]);
  });
});

describe("placeDetails", () => {
  it("describes a school in English", () => {
    expect(placeDetails(gamo, "en")).toEqual({
      title: "Gamo Elementary School",
      otherName: "越谷市立蒲生小学校",
      kind: "Public elementary school",
      lines: [
        "埼玉県越谷市登戸町33-17",
        "Tel 048-986-3711",
        "512 pupils (2025)",
        "In a new building since September 2026",
        "Japanese-language class for foreign pupils",
        "Japanese-language instructors visit",
        "Special-support classes: intellectual, autism / emotional",
        "Resource room (通級): hearing / speech",
      ],
      website: "https://example.jp/gamo",
    });
  });

  it("describes it in Japanese", () => {
    const details = placeDetails(gamo, "ja");
    expect(details.title).toBe("越谷市立蒲生小学校");
    expect(details.otherName).toBe("Gamo Elementary School");
    expect(details.kind).toBe("公立小学校");
    expect(details.lines).toEqual([
      "埼玉県越谷市登戸町33-17", "電話 048-986-3711", "児童数 512人（2025年度）", "令和8年9月から新校舎", "日本語指導教室あり", "日本語指導員が巡回",
      "特別支援学級: 知的障害、自閉症・情緒障害", "通級指導教室: 難聴・言語障害",
    ]);
  });

  it("uses the English address when there is one, and names the childcare type", () => {
    const shop = place({ category: "shop", name: "Super19", address: "埼玉県越谷市大間野町3-56-1", attributes: { addressEn: "3-56-1 Omanocho, Koshigaya, Saitama" } });
    expect(placeDetails(shop, "en")).toEqual({ title: "Super19", kind: "Shop", lines: ["3-56-1 Omanocho, Koshigaya, Saitama"] });
    expect(placeDetails(shop, "ja").lines).toEqual(["埼玉県越谷市大間野町3-56-1"]);
    const nursery = place({ category: "childcare", name: "しんぜん保育園", attributes: { facilityType: "hoikuen", nameEn: "Shinzen Nursery" } });
    expect(placeDetails(nursery, "en")).toMatchObject({ title: "Shinzen Nursery", otherName: "しんぜん保育園", kind: "Nursery (保育園)" });
    expect(placeDetails(place({ attributes: { specialSupportClass: false } }), "ja").lines).toEqual(["特別支援学級なし"]);
  });
});
