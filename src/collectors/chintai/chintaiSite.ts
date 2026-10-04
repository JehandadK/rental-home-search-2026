/**
 * CHINTAI (www.chintai.net) site map as code: path grammar, code tables and
 * URL builders, so a collector never hand-writes a portal path. Every pattern
 * here was observed in the headed browser on 2026-10-04; SITE_MAP.md beside
 * this file explains each one and the extraction plan.
 *
 * Only the static SEO paths are built here. The dynamic /list/?… search form
 * URLs are what robots.txt partly disallows (/list/?g=, /list/?b=, …), so they
 * are deliberately left out.
 */

export const CHINTAI_ORIGIN = "https://www.chintai.net";

/** Prefecture path slugs. Note the site's own romanisation: ibaragi, simane, sizuoka, kouchi, ooita. */
export const CHINTAI_PREFECTURES = [
  "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima",
  "ibaragi", "tochigi", "gunma", "saitama", "chiba", "tokyo", "kanagawa",
  "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano", "gifu", "sizuoka", "aichi",
  "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama",
  "tottori", "simane", "okayama", "hiroshima", "yamaguchi",
  "tokushima", "kagawa", "ehime", "kouchi",
  "fukuoka", "saga", "nagasaki", "kumamoto", "ooita", "miyazaki", "kagoshima", "okinawa",
] as const;
export type ChintaiPrefecture = (typeof CHINTAI_PREFECTURES)[number];

/** City codes are JIS municipality codes (5 digits); towns add 3 digits (see chintaiTowns.ts). */
export const CHINTAI_CITIES = {
  Soka: "11221",
  Koshigaya: "11222",
  Kawaguchi: "11203",
} as const;

/** Line codes (6 digits) serving the target cities, as in /saitama/en-{code}/ and /saitama/ensen/{code}/list/. */
export const CHINTAI_LINES = {
  "102082": "東武伊勢崎線・スカイツリーライン",
  "101016": "武蔵野線",
  "101015": "京浜東北線・根岸線",
  "102171": "埼玉高速鉄道",
  "102160": "つくばエクスプレス",
} as const;

/**
 * Station codes (9 digits) near the target cities. A station keeps one code on
 * every line (東川口 is 000000261 on both 武蔵野線 and 埼玉高速鉄道).
 */
export const CHINTAI_STATIONS = {
  "000004644": "谷塚", "000004645": "草加", "000004646": "獨協大学前", "000004647": "新田",
  "000004648": "蒲生", "000004649": "新越谷", "000004650": "越谷", "000004651": "北越谷",
  "000004652": "大袋", "000004653": "せんげん台",
  "000000261": "東川口", "000000262": "南越谷", "000014936": "越谷レイクタウン",
  "000000393": "川口", "000000394": "西川口", "000000395": "蕨",
  "000010496": "川口元郷", "000010497": "南鳩ケ谷", "000010498": "鳩ヶ谷", "000010499": "新井宿", "000010500": "戸塚安行",
} as const;

/** Layout slugs, usable after /list/ and /rent/. The site groups 2K with 2DK, 3K with 3DK, and so on. */
export const CHINTAI_LAYOUT_SLUGS = {
  "1r": "1R/ワンルーム", "1k": "1K", "1dk": "1DK", "1ldk": "1LDK",
  "2k": "2K/2DK", "2ldk": "2LDK", "3k": "3K/3DK", "3ldk": "3LDK",
  "4k": "4K/4DK", "4ldk": "4LDK", "5k": "5K/5DK", "5ldk": "5LDK以上",
} as const;
export type ChintaiLayoutSlug = keyof typeof CHINTAI_LAYOUT_SLUGS;

/** Layouts of two rooms or more, the sizes this project searches for. */
export const CHINTAI_FAMILY_LAYOUT_SLUGS: readonly ChintaiLayoutSlug[] = ["2k", "2ldk", "3k", "3ldk", "4k", "4ldk", "5k", "5ldk"];

/** Building-type slugs, usable after /list/ and /rent/. */
export const CHINTAI_BUILDING_TYPE_SLUGS = { mansion: "賃貸マンション", apart: "賃貸アパート", kodate: "賃貸一戸建て" } as const;

/** Theme (こだわり) slugs a city or station list page offers after /list/. */
export const CHINTAI_THEME_SLUGS = {
  zero: "敷金礼金なし", "initial-cost": "初期費用が安い", freerent: "フリーレント",
  tesuuryou0: "仲介手数料無料", tesuuryou: "仲介手数料が家賃の55%以下", Initialcredit: "初期費用クレジット払い可能",
  sanmanen: "家賃3万円以下", gomanen: "家賃5万円以下", gakuwari: "学生割引制度（学割）対象",
  shinchiku: "新築・築浅", reform: "リフォーム・リノベーション済み", designers: "デザイナーズ",
  "bath-toilet": "バス・トイレ別", "bidet-seat": "温水洗浄便座（ウォシュレット）付き", shokusenki: "食器洗浄乾燥機（食洗機）付き",
  "counter-kitchen": "カウンターキッチン付き", storage: "収納重視", "barrier-free": "バリアフリー",
  hiroioneroom: "広いワンルーム", hiroild: "広いリビング・ダイニングがある", terrace: "ベランダ・バルコニー付き",
  "roof-balcony": "ルーフバルコニー付き", okujou: "屋上付き", pet: "ペット可・ペット相談可",
  gakki: "楽器相談可", piano: "ピアノ相談可", diy: "DIY可",
  single: "一人暮らし向け", futari: "二人暮らし向け", family: "ファミリー向け", gakusei: "学生向け",
  woman: "女性向け・女性専用", foreigner: "外国人向け", senior: "シニア・高齢者相談可", kodomo: "子供部屋・子供可",
  "non-guarantor": "保証人不要", teiki: "定期借家", ekitoho: "駅徒歩5分以内", parking: "駐車場付き",
  internet: "インターネット無料", hikari: "光ファイバー対応", kagukaden: "家具家電付き", tower: "タワーマンション",
  bunjo: "分譲賃貸", "high-grade": "高級賃貸", soho: "SOHO向け", tokuyuchin: "特優賃（特定優良賃貸住宅）",
} as const;

