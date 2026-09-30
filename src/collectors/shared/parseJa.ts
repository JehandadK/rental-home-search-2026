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
 * Sums every yen amount in a free-text fee blob, e.g.
 * "退去時クリーニング費用￥90000が契約時必要。…更新事務手数料22000円/鍵セット費3300円"
 * → 115300. Amounts marked as monthly (月額/毎月) are excluded.
 */
export function sumOneOffFees(text: string | undefined | null): number | null {
  if (!text || isExplicitNone(text)) return null;
  const t = toHalfWidth(text);
  let total = 0;
  let found = false;
  // Split on separators so each clause can be judged monthly vs one-off.
  for (const clause of t.split(/[。、,/]|\s{2,}/)) {
    if (/月額|毎月|\/月|月々/.test(clause)) continue;
    for (const m of matchAmounts(clause)) {
      total += m;
      found = true;
    }
  }
  return found ? total : null;
}

/**
 * Every yen amount in a clause. Sites write amounts either suffixed
 * ("22000円", "8.5万円") or prefixed ("￥90000" with no 円 at all), so both
 * shapes are matched.
 */
function* matchAmounts(clause: string): Generator<number> {
  const suffixed = /([\d,]+(?:\.\d+)?)\s*(万円|円)/g;
  const seen: [number, number][] = [];
  for (const m of clause.matchAll(suffixed)) {
    const value = parseFloat(m[1].replace(/,/g, ""));
    seen.push([m.index, m.index + m[0].length]);
    yield m[2] === "万円" ? Math.round(value * 10_000) : Math.round(value);
  }
  // ¥-prefixed amounts that were not already counted by the suffixed pass.
  for (const m of clause.matchAll(/[￥¥]\s*([\d,]+(?:\.\d+)?)\s*(万)?/g)) {
    const start = m.index;
    if (seen.some(([from, to]) => start >= from - 1 && start < to)) continue;
    const value = parseFloat(m[1].replace(/,/g, ""));
    yield m[2] === "万" ? Math.round(value * 10_000) : Math.round(value);
  }
}

/** Sums monthly-marked amounts, e.g. "ruumサポート費用（月額）1980円" → 1980. */
export function sumMonthlyExtras(text: string | undefined | null): number | null {
  if (!text || isExplicitNone(text)) return null;
  const t = toHalfWidth(text);
  let total = 0;
  let found = false;
  for (const clause of t.split(/[。、,/]|\s{2,}/)) {
    if (!/月額|毎月|\/月|月々/.test(clause)) continue;
    // Percentages are rent-relative, not fixed yen — skip them.
    if (/[\d.]+\s*[%％]/.test(clause)) continue;
    for (const m of matchAmounts(clause)) {
      total += m;
      found = true;
    }
  }
  return found ? total : null;
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
