/**
 * Agency store blocks (取扱店舗 / 広告主情報) as every portal prints them:
 * a store name, an office address, a phone number and a 宅建業 licence.
 *
 * Store names mix a franchise label, the member company and a branch in any
 * order, with or without spaces:
 *   "シャーメゾンショップ　株式会社クイックホーム　北越谷店"
 *   "ハウスコム埼玉(株)草加店" · "(株)ハウスパートナー新小岩店"
 *   "ポラスの賃貸 Room'Spot春日部営業所(株)中央ビル管理"
 * The split is a heuristic; the printed name is always kept beside it.
 */
import type { ListingAgency } from "../../domain/types";

/** Chains and franchises, as matched after NFKC normalisation. */
const BRANDS: readonly { brand: string; aliases: readonly string[]; label?: true }[] = [
  // `label`: a franchise name printed before the member company, never part of it.
  { brand: "シャーメゾンショップ", aliases: ["シャーメゾンショップ"], label: true },
  { brand: "センチュリー21", aliases: ["センチュリー21", "CENTURY21"], label: true },
  { brand: "いい部屋ネット", aliases: ["いい部屋ネット"], label: true },
  { brand: "Room'Spot", aliases: ["Room'Spot", "Room’Spot", "ルームスポット"], label: true },
  { brand: "UR都市機構", aliases: ["UR都市機構", "UR賃貸"] },
  { brand: "アパマンショップ", aliases: ["アパマンショップ"] },
  { brand: "ピタットハウス", aliases: ["ピタットハウス"] },
  { brand: "エイブル", aliases: ["エイブル"] },
  { brand: "ミニミニ", aliases: ["ミニミニ"] },
  { brand: "ハウスコム", aliases: ["ハウスコム"] },
  { brand: "ハウスメイト", aliases: ["ハウスメイト"] },
  { brand: "ホームメイト", aliases: ["ホームメイト"] },
  { brand: "レオパレス21", aliases: ["レオパレス21"] },
  { brand: "ハウス・トゥ・ハウス", aliases: ["ハウス・トゥ・ハウス"] },
  { brand: "タウンハウジング", aliases: ["タウンハウジング"] },
];

const LEGAL_FORM = /株式会社|有限会社|合同会社|独立行政法人|\((?:株|有|同)\)/;
const SPELLED_OUT: Record<string, string> = { "(株)": "株式会社", "(有)": "有限会社", "(同)": "合同会社" };
const BRANCH_SUFFIX = "(?:店|営業所|支店|出張所|案内所|営業センター)";
/** A place-name run (kanji/hiragana) ending in a branch suffix, at the end of a token. */
const BRANCH_TAIL = new RegExp(`([\\p{Script=Han}\\p{Script=Hiragana}ヶ々]+${BRANCH_SUFFIX})$`, "u");
/** Business words that end a company name, not begin a branch ("三和不動産越谷店" → "越谷店"). */
const BUSINESS_WORD = /^.*(?:不動産|住宅|建物|管理|建設|商事|開発|地所|興業|産業|企画|建託)/u;

const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

function branchOf(token: string): string | null {
  const run = token.match(BRANCH_TAIL)?.[1];
  return run ? run.replace(BUSINESS_WORD, "") || null : null;
}

function brandOf(name: string): (typeof BRANDS)[number] | undefined {
  return BRANDS.find((entry) => entry.aliases.some((alias) => name.includes(alias)));
}

/**
 * "シャーメゾンショップ 株式会社山修 東川口店" → { brand: "シャーメゾンショップ", company: "株式会社山修", branch: "東川口店" }
 * "ハウスコム埼玉(株)草加店" → { brand: "ハウスコム", company: "ハウスコム埼玉株式会社", branch: "草加店" }
 */