/** One slug per path: /list/kodate/2ldk/ redirects to /list/kodate/, so filters cannot be stacked. */
export type ChintaiListFilter = ChintaiLayoutSlug | keyof typeof CHINTAI_BUILDING_TYPE_SLUGS | keyof typeof CHINTAI_THEME_SLUGS;
export type ChintaiRentFilter = ChintaiLayoutSlug | keyof typeof CHINTAI_BUILDING_TYPE_SLUGS;

/** A place a list, rent or archive page is scoped to: an area (city or town code) or a line or station code. */
export type ChintaiPlace = { kind: "area"; code: string } | { kind: "ensen"; code: string };

/** XML sitemaps named in robots.txt (the root /sitemap.xml is a 404). */
export const CHINTAI_SITEMAPS = [
  "/xml/sitemap.xml",
  "/xml/sitemap_detail.xml",
  "/xml/sitemap_bld_true.xml",
  "/xml/sitemap_list.xml",
  "/news/sitemap.xml",
  "/sitemap_faq2_chintai_net.xml",
].map((path) => CHINTAI_ORIGIN + path);

const placePath = (prefecture: ChintaiPrefecture, place: ChintaiPlace) => `/${prefecture}/${place.kind}/${place.code}`;
const pageSuffix = (page = 1) => {
  if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid CHINTAI page ${page}`);
  return page === 1 ? "" : `page${page}/`;
};

/** Search results: /{pref}/{area|ensen}/{code}/list/[{filter}/][page{n}/]. Page 1 has no page segment. */
export function chintaiListUrl(prefecture: ChintaiPrefecture, place: ChintaiPlace, options: { filter?: ChintaiListFilter; page?: number } = {}): string {
  const filter = options.filter ? `${options.filter}/` : "";
  return `${CHINTAI_ORIGIN}${placePath(prefecture, place)}/list/${filter}${pageSuffix(options.page)}`;
}

/** Rent-market (家賃相場) page: /{pref}/{area|ensen}/{code}/rent/[{layout|type}/]. */
export function chintaiRentUrl(prefecture: ChintaiPrefecture, place: ChintaiPlace, filter?: ChintaiRentFilter): string {
  return `${CHINTAI_ORIGIN}${placePath(prefecture, place)}/rent/${filter ? `${filter}/` : ""}`;
}

/** Archive building index (past and current buildings): /archive/{pref}/area/{city}/ or /archive/{pref}/ensen/{station}/. */
export function chintaiArchiveUrl(prefecture: ChintaiPrefecture, place: ChintaiPlace, page = 1): string {
  return `${CHINTAI_ORIGIN}/archive/${prefecture}/${place.kind}/${place.code}/${pageSuffix(page)}`;
}

/** Line hub listing that line's stations in one prefecture: /{pref}/en-{line}/. */
export function chintaiLineUrl(prefecture: ChintaiPrefecture, lineCode: string): string {
  return `${CHINTAI_ORIGIN}/${prefecture}/en-${lineCode}/`;
}

/** Building page: /{pref}/bld-{id}/. */
export function chintaiBuildingUrl(prefecture: ChintaiPrefecture, buildingId: string): string {
  return `${CHINTAI_ORIGIN}/${prefecture}/bld-${buildingId}/`;
}

/** Ad (unit) page. `bk` is a residential ad; `tn` is a shop or office (テナント) ad. */
export function chintaiDetailUrl(key: string, kind: "bk" | "tn" = "bk"): string {
  parseChintaiKey(key);
  return `${CHINTAI_ORIGIN}/detail/${kind}-${key}/`;
}

export interface ChintaiKey {
  key: string;
  /** Listing agent: 9 digits for Able group stores (000000416 = エイブル草加西口店), C + 8 digits for other agents. */
  shopCode: string;
  propertyCode: string;
  roomCode: string;
  /**
   * Same unit across Able group stores: they share property and room codes
   * (000000416/426/431-000000000536559-0005 is one room). Other agents
   * number units themselves, so C keys have none.
   */
  ableUnitKey: string | null;
}

/** Splits a 28-character ad key the way the page's 物件管理コード shows it: shop(9)-property(15)-room(4). */
export function parseChintaiKey(key: string): ChintaiKey {
  const match = key.match(/^(C\d{8}|\d{9})(\d{15})(\d{4})$/);
  if (!match) throw new Error(`Not a CHINTAI ad key: ${key}`);
  const [, shopCode, propertyCode, roomCode] = match;
  return { key, shopCode, propertyCode, roomCode, ableUnitKey: shopCode.startsWith("C") ? null : `${propertyCode}-${roomCode}` };
}

/** The ad key in a /detail/bk-{key}/ or /detail/tn-{key}/ URL (query strings such as ?prefkey= are ignored). */
export function chintaiKeyFromUrl(url: string): string | null {
  return new URL(url, CHINTAI_ORIGIN).pathname.match(/^\/detail\/(?:bk|tn)-([0-9A-Z]{28})\/?$/)?.[1] ?? null;
}
