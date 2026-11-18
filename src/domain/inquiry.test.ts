import { describe, expect, it } from "vitest";
import {
  DEFAULT_INQUIRY_PROFILE,
  DEFAULT_INQUIRY_QUESTIONS,
  buildInquiry,
  decodeInquiryProfile,
  type InquiryProfile,
  type InquiryQuestions,
} from "./inquiry";
import type { EnrichedListing } from "./types";

const listing = (over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  name: "サンハイツ草加",
  address: "埼玉県草加市松原1-1-1",
  city: "Soka",
  rent: 98_500,
  layout: "3LDK",
  sizeM2: 71.12,
  builtYear: 2010,
  stationWalkMin: 8,
  url: "https://example.test/ad/1",
  source: "athome",
  geocoded: true,
  lat: 35.83,
  lon: 139.8,
  agencyInfo: { name: "ハウスA 草加店" } as EnrichedListing["agencyInfo"],
  ...over,
});

const full: InquiryProfile = {
  name: "Jehandad Kamal",
  nationality: "パキスタン",
  residenceStatus: "永住者",
  japanese: "daily",
  adults: 2,
  children: 2,
  moveIn: "2027-03",
  contact: "090-0000-0000",
};

const all: InquiryQuestions = { availability: true, foreignTenant: true, viewing: true, initialCosts: true, parking: true, moveInDate: true };
const none: InquiryQuestions = { availability: false, foreignTenant: false, viewing: false, initialCosts: false, parking: false, moveInDate: false };

