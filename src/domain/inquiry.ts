/**
 * Inquiry draft: the first message to an agency about a shortlisted home,
 * in polite Japanese with an English gloss. The Japanese wording is fixed
 * business phrasing; this module only assembles it, so what the user sends
 * is predictable and the gloss can mirror it line by line.
 */
import { isUrListing } from "./ur";
import { sourceListings } from "./listingDedup";
import { isViewingTime } from "./notes";
import type { EnrichedListing } from "./types";

export type JapaneseLevel = "fluent" | "daily" | "english-preferred";

export interface InquiryProfile {
  /** Sender's name as it should be signed, e.g. "Jehandad Kamal" or "カマル ジェハンダッド". */
  name: string;
  /** e.g. "パキスタン". Empty = do not state. */
  nationality: string;
  /** 在留資格, e.g. "技術・人文知識・国際業務", "永住者". Empty = do not state. */
  residenceStatus: string;
  /** How the agency can talk to us. */
  japanese: JapaneseLevel;
  adults: number;
  children: number;
  /** Desired move-in, free text in Japanese or a YYYY-MM month; empty = do not state. */
  moveIn: string;
  /** Phone or e-mail to sign with; empty = omit. */
  contact: string;
}

export const DEFAULT_INQUIRY_PROFILE: InquiryProfile = {
  name: "",
  nationality: "",
  residenceStatus: "",
  japanese: "daily",
  adults: 2,
  children: 0,
  moveIn: "",
  contact: "",
};

const LEVELS: readonly JapaneseLevel[] = ["fluent", "daily", "english-preferred"];

const text = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

const clampCount = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Field-by-field, so one bad or missing field never discards the rest of what was typed. */
export function decodeInquiryProfile(raw: unknown): InquiryProfile {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_INQUIRY_PROFILE;
  return {
    name: text(o.name, d.name),
    nationality: text(o.nationality, d.nationality),
    residenceStatus: text(o.residenceStatus, d.residenceStatus),
    japanese: LEVELS.includes(o.japanese as JapaneseLevel) ? (o.japanese as JapaneseLevel) : d.japanese,
    adults: clampCount(o.adults, 1, 9, d.adults),
    children: clampCount(o.children, 0, 9, d.children),
    moveIn: text(o.moveIn, d.moveIn),
    contact: text(o.contact, d.contact),
  };
}

export interface InquiryQuestions {
  availability: boolean;
  foreignTenant: boolean;
  viewing: boolean;
  initialCosts: boolean;
  parking: boolean;
  moveInDate: boolean;
}

export const DEFAULT_INQUIRY_QUESTIONS: InquiryQuestions = {
  availability: true,
  foreignTenant: true,
  viewing: true,
  initialCosts: true,
  parking: false,
  moveInDate: false,
};

export interface InquiryDraftText {
  /** Japanese subject line. */
  subject: string;
  /** Japanese body, plain text with \n. */
  body: string;
  /** English gloss of the same message, for the user's own understanding. */
  english: string;
}

const WEEKDAYS_JA = "日月火水木金土";
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface ViewingParts {
  month: number;
  day: number;
  weekday: number;
  hour: number | null;
  minute: number;
}

/** Date parts are read from the string and the weekday from UTC, so no time zone can shift the day. */
function viewingParts(viewingAt: string | null): ViewingParts | null {
  if (!viewingAt || !isViewingTime(viewingAt)) return null;
  const [date, time] = viewingAt.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time ? time.split(":").map(Number) : [null, 0];
  return { month: m, day: d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), hour: h, minute: min };
}

function viewingJa(v: ViewingParts | null): string {
  if (!v) return "ご都合のよい日時をいくつかお教えいただけますでしょうか。";
  const day = `${v.month}月${v.day}日（${WEEKDAYS_JA[v.weekday]}）`;
  if (v.hour === null) return `${day}のご都合はいかがでしょうか。`;
  return `${day}${v.hour}時${v.minute !== 0 ? `${v.minute}分` : ""}頃のご都合はいかがでしょうか。`;
}

