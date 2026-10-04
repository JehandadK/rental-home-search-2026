/**
 * English municipality names from the 総務省 全国地方公共団体コード list
 * (https://www.soumu.go.jp/denshijiti/code.html, an .xlsx workbook).
 *
 * The list gives every municipality its official reading in half-width kana
 * (草加市 ｿｳｶｼ, さいたま市南区 ｻｲﾀﾏｼﾐﾅﾐｸ). Readings are converted to
 * Hepburn without macrons, the way municipalities spell themselves in English
 * (Soka, Ota, Chuo, Ome): long vowels written ou, oo and uu are shortened.
 * Names follow the catalog's existing style:
 *   - cities and Tokyo's special wards: the name alone (Soka, Adachi);
 *   - towns and villages: with their suffix (Ina-machi, Tokai-mura);
 *   - designated-city wards: the city then the ward (Saitama Minami-ku);
 *   - prefectures: the name alone (Saitama, Tokyo).
 *
 * Pure: the caller extracts the workbook's XML parts.
 */

export interface MunicipalityName {
  /** 5-digit code (the list's 6-digit code without its check digit). */
  code: string;
  prefecture: string;
  /** Local name, as the list writes it (さいたま市南区). */
  name: string;
  nameEn: string;
  prefectureEn: string;
}

interface Row {
  code: string;
  prefecture: string;
  name: string;
  prefectureKana: string;
  nameKana: string;
}

/**
 * Read the workbook's sheets (the main list and the designated-city wards) and
 * return one entry per municipality and ward, keyed by 5-digit code.
 */
export function municipalityNamesFromWorkbook(sharedStringsXml: string, sheetXmls: readonly string[]): Map<string, MunicipalityName> {
  // Phonetic guides (<rPh>, furigana some cells carry) are not part of the text.
  const strings = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(([, inner]) => [...inner.replace(/<rPh[\s\S]*?<\/rPh>/g, "").matchAll(/<t[^>]*>([^<]*)<\/t>/g)]
      .map(([, text]) => decodeXml(text)).join(""));
  const rows: Row[] = [];
  for (const sheet of sheetXmls) {
    for (const [, inner] of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...inner.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, column, attributes, body]) => {
        const value = body?.match(/<v>([^<]*)<\/v>/)?.[1] ?? body?.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "";
        return [column, /t="s"/.test(attributes) && value ? strings[Number(value)] : decodeXml(value)] as const;
      });
      const at = (column: string) => cells.find(([c]) => c === column)?.[1]?.trim() ?? "";
      const code = at("A");
      if (!/^\d{6}$/.test(code)) continue;
      const nameKana = READING_ERRATA[code.slice(0, 5)] ?? at("E");
      rows.push({ code, prefecture: at("B"), name: at("C"), prefectureKana: at("D"), nameKana });
    }
  }

  const byCode = new Map(rows.map((row) => [row.code.slice(0, 5), row]));
  const names = new Map<string, MunicipalityName>();
  for (const [code, row] of byCode) {
    if (!row.name || !row.nameKana) continue;
    const prefectureEn = prefectureEnglish(row.prefecture, row.prefectureKana);
    let nameEn: string;
    const ward = row.name.match(/^(.+市)(.+区)$/u);
    // A designated-city ward: find its city's reading and take the rest as the ward's.
    const city = ward ? rows.find((other) => other.prefecture === row.prefecture && other.name === ward[1]) : undefined;
    if (ward && city && toKatakana(row.nameKana).startsWith(toKatakana(city.nameKana))) {
      const cityEn = municipalityEnglish(city.name, city.nameKana);
      const wardEn = municipalityEnglish(ward[2], toKatakana(row.nameKana).slice(toKatakana(city.nameKana).length), "ward");
      nameEn = `${cityEn} ${wardEn}`;
    } else {
      nameEn = municipalityEnglish(row.name, row.nameKana);
    }
    names.set(code, { code, prefecture: row.prefecture, name: row.name, nameEn: ENGLISH_OVERRIDES[code] ?? nameEn, prefectureEn });
  }
  return names;
}

/**
 * Readings the list writes with full-size kana where the name has a small one
 * (ｼﾞﾖｳ for ジョウ), checked against each municipality's own spelling.
 */
const READING_ERRATA: Record<string, string> = {
  "10421": "ナカノジョウマチ", // 中之条町 Nakanojo
  "11206": "ギョウダシ", // 行田市 Gyoda
  "11211": "ホンジョウシ", // 本庄市 Honjo
  "11216": "ハニュウシ", // 羽生市 Hanyu
  "12403": "クジュウクリマチ", // 九十九里町 Kujukuri
  "12443": "オンジュクマチ", // 御宿町 Onjuku
  "12463": "キョナンマチ", // 鋸南町 Kyonan
};

/** Official spellings the rules above do not produce. */
const ENGLISH_OVERRIDES: Record<string, string> = {
  "12218": "Katsuura", // 勝浦市: カツ + ウラ, two words, so the uu stays
  "12237": "Sammu", // 山武市 spells itself Sammu
};