describe("buildInquiry", () => {
  it("writes the full message with every question on", () => {
    const r = buildInquiry(listing(), full, all, "2026-12-05T10:30");
    expect(r.subject).toBe("【お問い合わせ・内見希望】サンハイツ草加（3LDK／98,500円）");
    expect(r.body).toBe(
      [
        "ハウスA 草加店 ご担当者様",
        "",
        "はじめまして。Jehandad Kamalと申します。",
        "貴社が掲載されている下記の物件について、お問い合わせいたします。",
        "",
        "■ 物件名：サンハイツ草加",
        "■ 所在地：埼玉県草加市松原1-1-1",
        "■ 賃料：98,500円（管理費・共益費込み）",
        "■ 間取り・面積：3LDK・71.12㎡",
        "■ 掲載ページ：https://example.test/ad/1",
        "",
        "以下の点についてお教えいただけますでしょうか。",
        "",
        "1. 現在も募集中でしょうか。",
        "2. 私は外国籍（パキスタン国籍、在留資格：永住者）ですが、入居審査の対象としていただけますでしょうか。日本語での日常会話は可能です。",
        "3. 内見を希望しております。12月5日（土）10時30分頃のご都合はいかがでしょうか。",
        "4. 初期費用の概算（敷金・礼金・仲介手数料・保証会社利用料・火災保険料・鍵交換代など）をお知らせください。",
        "5. 駐車場の空き状況と月額料金をお教えください。",
        "6. 入居可能時期はいつ頃でしょうか。",
        "",
        "入居予定人数は4名（大人2名・子ども2名）、入居希望時期は2027年3月です。",
        "",
        "お忙しいところ恐れ入りますが、ご返信いただけますと幸いです。",
        "何卒よろしくお願いいたします。",
        "",
        "Jehandad Kamal",
        "090-0000-0000",
      ].join("\n"),
    );
    expect(r.english).toBe(
      [
        "Subject: Inquiry and viewing request - サンハイツ草加 (3LDK / ¥98,500)",
        "",
        "ハウスA 草加店 - To whom it may concern,",
        "",
        "Nice to meet you. My name is Jehandad Kamal.",
        "I am writing about the property below, which you have advertised.",
        "",
        "■ Name：サンハイツ草加",
        "■ Address：埼玉県草加市松原1-1-1",
        "■ Rent：¥98,500 (management fee included)",
        "■ Layout / size：3LDK・71.12㎡",
        "■ Listing page：https://example.test/ad/1",
        "",
        "Could you please tell me the following?",
        "",
        "1. Is it still available?",
        "2. I am a foreign national (nationality: パキスタン, residence status: 永住者). Would my application be considered? I can hold everyday conversations in Japanese.",
        "3. I would like to view the home. Would Saturday, December 5 at around 10:30 suit you?",
        "4. Please tell us the approximate initial costs (deposit, key money, agency fee, guarantor company fee, fire insurance, key exchange, etc.).",
        "5. Please tell us whether parking is available and the monthly fee.",
        "6. When would the home be available to move into?",
        "",
        "Number of occupants: 4 (2 adults, 2 children); desired move-in: March 2027.",
        "",
        "Sorry to trouble you when you are busy; I would be grateful for your reply.",
        "Thank you very much in advance.",
        "",
        "Jehandad Kamal",
        "090-0000-0000",
      ].join("\n"),
    );
  });

  it("drops what is unknown with a minimal profile and only availability", () => {
    const r = buildInquiry(
      listing({ agencyInfo: null, agency: null, url: null, layout: null }),
      { ...DEFAULT_INQUIRY_PROFILE },
      { ...none, availability: true },
      null,
    );
    expect(r.subject).toBe("【お問い合わせ】サンハイツ草加（98,500円）");
    expect(r.body).toBe(
      [
        "ご担当者様",
        "",
        "はじめまして。",
        "貴社が掲載されている下記の物件について、お問い合わせいたします。",
        "",
        "■ 物件名：サンハイツ草加",
        "■ 所在地：埼玉県草加市松原1-1-1",
        "■ 賃料：98,500円（管理費・共益費込み）",
        "■ 間取り・面積：71.12㎡",
        "",
        "以下の点についてお教えいただけますでしょうか。",
        "",
        "1. 現在も募集中でしょうか。",
        "",
        "入居予定人数は2名（大人2名）です。",
        "",
        "お忙しいところ恐れ入りますが、ご返信いただけますと幸いです。",
        "何卒よろしくお願いいたします。",
      ].join("\n"),
    );
    expect(r.english).toContain("Subject: Inquiry - サンハイツ草加 (¥98,500)");
    expect(r.english).toContain("Number of occupants: 2 (2 adults).");
  });

  it("falls back to the first portal ad url when the listing has none", () => {
    const r = buildInquiry(
      listing({ url: null, sourceListings: [{ source: "suumo", id: "x", url: "https://suumo.test/x" }] }),
      full,
      none,
      null,
    );
    expect(r.body).toContain("■ 掲載ページ：https://suumo.test/x");
  });

  it("writes to UR itself, without the foreign-tenant question", () => {
    const r = buildInquiry(listing({ name: "URコンフォール松原", source: "ur", agencyInfo: null }), full, all, null);
    expect(r.body.split("\n").slice(0, 4)).toEqual([
      "UR都市機構 ご担当者様",
      "",
      "はじめまして。Jehandad Kamalと申します。",
      "貴機構が募集されている下記の住宅について、お問い合わせいたします。",
    ]);
    expect(r.body).not.toContain("外国籍");
    expect(r.body).toContain("2. 内見を希望しております。ご都合のよい日時をいくつかお教えいただけますでしょうか。");
    expect(r.body).toContain("3. 初期費用の概算（敷金・日割り家賃・共益費など）をお知らせください。");
    expect(r.english).not.toContain("foreign national");
  });

  it("words the viewing by date and time, date only, or not at all", () => {
    const line = (v: string | null) => buildInquiry(listing(), full, { ...none, viewing: true }, v).body.split("\n").find((l) => l.startsWith("1. "));
    expect(line("2026-12-05T10:00")).toBe("1. 内見を希望しております。12月5日（土）10時頃のご都合はいかがでしょうか。");
    expect(line("2026-12-06T09:05")).toBe("1. 内見を希望しております。12月6日（日）9時5分頃のご都合はいかがでしょうか。");
    expect(line("2026-12-07")).toBe("1. 内見を希望しております。12月7日（月）のご都合はいかがでしょうか。");
    expect(line(null)).toBe("1. 内見を希望しております。ご都合のよい日時をいくつかお教えいただけますでしょうか。");
    expect(line("garbage")).toBe("1. 内見を希望しております。ご都合のよい日時をいくつかお教えいただけますでしょうか。");
  });

  it("keeps the numbering consecutive when questions are off", () => {
    const r = buildInquiry(listing(), full, { ...all, availability: false, viewing: false, parking: false }, null);
    const numbered = r.body.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(numbered.map((l) => l.slice(0, 3))).toEqual(["1. ", "2. ", "3. "]);
    expect(numbered[0]).toContain("外国籍");
    expect(numbered[2]).toContain("入居可能時期");
    expect(r.subject.startsWith("【お問い合わせ】")).toBe(true);
  });

  it("words nationality and status, and the Japanese level", () => {
    const q = { ...none, foreignTenant: true };
    const line = (p: Partial<InquiryProfile>) => buildInquiry(listing(), { ...full, ...p }, q, null).body.split("\n").find((l) => l.startsWith("1. "));
    expect(line({ residenceStatus: "" })).toContain("外国籍（パキスタン国籍）ですが");
    expect(line({ nationality: "" })).toContain("外国籍（在留資格：永住者）ですが");
    expect(line({ nationality: "", residenceStatus: "" })).toContain("私は外国籍ですが");
    expect(line({ japanese: "fluent" })).toContain("日本語での会話・書類のやり取りに問題はございません。");
    expect(line({ japanese: "english-preferred" })).toContain("可能でしたら、英語でのご対応をお願いできますと幸いです。");
  });

  it("states a free-text move-in as typed and omits children when there are none", () => {
    const r = buildInquiry(listing(), { ...full, children: 0, moveIn: "来月中旬" }, none, null);
    expect(r.body).toContain("入居予定人数は2名（大人2名）、入居希望時期は来月中旬です。");
  });
});

describe("decodeInquiryProfile", () => {
  it("returns defaults for garbage", () => {
    for (const raw of [undefined, null, 5, "x", [], [1]]) expect(decodeInquiryProfile(raw)).toEqual(DEFAULT_INQUIRY_PROFILE);
  });

  it("keeps good fields and defaults the bad ones", () => {
    expect(decodeInquiryProfile({ name: "A", nationality: 3, japanese: "fluent", adults: "x", children: 1 })).toEqual({
      ...DEFAULT_INQUIRY_PROFILE,
      name: "A",
      japanese: "fluent",
      children: 1,
    });
    expect(decodeInquiryProfile({ japanese: "klingon" }).japanese).toBe("daily");
  });

  it("clamps out-of-range counts", () => {
    expect(decodeInquiryProfile({ adults: 0, children: -4 })).toMatchObject({ adults: 1, children: 0 });
    expect(decodeInquiryProfile({ adults: 40, children: 99 })).toMatchObject({ adults: 9, children: 9 });
    expect(decodeInquiryProfile({ adults: 2.6, children: Number.NaN })).toMatchObject({ adults: 3, children: 0 });
  });
});

describe("defaults", () => {
  it("switches on availability, foreign tenant, viewing and costs", () => {
    expect(DEFAULT_INQUIRY_QUESTIONS).toEqual({ availability: true, foreignTenant: true, viewing: true, initialCosts: true, parking: false, moveInDate: false });
  });
});