export function splitAgencyName(printed: string): Pick<ListingAgency, "brand" | "company" | "branch"> {
  const name = normalize(printed);
  const tokens = name.split(new RegExp(`\\s+|${LEGAL_FORM.source}`)).filter(Boolean);
  const branch = tokens.map(branchOf).find(Boolean) ?? null;
  const franchise = brandOf(name);

  let company: string | null = null;
  let core: string | null = null;
  const legal = name.match(LEGAL_FORM);
  if (legal?.index != null) {
    const form = SPELLED_OUT[legal[0]] ?? legal[0];
    const before = name.slice(0, legal.index).match(/(\S+)$/)?.[1] ?? "";
    const rest = name.slice(legal.index + legal[0].length);
    const adjacentAfter = rest.match(/^([^\s(]+)/)?.[1] ?? "";
    const after = adjacentAfter || (rest.match(/^\s+([^\s(]+)/)?.[1] ?? "");
    // "三愛ホーム(株)" / "ハウスコム埼玉(株)草加店": the name precedes the legal form
    // unless a real name (not just a branch) follows it directly.
    const nameFirst = before !== "" && (!adjacentAfter || branchOf(adjacentAfter) === adjacentAfter);
    core = nameFirst ? before : after;
    if (core) {
      for (const entry of BRANDS) {
        const alias = entry.label && entry.aliases.find((a) => core!.startsWith(a) && core!.length > a.length);
        if (alias) core = core.slice(alias.length);
      }
      if (branch && core.endsWith(branch) && core.length > branch.length) core = core.slice(0, -branch.length);
      company = nameFirst ? `${core}${form}` : `${form}${core}`;
    }
  }
  // No legal form ("AnRe不動産"): the first token, less a branch printed onto it.
  const first = tokens[0] ?? null;
  const fallback = first && branch && first.endsWith(branch) && first !== branch ? first.slice(0, -branch.length) : first;
  return { brand: franchise?.brand ?? (core || fallback), company, branch };
}

const DESIGNATED_CITIES = /^(さいたま市|千葉市|横浜市|川崎市|相模原市)/;

/**
 * "〒134-0088 東京都江戸川区西葛西６丁目" → { prefecture: "東京都", city: "江戸川区" }
 * "埼玉県北葛飾郡杉戸町清地" → 杉戸町 · "埼玉県さいたま市南区…" → さいたま市
 */
export function parseMunicipality(address: string): Pick<ListingAgency, "prefecture" | "city"> {
  const text = address.normalize("NFKC").replace(/〒?\s*\d{3}-\d{4}/, "").replace(/\s+/g, "");
  const prefecture = text.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}?県)/)?.[1] ?? null;
  const rest = prefecture ? text.slice(prefecture.length) : text;
  const ward = rest.match(/^(.{1,4}?区)/)?.[1];
  const city = rest.match(/^(.{1,5}?市)/)?.[1];
  const town = rest.match(/^.{1,4}?郡(.{1,4}?[町村])/)?.[1];
  // Tokyo's 23 wards come before 市 ("新宿区市谷…" is a ward); elsewhere a 区 is a designated-city ward.
  const wardFirst = prefecture === "東京都" || (!prefecture && ward && (!city || rest.indexOf(ward) + ward.length <= rest.indexOf("市")));
  return {
    prefecture,
    city: rest.match(DESIGNATED_CITIES)?.[1] ?? town ?? (wardFirst ? ward ?? city : city ?? ward) ?? null,
  };
}

/** "国土交通大臣免許（３）第８５２２号" → "国土交通大臣(3)第8522号" */
export function parseLicence(text: string | null | undefined): string | null {
  const match = normalize(text ?? "").match(/(国土交通大臣|\S{2,4}?[都道府県]知事)(?:免許)?\s*\((\d+)\)\s*第\s*(\d+)\s*号/);
  return match ? `${match[1]}(${match[2]})第${match[3]}号` : null;
}

/** First Japanese phone number: "TEL/FAX 03-6456-0315 ／03-6456-0316" → "03-6456-0315" · "0800-1700231" */
export function parsePhone(text: string | null | undefined): string | null {
  const candidates = normalize(text ?? "").match(/0\d{1,4}-\d{1,4}-\d{3,4}|0\d{1,4}-\d{6,8}|0\d{9,10}/g) ?? [];
  return candidates.find((phone) => [10, 11].includes(phone.replace(/-/g, "").length)) ?? null;
}

/** One store block's fields → a ListingAgency; null when the page named no store. */
export function toListingAgency(parts: { name?: string | null; address?: string | null; phone?: string | null; licence?: string | null }): ListingAgency | null {
  // Collapse HTML layout whitespace only: the ideographic spaces are part of the printed name.
  const name = (parts.name ?? "").replace(/[ \t\r\n]+/g, " ").replace(/^[ 　]+|[ 　]+$/g, "");
  if (!name) return null;
  const address = parts.address ? normalize(parts.address).replace(/^〒?\s*\d{3}-\d{4}\s*/, "") || null : null;
  return {
    name,
    ...splitAgencyName(name),
    address,
    ...(address ? parseMunicipality(address) : { prefecture: null, city: null }),
    phone: parsePhone(parts.phone),
    licence: parseLicence(parts.licence),
  };
}
