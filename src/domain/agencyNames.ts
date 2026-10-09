/**
 * Agency identity for display and grouping: English names, and the place a
 * store is named after, both derived deterministically from the stored store
 * fields (ListingAgency) and the reference catalog. Nothing here is stored;
 * a better dictionary re-derives every listing on the next load.
 *
 *   "シャーメゾンショップ　株式会社クイックホーム　北越谷店"
 *     → brand Sha Maison Shop · agency Quick Home Co., Ltd. (クイックホーム)
 *       · branch 北越谷 → station 北越谷 → Koshigaya (越谷市)
 */
import type { ReferenceCity } from "./referenceData";
import type { ListingAgency, RawListing } from "./types";

/** Official English names of chains and franchises (keys as stored in `brand`). */
const BRAND_EN: Record<string, string> = {
  "シャーメゾンショップ": "Sha Maison Shop",
  "センチュリー21": "CENTURY 21",
  "いい部屋ネット": "Ii Heya Net",
  "Room'Spot": "Room'Spot",
  "UR都市機構": "UR (Urban Renaissance Agency)",
  "アパマンショップ": "Apamanshop",
  "ピタットハウス": "Pitat House",
  "エイブル": "ABLE",
  "ミニミニ": "minimini",
  "ハウスコム": "Housecom",
  "ハウスメイト": "Housemate",
  "ホームメイト": "Homemate",
  "レオパレス21": "Leopalace21",
  "ハウス・トゥ・ハウス": "House to House",
  "タウンハウジング": "Town Housing",
};

/**
 * Words inside company names. Katakana loanwords map to their English word;
 * kanji entries are business words and the readings of names seen in the data.
 * Longest match wins. Kanji with no entry stay untranslated (`nameEn` null).
 */
const WORD_EN: Record<string, string> = {
  // Loanwords.
  "リアルエステート": "Real Estate", "ネットサービス": "Net Service", "ハウジング": "Housing", "エステート": "Estate",
  "リーシング": "Leasing", "パートナー": "Partner", "グローバル": "Global", "クリエイト": "Create", "アドバンス": "Advance",
  "センター": "Center", "サービス": "Service", "クイック": "Quick", "フレンド": "Friend", "ステージ": "Stage",
  "シンクロ": "Synchro", "ハウス": "House", "ホーム": "Home", "ベスト": "Best", "ライフ": "Life", "ルーム": "Room",
  "プラザ": "Plaza", "コスモ": "Cosmo", "ビル": "Building", "ウィン": "Win", "ショップ": "Shop", "トゥ": "to",
  // Business words.
  "都市再生機構": "Urban Renaissance Agency", "住宅運営部": "Housing Operations", "不動産": "Real Estate",
  "住宅": "Housing", "建物": "Buildings", "建設": "Construction", "管理": "Management", "賃貸": "Rental",
  "商事": "Trading", "開発": "Development", "地所": "Estate", "興業": "Kogyo", "企画": "Planning",
  // Readings of company names in the data (official romanisation where the company has one).
  "三菱地所リアルエステートサービス": "Mitsubishi Real Estate Services",
  "三菱地所": "Mitsubishi Estate", "大東建託": "Daito Kentaku", "丸吉": "Maruyoshi", "三和": "Sanwa",
  "三愛": "San'ai", "市川": "Ichikawa", "平和": "Heiwa", "丸和": "Maruwa", "中心": "Chushin", "田園": "Den'en",
  "中央": "Chuo", "恵比寿": "Ebisu", "東京": "Tokyo", "埼玉": "Saitama",
};

const LEGAL_EN: Record<string, string> = { "株式会社": "Co., Ltd.", "有限会社": "Ltd.", "合同会社": "LLC", "独立行政法人": "" };
const LEGAL = /株式会社|有限会社|合同会社|独立行政法人|\((?:株|有|同)\)/g;
const SPELLED_OUT: Record<string, string> = { "(株)": "株式会社", "(有)": "有限会社", "(同)": "合同会社" };

