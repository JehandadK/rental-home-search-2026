/**
 * Parsers for the Japanese text used on rental listing sites.
 *
 * Listing sites mix full-width and half-width digits, use 万円 units, and
 * write "no charge" as －, なし or 無. Everything here returns:
 *   number  — a definite amount
 *   0       — the source explicitly said there is no charge
 *   null    — the source did not say (unknown ≠ free)
 */

import { toHalfWidth } from "../../domain/japaneseText";
import { parseFeeNotes, sumFees } from "../../domain/feeNotes";
export { toHalfWidth, parseFloors } from "../../domain/japaneseText";

const NONE_MARKERS = ["-", "－", "ー", "なし", "無", "無し", "不要"];

/** Wording that means the item is provided at no charge (≠ "not stated"). */
const FREE_MARKERS = /無料|フリー|賃料に含|含む|込み|込/;

/**
 * True when the cell explicitly means "no such charge".
 * Sites write this as "－" but also "－円" / "なし円", so a trailing 円 is
 * stripped before matching.
 */
export function isExplicitNone(text: string): boolean {
  const t = toHalfWidth(text).trim().replace(/円$/, "").trim();
  return t !== "" && NONE_MARKERS.includes(t);
}

/**
 * "8.5万円" → 85000 · "3,500円" → 3500 · "－" → 0 · "" → null
 * Returns the first amount found in the string.
 *
 * Note: "－" is treated as an explicit zero. That is correct for fields the
 * site always prints (敷金/礼金/管理費), but for optional fields such as
 * 更新料 a dash usually means "not stated" — use `parseYenStrict` there.
 */
export function parseYen(text: string | undefined | null): number | null {
  if (text == null) return null;
  const t = toHalfWidth(text);
  if (isExplicitNone(t)) return 0;
  // "付無料", "賃料に含む" → provided, costs nothing extra.
  if (FREE_MARKERS.test(t) && !/\d/.test(t)) return 0;
  const man = t.match(/([\d.]+)\s*万円/);
  if (man) return Math.round(parseFloat(man[1]) * 10_000);
  const yen = t.match(/([\d,]+)\s*円/);
  if (yen) return parseInt(yen[1].replace(/,/g, ""), 10);
  return null;
}

/**
 * Like `parseYen`, but a dash means "the site did not say" rather than zero.
 * Use for fields that are frequently omitted (更新料, 保証金).
 */
export function parseYenStrict(text: string | undefined | null): number | null {
  if (text == null) return null;
  const t = toHalfWidth(text);
  if (isExplicitNone(t)) return null;
  return parseYen(t);
}

/** "8.5万円 / 8.5万円" → { deposit, keyMoney }; each side may be none/unknown. */
export function parseDepositKeyMoney(text: string | undefined | null): {
  depositYen: number | null;
  keyMoneyYen: number | null;
} {
  if (!text) return { depositYen: null, keyMoneyYen: null };
  const [left, right] = toHalfWidth(text).split("/");
  return { depositYen: parseYen(left ?? null), keyMoneyYen: parseYen(right ?? null) };
}

/** "定期借家 2年" → { leaseType: "fixed-term", leaseMonths: 24 } */
export function parseLease(text: string | undefined | null): {
  leaseType: "regular" | "fixed-term" | null;
  leaseMonths: number | null;
} {
  if (!text) return { leaseType: null, leaseMonths: null };
  const t = toHalfWidth(text);
  const fixed = /定期借家|定borrow|定期建物賃貸借/.test(t);
  const years = t.match(/(\d+(?:\.\d+)?)\s*年/);
  const months = t.match(/(\d+)\s*[ヶケか]?月/);
  const leaseMonths = years
    ? Math.round(parseFloat(years[1]) * 12)
    : months
      ? parseInt(months[1], 10)
      : null;
  const leaseType = fixed ? "fixed-term" : leaseMonths !== null || t.includes("普通") ? "regular" : null;
  return { leaseType, leaseMonths };
}

/**
 * One-off charges in a free-text fee blob: signing fees plus any stated
 * move-out cleaning, e.g.
 * "退去時クリーニング費用￥90000が契約時必要。…更新事務手数料22000円/鍵セット費3300円"
 * → 93300. Monthly, renewal, conditional and already-modelled charges are
 * left out; see `parseFeeNotes`.
 */
export function sumOneOffFees(text: string | undefined | null): number | null {
  if (!text || isExplicitNone(text)) return null;
  const fees = parseFeeNotes(text);
  const total = sumFees(fees.signing) + (fees.cleaningYen ?? 0);
  return total > 0 ? total : null;
}

/** Monthly charges outside rent, e.g. "ruumサポート費用（月額）1980円" → 1980. */
export function sumMonthlyExtras(text: string | undefined | null): number | null {
  if (!text || isExplicitNone(text)) return null;
  const total = sumFees(parseFeeNotes(text).monthly);
  return total > 0 ? total : null;
}

/** 保証会社: "必加入備考:…" → true · "不要" → false · "" → null */
export function parseGuarantorRequired(text: string | undefined | null): boolean | null {
  if (!text) return null;
  const t = toHalfWidth(text);
  if (/不要|なし/.test(t)) return false;
  if (/必[加要]|必須|利用必/.test(t)) return true;
  return null;
}

/** Splits "バストイレ別、バルコニー、…" into trimmed tags. */
export function splitTags(text: string | undefined | null): string[] | null {
  if (!text || isExplicitNone(text)) return null;
  const tags = toHalfWidth(text)
    .split(/[、,/]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "" && !NONE_MARKERS.includes(tag));
  return tags.length > 0 ? tags : null;
}

/** True when the ad says the unit is available now. */
export function parseImmediate(text: string | undefined | null): boolean | null {
  if (!text) return null;
  const t = toHalfWidth(text).trim();
  if (t === "即" || /即入居可|すぐ入居/.test(t)) return true;
  return t === "" ? null : false;
}