const SUFFIXES: Record<string, { kana: string[]; english: Record<string, string> }> = {
  市: { kana: ["シ"], english: { シ: "" } },
  区: { kana: ["ク"], english: { ク: "" } },
  町: { kana: ["マチ", "チョウ"], english: { マチ: "-machi", チョウ: "-cho" } },
  村: { kana: ["ムラ", "ソン"], english: { ムラ: "-mura", ソン: "-son" } },
};

/** English for one municipality: the reading without its 市/区/町/村 suffix, plus the suffix's English. */
export function municipalityEnglish(name: string, kana: string, role: "municipality" | "ward" = "municipality"): string {
  const reading = toKatakana(kana);
  const suffix = SUFFIXES[name.slice(-1)];
  const spoken = suffix?.kana.find((ending) => reading.endsWith(ending) && reading.length > ending.length);
  const stem = spoken ? reading.slice(0, -spoken.length) : reading;
  // A ward keeps "-ku" (Minami-ku); a city or Tokyo special ward drops its suffix.
  const english = spoken ? (role === "ward" && spoken === "ク" ? "-ku" : suffix.english[spoken]) : "";
  return `${capitalize(romanize(stem))}${english}`;
}

function prefectureEnglish(prefecture: string, kana: string): string {
  const reading = toKatakana(kana);
  const ending = prefecture.endsWith("都") ? "ト" : prefecture.endsWith("府") ? "フ" : prefecture.endsWith("県") ? "ケン" : "";
  const stem = ending && reading.endsWith(ending) ? reading.slice(0, -ending.length) : reading;
  return capitalize(romanize(stem));
}

/** Half-width kana to full-width katakana (ｿｳｶｼ → ソウカシ). */
export function toKatakana(kana: string): string {
  return kana.normalize("NFKC").replace(/[ぁ-ゖ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

const DIGRAPHS: Record<string, string> = {
  キャ: "kya", キュ: "kyu", キョ: "kyo", ギャ: "gya", ギュ: "gyu", ギョ: "gyo",
  シャ: "sha", シュ: "shu", ショ: "sho", ジャ: "ja", ジュ: "ju", ジョ: "jo",
  チャ: "cha", チュ: "chu", チョ: "cho", ヂャ: "ja", ヂュ: "ju", ヂョ: "jo",
  ニャ: "nya", ニュ: "nyu", ニョ: "nyo", ヒャ: "hya", ヒュ: "hyu", ヒョ: "hyo",
  ビャ: "bya", ビュ: "byu", ビョ: "byo", ピャ: "pya", ピュ: "pyu", ピョ: "pyo",
  ミャ: "mya", ミュ: "myu", ミョ: "myo", リャ: "rya", リュ: "ryu", リョ: "ryo",
};

const MONOGRAPHS: Record<string, string> = {
  ア: "a", イ: "i", ウ: "u", エ: "e", オ: "o",
  カ: "ka", キ: "ki", ク: "ku", ケ: "ke", コ: "ko", ガ: "ga", ギ: "gi", グ: "gu", ゲ: "ge", ゴ: "go",
  サ: "sa", シ: "shi", ス: "su", セ: "se", ソ: "so", ザ: "za", ジ: "ji", ズ: "zu", ゼ: "ze", ゾ: "zo",
  タ: "ta", チ: "chi", ツ: "tsu", テ: "te", ト: "to", ダ: "da", ヂ: "ji", ヅ: "zu", デ: "de", ド: "do",
  ナ: "na", ニ: "ni", ヌ: "nu", ネ: "ne", ノ: "no",
  ハ: "ha", ヒ: "hi", フ: "fu", ヘ: "he", ホ: "ho", バ: "ba", ビ: "bi", ブ: "bu", ベ: "be", ボ: "bo",
  パ: "pa", ピ: "pi", プ: "pu", ペ: "pe", ポ: "po",
  マ: "ma", ミ: "mi", ム: "mu", メ: "me", モ: "mo", ヤ: "ya", ユ: "yu", ヨ: "yo",
  ラ: "ra", リ: "ri", ル: "ru", レ: "re", ロ: "ro", ワ: "wa", ヰ: "i", ヱ: "e", ヲ: "o", ン: "n", ヴ: "vu",
  ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o", ャ: "ya", ュ: "yu", ョ: "yo",
};

/** Katakana to Hepburn without macrons: long ou, oo and uu are written o and u. */
export function romanize(katakana: string): string {
  let out = "";
  let double = false;
  for (let i = 0; i < katakana.length; i++) {
    const pair = katakana.slice(i, i + 2);
    let syllable = DIGRAPHS[pair];
    if (syllable) i++;
    else if (katakana[i] === "ッ") {
      double = true;
      continue;
    } else if (katakana[i] === "ー") {
      continue;
    } else {
      syllable = MONOGRAPHS[katakana[i]] ?? katakana[i];
    }
    if (double) {
      out += syllable.startsWith("ch") ? "t" : syllable[0];
      double = false;
    }
    out += syllable;
  }
  return out.replace(/ou/g, "o").replace(/oo/g, "o").replace(/uu/g, "u");
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}