const KANA: Record<string, string> = Object.fromEntries(([
  "ア a イ i ウ u エ e オ o カ ka キ ki ク ku ケ ke コ ko サ sa シ shi ス su セ se ソ so タ ta チ chi ツ tsu テ te ト to",
  "ナ na ニ ni ヌ nu ネ ne ノ no ハ ha ヒ hi フ fu ヘ he ホ ho マ ma ミ mi ム mu メ me モ mo ヤ ya ユ yu ヨ yo",
  "ラ ra リ ri ル ru レ re ロ ro ワ wa ヲ o ン n ガ ga ギ gi グ gu ゲ ge ゴ go ザ za ジ ji ズ zu ゼ ze ゾ zo",
  "ダ da ヂ ji ヅ zu デ de ド do バ ba ビ bi ブ bu ベ be ボ bo パ pa ピ pi プ pu ペ pe ポ po ヴ vu",
  "キャ kya キュ kyu キョ kyo シャ sha シュ shu ショ sho チャ cha チュ chu チョ cho ニャ nya ニュ nyu ニョ nyo",
  "ヒャ hya ヒュ hyu ヒョ hyo ミャ mya ミュ myu ミョ myo リャ rya リュ ryu リョ ryo ギャ gya ギュ gyu ギョ gyo",
  "ジャ ja ジュ ju ジョ jo ビャ bya ビュ byu ビョ byo ピャ pya ピュ pyu ピョ pyo",
  "ファ fa フィ fi フェ fe フォ fo ティ ti ディ di デュ dyu ウィ wi ウェ we ウォ wo シェ she ジェ je チェ che",
  "ァ a ィ i ゥ u ェ e ォ o ャ ya ュ yu ョ yo",
].join(" ").split(" ").reduce<[string, string][]>((pairs, item, index, all) => index % 2 ? pairs : [...pairs, [item, all[index + 1]]], [])));

const toKatakana = (text: string) => text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/** Hepburn without macrons: "マルフク" → "Marufuku", "せんげん台" → "Sengen" + 台 (kanji left as is). */
export function romanizeKana(text: string): string {
  const kana = toKatakana(text);
  let out = "";
  for (let i = 0; i < kana.length; i++) {
    const pair = KANA[kana.slice(i, i + 2)];
    if (pair) { out += pair; i++; continue; }
    const char = kana[i];
    if (char === "ッ") { const next = KANA[kana.slice(i + 1, i + 3)] ?? KANA[kana[i + 1]] ?? ""; out += next.startsWith("ch") ? "t" : next[0] ?? ""; continue; }
    if (char === "ー") continue;
    if (char === "ン" && /^[aiueoy]/.test(KANA[kana.slice(i + 1, i + 3)] ?? KANA[kana[i + 1]] ?? "")) { out += "n'"; continue; }
    out += KANA[char] ?? char;
  }
  return out;
}

const capitalize = (word: string) => word.replace(/^[a-z]/, (c) => c.toUpperCase());

