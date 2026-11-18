/**
 * How a reference place reads in the map's name language: its name, the
 * short name the map labels it with, the tags worth showing beside that
 * label, and the lines of its details card.
 *
 * Records carry Japanese names; `nameEn` and `addressEn` are the English
 * forms where one is known. A place without one keeps its own name in both
 * languages rather than a guessed reading.
 */
import type { NameLanguage } from "./mapAreas";
import type { CatalogPlace } from "./places";

const text = (place: CatalogPlace, key: string): string | undefined => {
  const value = place.attributes?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};
const flag = (place: CatalogPlace, key: string): boolean | undefined => {
  const value = place.attributes?.[key];
  return typeof value === "boolean" ? value : undefined;
};

/** The place's full name in the chosen language. */
export function placeName(place: CatalogPlace, language: NameLanguage): string {
  return language === "en" ? text(place, "nameEn") ?? place.name : place.name;
}

/** Operators the Japanese label leaves out: "越谷市立蒲生小学校" → "蒲生小学校", "認定こども園小牧" → "小牧". */
const OPERATOR_PREFIX = /^(?:.+?[市区町村]立|[市区町村]立|私立|(?:幼保連携型)?認定こども園)/u;

/** The name the map labels the place with: without its operator, and "Gamo Elementary" for a school in English. */
export function placeLabel(place: CatalogPlace, language: NameLanguage): string {
  const english = language === "en" ? text(place, "nameEn") : undefined;
  if (english) return english.replace(/ Elementary School$/, " Elementary");
  return place.name.replace(OPERATOR_PREFIX, "") || place.name;
}

export interface PlaceTag {
  key: "japanese" | "resourceRoom";
  text: string;
}

/** What sets a school apart at a glance: a Japanese-language class, a resource room (通級). */
export function placeTags(place: CatalogPlace, language: NameLanguage): PlaceTag[] {
  const tags: PlaceTag[] = [];
  if (flag(place, "japaneseLanguageClass")) tags.push({ key: "japanese", text: language === "en" ? "Japanese class" : "日本語教室" });
  if (text(place, "resourceRoom")) tags.push({ key: "resourceRoom", text: language === "en" ? "Resource room" : "通級" });
  return tags;
}

/** English for the kinds of special-support class and resource room the records name. */
const SUPPORT_KINDS_EN: Record<string, string> = {
  知的障害: "intellectual",
  "自閉症・情緒障害": "autism / emotional",
  肢体不自由: "physical",
  難聴: "hearing",
  弱視: "low vision",
  言語障害: "speech",
  "病弱・身体虚弱": "health impairment",
  "病弱・身体虚弱（院内学級）": "health impairment (hospital class)",
  "難聴・言語障害": "hearing / speech",
  "発達障害・情緒障害": "developmental / emotional",
};

/** "知的障害、自閉症・情緒障害" → "intellectual, autism / emotional"; unknown kinds stay as written. */
function supportKinds(kinds: string, language: NameLanguage): string {
  const list = kinds.split("、");
  return language === "en" ? list.map((kind) => SUPPORT_KINDS_EN[kind] ?? kind).join(", ") : list.join("、");
}

const KIND: Record<string, { en: string; ja: string }> = {
  school: { en: "Public elementary school", ja: "公立小学校" },
  kindergarten: { en: "Kindergarten (幼稚園)", ja: "幼稚園" },
  kodomoen: { en: "Certified kodomoen (認定こども園)", ja: "認定こども園" },
  hoikuen: { en: "Nursery (保育園)", ja: "保育園・保育所" },
  shop: { en: "Shop", ja: "店舗" },
};

export interface PlaceDetails {
  title: string;
  /** The name in the other language, when it differs. */
  otherName?: string;
  /** What kind of place it is. */
  kind?: string;
  lines: string[];
  website?: string;
}

/** The details card of a school, childcare facility or shop, in the chosen language. */
export function placeDetails(place: CatalogPlace, language: NameLanguage): PlaceDetails {
  const en = language === "en";
  const title = placeName(place, language);
  const other = placeName(place, en ? "ja" : "en");
  const kind = KIND[place.category === "childcare" ? text(place, "facilityType") ?? "kindergarten" : place.category];
  const lines: string[] = [];

  const address = (en ? text(place, "addressEn") : undefined) ?? place.address;
  if (address) lines.push(address);
  const phone = text(place, "phone");
  if (phone) lines.push(en ? `Tel ${phone}` : `電話 ${phone}`);
  const pupils = place.attributes?.pupils;
  if (typeof pupils === "number") {
    const year = text(place, "pupilsYear");
    lines.push(en ? `${pupils} pupils${year ? ` (${year})` : ""}` : `児童数 ${pupils}人${year ? `（${year}年度）` : ""}`);
  }

  const note = text(place, en ? "noteEn" : "note");
  if (note) lines.push(note);

  const japanese = flag(place, "japaneseLanguageClass");
  const japaneseNote = text(place, en ? "japaneseSupportEn" : "japaneseSupport");
  if (japanese) lines.push(en ? "Japanese-language class for foreign pupils" : "日本語指導教室あり");
  if (japaneseNote) lines.push(japaneseNote);

  const support = flag(place, "specialSupportClass");
  const kinds = text(place, "specialSupportKinds");
  if (support) {
    const label = en ? "Special-support classes" : "特別支援学級";
    lines.push(kinds ? `${label}: ${supportKinds(kinds, language)}` : label);
  } else if (support === false) {
    lines.push(en ? "No special-support class" : "特別支援学級なし");
  }
  const room = text(place, "resourceRoom");
  if (room) lines.push(`${en ? "Resource room (通級)" : "通級指導教室"}: ${supportKinds(room, language)}`);

  return {
    title,
    ...(other !== title ? { otherName: other } : {}),
    ...(kind ? { kind: en ? kind.en : kind.ja } : {}),
    lines,
    ...(text(place, "website") ? { website: text(place, "website") } : {}),
  };
}
