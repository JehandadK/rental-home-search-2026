import { describe, expect, it } from "vitest";
import { municipalityEnglish, municipalityNamesFromWorkbook, romanize, toKatakana } from "./municipalityNames";

describe("kana to English", () => {
  it("romanizes Hepburn without macrons, shortening long vowels", () => {
    expect(romanize(toKatakana("ｿｳｶ"))).toBe("soka");
    expect(romanize("オオタ")).toBe("ota");
    expect(romanize("チュウオウ")).toBe("chuo");
    expect(romanize("ハッチョウ")).toBe("hatcho");
    expect(romanize("リュウガサキ")).toBe("ryugasaki");
  });

  it("drops a city's suffix and keeps a town's or village's", () => {
    expect(municipalityEnglish("草加市", "ｿｳｶｼ")).toBe("Soka");
    expect(municipalityEnglish("足立区", "ｱﾀﾞﾁｸ")).toBe("Adachi");
    expect(municipalityEnglish("伊奈町", "ｲﾅﾏﾁ")).toBe("Ina-machi");
    expect(municipalityEnglish("東海村", "ﾄｳｶｲﾑﾗ")).toBe("Tokai-mura");
  });
});

/** A minimal workbook: shared strings (one with a furigana guide) and one sheet. */
function workbook(rows: string[][]): { strings: string; sheet: string } {
  const strings: string[] = [];
  const index = (text: string) => {
    const at = strings.indexOf(text);
    return at >= 0 ? at : strings.push(text) - 1;
  };
  const sheet = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) =>
    `<c r="${"ABCDE"[c]}${r + 1}" t="s"><v>${index(value)}</v></c>`).join("")}</row>`).join("");
  const si = strings.map((text) => text === "白岡市"
    ? `<si><t>白岡市</t><rPh sb="0" eb="3"><t>シラオカシ</t></rPh></si>`
    : `<si><t>${text}</t></si>`);
  return { strings: `<sst>${si.join("")}</sst>`, sheet: `<worksheet><sheetData>${sheet}</sheetData></worksheet>` };
}

describe("総務省 code list", () => {
  const { strings, sheet } = workbook([
    ["団体コード", "都道府県名", "市区町村名", "都道府県名カナ", "市区町村名カナ"],
    ["111007", "埼玉県", "さいたま市", "ｻｲﾀﾏｹﾝ", "ｻｲﾀﾏｼ"],
    ["111082", "埼玉県", "さいたま市南区", "ｻｲﾀﾏｹﾝ", "ｻｲﾀﾏｼﾐﾅﾐｸ"],
    ["112461", "埼玉県", "白岡市", "ｻｲﾀﾏｹﾝ", "ｼﾗｵｶｼ"],
    ["112119", "埼玉県", "本庄市", "ｻｲﾀﾏｹﾝ", "ﾎﾝｼﾞﾖｳｼ"],
    ["131016", "東京都", "千代田区", "ﾄｳｷｮｳﾄ", "ﾁﾖﾀﾞｸ"],
  ]);
  const names = municipalityNamesFromWorkbook(strings, [sheet]);

  it("names designated-city wards after their city", () => {
    expect(names.get("11108")).toMatchObject({ name: "さいたま市南区", nameEn: "Saitama Minami-ku", prefectureEn: "Saitama" });
  });

  it("ignores furigana in names, fixes known reading errata, and names prefectures", () => {
    expect(names.get("11246")?.name).toBe("白岡市");
    expect(names.get("11211")?.nameEn).toBe("Honjo");
    expect(names.get("13101")).toMatchObject({ nameEn: "Chiyoda", prefectureEn: "Tokyo" });
  });
});