/** "クイックホーム" → "Quick Home"; "ビル管理" → "Building Management"; null when kanji stay unread. */
export function englishWords(text: string): string | null {
  const words: string[] = [];
  let unread = false;
  // Brand names are words too: "ハウスコム埼玉" → "Housecom Saitama".
  const dictionary: Record<string, string> = { ...WORD_EN, ...BRAND_EN };
  const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
  const source = text.normalize("NFKC");
  for (let i = 0; i < source.length;) {
    const key = keys.find((k) => source.startsWith(k, i));
    if (key) { words.push(dictionary[key]); i += key.length; continue; }
    const latin = source.slice(i).match(/^[A-Za-z0-9'&.\- ]+/)?.[0];
    if (latin) { words.push(latin.trim()); i += latin.length; continue; }
    const kana = source.slice(i).match(/^[゠-ヿぁ-ゖ]+/)?.[0];
    if (kana) {
      // Stop the run where a dictionary word starts, so "ラテルーム" reads "Rate Room".
      let end = kana.length;
      for (let j = 1; j < kana.length; j++) if (keys.some((k) => source.startsWith(k, i + j))) { end = j; break; }
      const part = kana.slice(0, end).replace(/^・|・$/g, "");
      if (part) words.push(capitalize(romanizeKana(part.replace(/・/g, " "))));
      i += end; continue;
    }
    if (/[\p{Script=Han}々]/u.test(source[i])) unread = true;
    if (source[i] !== "・" && source[i] !== " ") words.push(source[i]);
    i++;
  }
  return unread ? null : words.filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || null;
}

/** The company's own name, legal form removed: "株式会社ベストハウジング" → "ベストハウジング". */
export function companyCore(company: string): string {
  return company.normalize("NFKC").replace(LEGAL, "").replace(/\s+/g, " ").trim();
}

/** "株式会社クイックホーム" → "Quick Home Co., Ltd."; null when part of the name has no reading. */
export function englishCompanyName(company: string): string | null {
  const name = company.normalize("NFKC");
  const form = name.match(LEGAL)?.[0];
  const core = englishWords(companyCore(name));
  if (!core) return null;
  const suffix = form ? LEGAL_EN[SPELLED_OUT[form] ?? form] : "";
  return suffix ? `${core} ${suffix}` : core;
}

export function englishBrandName(brand: string): string | null {
  return BRAND_EN[brand] ?? englishWords(brand);
}

// ── Place a store is named after ────────────────────────────────────────────

export interface AgencyGazetteer {
  /** Station or municipality name (without 市区町村) → the cities it may be in. */
  readonly places: ReadonlyMap<string, readonly ReferenceCity[]>;
  /** Cities by local name ("越谷市", "さいたま市浦和区"), longest first, for addresses. */
  readonly byLocalName: readonly ReferenceCity[];
}

/** Matching key: NFKC, and the spelling variants station names use (竹の塚 / 竹ノ塚, 鳩ヶ谷 / 鳩ケ谷). */
const placeKey = (text: string) => text.normalize("NFKC").replace(/[ノの]/g, "の").replace(/[ヶケヵが]/g, "が");

export function buildAgencyGazetteer(cities: readonly ReferenceCity[], stations: readonly { name: string; cityId?: string }[]): AgencyGazetteer {
  const byId = new Map(cities.map((city) => [city.id, city]));
  const places = new Map<string, ReferenceCity[]>();
  const add = (name: string, city: ReferenceCity | undefined) => {
    if (!name || !city) return;
    const key = placeKey(name);
    const list = places.get(key) ?? [];
    if (!list.includes(city)) list.push(city);
    places.set(key, list);
  };
  for (const city of cities) {
    const local = city.nameLocal ?? "";
    // "越谷市" → 越谷; "さいたま市浦和区" → 浦和 (the ward) as well.
    add(local.replace(/[市区町村]$/u, ""), city);
    const ward = local.match(/市(.+)区$/u)?.[1];
    if (ward) add(ward, city);
  }
  for (const station of stations) add(station.name.replace(/駅$/u, ""), station.cityId ? byId.get(station.cityId) : undefined);
  const byLocalName = cities.filter((city) => city.nameLocal).sort((a, b) => b.nameLocal!.length - a.nameLocal!.length);
  return { places, byLocalName };
}

const BRANCH_SUFFIX = /(?:店|営業所|支店|出張所|案内所|営業センター)$/u;
const PLACE_SUFFIX = /(?:駅前|駅|[東西南北]口|現地|本)$/u;
const PREFECTURE_PREFIX = /^(?:埼玉|東京|千葉|神奈川|茨城|栃木|群馬)(?=.)/u;

/** The reference city an office address is in: the longest local name it starts with. */
export function cityOfAddress(address: string | null, gazetteer: AgencyGazetteer): ReferenceCity | null {
  if (!address) return null;
  const text = address.normalize("NFKC").replace(/\s+/g, "");
  return gazetteer.byLocalName.find((city) => {
    const rest = city.prefecture && text.startsWith(city.prefecture) ? text.slice(city.prefecture.length) : text;
    return rest.startsWith(city.nameLocal!);
  }) ?? null;
}

export interface AgencyPlace {
  /** The place as written in the branch: "北越谷", "せんげん台". */
  name: string;
  /** Its city; null when no gazetteer entry matches or the name is ambiguous. */
  city: ReferenceCity | null;
}

/**
 * "北越谷店" → 北越谷 (station, Koshigaya) · "埼玉八潮店" → 八潮 (city) · "川口東口店" → 川口
 * · "赤羽駅前店" → 赤羽. The first rule that matches wins, in this order: the
 * whole name, then its longest leading part. A name in several cities keeps
 * the one in the office's prefecture, else stays unresolved.
 */
export function agencyPlace(branch: string | null, gazetteer: AgencyGazetteer, office: ReferenceCity | null = null): AgencyPlace | null {
  if (!branch) return null;
  let core = branch.normalize("NFKC").replace(BRANCH_SUFFIX, "").replace(/営業$/u, "");
  for (let previous = ""; previous !== core;) { previous = core; core = core.replace(PLACE_SUFFIX, ""); }
  core = core.replace(PREFECTURE_PREFIX, "");
  if (!core) return null;
  const lookup = (name: string) => gazetteer.places.get(placeKey(name));
  let name = core, cities = lookup(core);
  for (let length = core.length - 1; !cities && length >= 2; length--) {
    name = core.slice(0, length);
    cities = lookup(name);
  }
  if (!cities) return { name: core, city: null };
  const only = (list: readonly ReferenceCity[]) => list.length === 1 ? list[0] : null;
  const city = only(cities) ?? cities.find((candidate) => candidate.id === office?.id)
    ?? only(cities.filter((candidate) => office != null && candidate.prefecture === office.prefecture));
  return { name, city };
}

// ── Putting it together ─────────────────────────────────────────────────────

export interface AgencyIdentity {
  /** Stores of one company share this: "ベストハウジング". */
  groupKey: string;
  /** The agency (company) name without legal form or branch: "ベストハウジング". */
  agency: string;
  agencyEn: string | null;
  /** Franchise or chain, when the store belongs to one other than its own company. */
  brand: string | null;
  brandEn: string | null;
  branch: string | null;
  /** The place the branch is named after. */
  place: AgencyPlace | null;
  /** Where the store is: its office address, else the place its branch is named after. */
  city: ReferenceCity | null;
}

type StoreFields = Pick<ListingAgency, "name" | "brand" | "company" | "branch"> & Partial<Pick<ListingAgency, "address">>;

/** The agency a store belongs to, and the key its stores group under: its company, else its brand or name. */
/**
 * RoomSpot is Polus's own site: all 577 RoomSpot ads read by 2026-10-09 were
 * advertised by 株式会社中央ビル管理, from 18 different offices that the listing
 * itself does not reveal. Until an ad's page is read, the company is known, the
 * office is not.
 */
const ROOMSPOT_ADVERTISER: ListingAgency = { name: "株式会社中央ビル管理", brand: "中央ビル管理", company: "株式会社中央ビル管理",
  branch: null, address: null, prefecture: null, city: null, phone: null, licence: "国土交通大臣(9)第3918号", inferred: true };

/** The advertiser a listing implies when no page has named its store; null when nothing can be inferred. */
export function inferredAgency(listing: Pick<RawListing, "source" | "sourceListings" | "agency" | "agencyInfo">): ListingAgency | null {
  if (listing.agency != null || listing.agencyInfo != null) return null;
  const onRoomspot = listing.source === "roomspot" || listing.sourceListings?.some((reference) => reference.source === "roomspot");
  return onRoomspot ? { ...ROOMSPOT_ADVERTISER } : null;
}

export function agencyOf(store: Pick<ListingAgency, "name" | "brand" | "company">): { agency: string; groupKey: string } {
  const agency = store.company ? companyCore(store.company) : (store.brand ?? store.name);
  return { agency, groupKey: agency.normalize("NFKC").replace(/\s+/g, "") };
}

export function agencyIdentity(store: StoreFields, gazetteer: AgencyGazetteer): AgencyIdentity {
  const { agency, groupKey } = agencyOf(store);
  const office = cityOfAddress(store.address ?? null, gazetteer);
  const place = agencyPlace(store.branch, gazetteer, office);
  const brand = store.brand && store.brand !== agency ? store.brand : null;
  return {
    groupKey,
    agency,
    agencyEn: store.company ? englishCompanyName(store.company) : englishBrandName(agency),
    brand,
    brandEn: brand ? englishBrandName(brand) : null,
    branch: store.branch,
    place,
    city: office ?? place?.city ?? null,
  };
}