function viewingEn(v: ViewingParts | null): string {
  if (!v) return "Could you suggest a few dates and times that suit you?";
  const day = `${WEEKDAYS_EN[v.weekday]}, ${MONTHS_EN[v.month - 1]} ${v.day}`;
  if (v.hour === null) return `Would ${day} suit you?`;
  return `Would ${day} at around ${v.hour}:${String(v.minute).padStart(2, "0")} suit you?`;
}

const moveInJa = (value: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  return m ? `${m[1]}年${Number(m[2])}月` : value;
};

const moveInEn = (value: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTHS_EN[Number(m[2]) - 1]} ${m[1]}` : value;
};

const JAPANESE_JA: Record<JapaneseLevel, string> = {
  fluent: "日本語での会話・書類のやり取りに問題はございません。",
  daily: "日本語での日常会話は可能です。",
  "english-preferred": "可能でしたら、英語でのご対応をお願いできますと幸いです。",
};

const JAPANESE_EN: Record<JapaneseLevel, string> = {
  fluent: "I have no problem with Japanese conversation or paperwork.",
  daily: "I can hold everyday conversations in Japanese.",
  "english-preferred": "If possible, I would appreciate it if you could assist me in English.",
};

const yen = (n: number): string => n.toLocaleString("en-US");

/** The ad's own page, or the first portal ad when the merged listing has none. */
function adUrl(listing: EnrichedListing): string | null {
  return listing.url ?? sourceListings(listing).find((ad) => ad.url)?.url ?? null;
}

export function buildInquiry(
  listing: EnrichedListing,
  profile: InquiryProfile,
  questions: InquiryQuestions,
  viewingAt: string | null,
): InquiryDraftText {
  const ur = isUrListing(listing);
  const name = profile.name.trim();
  const nationality = profile.nationality.trim();
  const status = profile.residenceStatus.trim();
  const moveIn = profile.moveIn.trim();
  const contact = profile.contact.trim();
  const url = adUrl(listing);
  const viewing = viewingParts(viewingAt);
  const asks = { ...questions, foreignTenant: questions.foreignTenant && !ur };

  const layoutSize = [listing.layout, listing.sizeM2 != null ? `${listing.sizeM2}㎡` : null].filter(Boolean);
  // UR lets rooms through portals too, but the landlord is always UR itself.
  const agencyName = ur ? "" : (listing.agencyInfo?.name ?? listing.agency ?? "").trim();

  // Subject
  const tag = asks.viewing ? "お問い合わせ・内見希望" : "お問い合わせ";
  const subject = `【${tag}】${listing.name}（${[listing.layout, `${yen(listing.rent)}円`].filter(Boolean).join("／")}）`;
  const subjectEn = `Subject: Inquiry${asks.viewing ? " and viewing request" : ""} - ${listing.name} (${[listing.layout, `¥${yen(listing.rent)}`].filter(Boolean).join(" / ")})`;

  // Questions, numbered consecutively in a fixed order.
  const qJa: string[] = [];
  const qEn: string[] = [];
  const ask = (ja: string, en: string) => {
    qJa.push(ja);
    qEn.push(en);
  };
  if (asks.availability) ask("現在も募集中でしょうか。", "Is it still available?");
  if (asks.foreignTenant) {
    const detail = [nationality && `${nationality}国籍`, status && `在留資格：${status}`].filter(Boolean).join("、");
    const detailEn = [nationality && `nationality: ${nationality}`, status && `residence status: ${status}`].filter(Boolean).join(", ");
    ask(
      `私は外国籍${detail ? `（${detail}）` : ""}ですが、入居審査の対象としていただけますでしょうか。${JAPANESE_JA[profile.japanese]}`,
      `I am a foreign national${detailEn ? ` (${detailEn})` : ""}. Would my application be considered? ${JAPANESE_EN[profile.japanese]}`,
    );
  }
  if (asks.viewing) ask(`内見を希望しております。${viewingJa(viewing)}`, `I would like to view the home. ${viewingEn(viewing)}`);
  if (asks.initialCosts) {
    ask(
      ur
        ? "初期費用の概算（敷金・日割り家賃・共益費など）をお知らせください。"
        : "初期費用の概算（敷金・礼金・仲介手数料・保証会社利用料・火災保険料・鍵交換代など）をお知らせください。",
      ur
        ? "Please tell us the approximate initial costs (deposit, pro-rated rent, common service fee, etc.)."
        : "Please tell us the approximate initial costs (deposit, key money, agency fee, guarantor company fee, fire insurance, key exchange, etc.).",
    );
  }
  if (asks.parking) ask("駐車場の空き状況と月額料金をお教えください。", "Please tell us whether parking is available and the monthly fee.");
  if (asks.moveInDate) ask("入居可能時期はいつ頃でしょうか。", "When would the home be available to move into?");

  const people = profile.adults + profile.children;
  const household = `${profile.adults}名${profile.children > 0 ? `・子ども${profile.children}名` : ""}`;
  const householdEn = `${profile.adults} adult${profile.adults === 1 ? "" : "s"}${profile.children > 0 ? `, ${profile.children} child${profile.children === 1 ? "" : "ren"}` : ""}`;
  const peopleJa = `入居予定人数は${people}名（大人${household}）${moveIn ? `、入居希望時期は${moveInJa(moveIn)}` : ""}です。`;
  const peopleEn = `Number of occupants: ${people} (${householdEn})${moveIn ? `; desired move-in: ${moveInEn(moveIn)}` : ""}.`;

  const facts = (labels: { name: string; address: string; rent: string; layout: string; url: string }, ja: boolean): string[] =>
    [
      `■ ${labels.name}：${listing.name}`,
      listing.address ? `■ ${labels.address}：${listing.address}` : null,
      `■ ${labels.rent}：${ja ? `${yen(listing.rent)}円（管理費・共益費込み）` : `¥${yen(listing.rent)} (management fee included)`}`,
      layoutSize.length ? `■ ${labels.layout}：${layoutSize.join("・")}` : null,
      url ? `■ ${labels.url}：${url}` : null,
    ].filter((line): line is string => line !== null);

  const body = [
    `${agencyName ? `${agencyName} ` : ur ? "UR都市機構 " : ""}ご担当者様`,
    "",
    `はじめまして。${name ? `${name}と申します。` : ""}`,
    ur ? "貴機構が募集されている下記の住宅について、お問い合わせいたします。" : "貴社が掲載されている下記の物件について、お問い合わせいたします。",
    "",
    ...facts({ name: "物件名", address: "所在地", rent: "賃料", layout: "間取り・面積", url: "掲載ページ" }, true),
    ...(qJa.length ? ["", "以下の点についてお教えいただけますでしょうか。", "", ...qJa.map((q, i) => `${i + 1}. ${q}`)] : []),
    "",
    peopleJa,
    "",
    "お忙しいところ恐れ入りますが、ご返信いただけますと幸いです。",
    "何卒よろしくお願いいたします。",
    ...(name || contact ? [""] : []),
    ...(name ? [name] : []),
    ...(contact ? [contact] : []),
  ].join("\n");

  const english = [
    subjectEn,
    "",
    `${agencyName ? `${agencyName} - ` : ur ? "UR Urban Renaissance Agency - " : ""}To whom it may concern,`,
    "",
    `Nice to meet you.${name ? ` My name is ${name}.` : ""}`,
    ur ? "I am writing about the home below, which you are offering." : "I am writing about the property below, which you have advertised.",
    "",
    ...facts({ name: "Name", address: "Address", rent: "Rent", layout: "Layout / size", url: "Listing page" }, false),
    ...(qEn.length ? ["", "Could you please tell me the following?", "", ...qEn.map((q, i) => `${i + 1}. ${q}`)] : []),
    "",
    peopleEn,
    "",
    "Sorry to trouble you when you are busy; I would be grateful for your reply.",
    "Thank you very much in advance.",
    ...(name || contact ? [""] : []),
    ...(name ? [name] : []),
    ...(contact ? [contact] : []),
  ].join("\n");

  return { subject, body, english };
}
