/**
 * Charges buried in a listing's free-text fee notes (その他費用 / ほか初期費用 /
 * 備考), itemised so they can be costed honestly:
 *
 *   signing  — one-off money paid to move in that never comes back:
 *              鍵交換代, 消臭・除菌, 抗菌施工, 防災セット, 契約事務手数料 …
 *   cleaning — a stated move-out cleaning fee (退去時クリーニング). It replaces
 *              the estimated cleaning fee rather than adding to it; wording
 *              such as "クリーニング費用不要" states it as zero.
 *   monthly  — recurring charges outside rent (サポート月額1,320円, 保証料 …).
 *
 * Deliberately left out, because they are not part of moving in or are
 * already costed elsewhere: renewal charges (更新…), penalties (違約金),
 * conditional extras (ペット飼育の場合 …), minimum/alternative rates, and the
 * items `computeMoveInCosts` already models (敷金, 礼金, 仲介手数料, 保証会社
 * initial fee, 火災保険, parking).
 *
 * Amounts keep their thousands separators: "鍵交換代27，500円" is ¥27,500,
 * not ¥500 — the bug that made the stored `oneOffFeesYen` unreliable.
 */

export interface FeeItem {
  /** The words in front of the amount, as written (trimmed). */
  label: string;
  yen: number;
}

export interface FeeNoteCharges {
  /** True when the text contains any yen amount at all. */
  hasAmounts: boolean;
  signing: FeeItem[];
  monthly: FeeItem[];
  /** Stated move-out cleaning fee; 0 when stated as not required; null when not stated. */
  cleaningYen: number | null;
}

const NONE: FeeNoteCharges = { hasAmounts: false, signing: [], monthly: [], cleaningYen: null };

/** Splits the text into clauses. A comma between digits is a thousands separator, not a break. */
const CLAUSE_BREAK = /[。◆※、;；\n]|\/(?!月)|,(?!\d{3}(?!\d))|\s{2,}/g;
/** What trails an amount and belongs to it: "円～(税込)/月)". The next item starts after it. */
const AMOUNT_TAIL = /^\s*(?:万?円)?\s*[~～]?\s*(?:税込|税別)?(?:\s*\([^()]{1,6}\))*\s*(?:\/月額?|月額)?\s*[)\]】]?/;

/** 22,000円 · 8.5万円 · 33000円～ · ¥90000 */
const AMOUNT = /¥\s*(\d{1,3}(?:,\d{3})+|\d+)|(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(万円|円)/g;

const MONTHLY = /月額|毎月|月々|月払|ヶ月毎|\/月/;
/** Immediately after an amount: "円(税込)/月", "円/月額". */
const MONTHLY_AFTER = /^\s*(?:万?円)?\s*(?:\(税込\)|\(税別\)|税込|税別)?\s*(?:\/月|月額|\(月額\))/;
/** Conditional or alternative amounts — never a cost you will certainly pay. */
const CONDITIONAL = /場合|飼育|ペット|賃料\s*\+|最低|クレジット|割引|キャンペーン|フリーレント|違約|解約|売電|返金|返還|任意|希望/;
/** Not part of moving in, or already costed by computeMoveInCosts. */
const NOT_SIGNING = /更新|浄化槽|敷金|礼金|敷引|仲介|保証|保険|駐車|車庫|自治会|町会/;
/** Words that name a charge: 代, 費, 料, 金, セット, サポート. */
const FEE_NOUN = /[代費料金]|セット|サポート/;
/** A rate, not an amount: "1375円/平方メートル". */
const PER_UNIT = /^\s*円?\s*\/\s*(?:平方メートル|m2|m²|坪)/;
/** Yearly charges fall outside both one-off and monthly costs. */
const YEARLY = /年毎|毎年|年額|年払/;
const CLEANING = /クリーニング|清掃/;
const CLEANING_NONE = /(?:クリーニング|清掃)[^。◆※\/]{0,10}(?:不要|なし|無し|無料)/;

const cache = new Map<string, FeeNoteCharges>();

/** Itemise one fee-notes text. Pure; results are cached per distinct text. */
export function parseFeeNotes(text: string | null | undefined): FeeNoteCharges {
  if (!text) return NONE;
  const cached = cache.get(text);
  if (cached) return cached;
  const parsed = parse(text);
  cache.set(text, parsed);
  return parsed;
}

function parse(raw: string): FeeNoteCharges {
  const text = raw.normalize("NFKC").replace(/　/g, " ");
  const breaks = [...text.matchAll(CLAUSE_BREAK)].map((m) => m.index + m[0].length);
  const signing: FeeItem[] = [];
  const monthly: FeeItem[] = [];
  let cleaning: number | null = null;
  let hasAmounts = false;
  let previousEnd = 0;

  for (const m of text.matchAll(AMOUNT)) {
    hasAmounts = true;
    const digits = (m[1] ?? m[2]).replace(/,/g, "");
    const yen = Math.round(parseFloat(digits + (m[3] ?? "")) * (m[4] === "万円" ? 10_000 : 1));
    const end = m.index + m[0].length;
    const after = text.slice(end);
    const start = Math.max(breaks.filter((b) => b <= m.index).pop() ?? 0, previousEnd);
    previousEnd = end + (after.match(AMOUNT_TAIL)?.[0].length ?? 0);
    let before = text.slice(start, m.index);
    // "鍵交換代任意、22000円": a bare amount belongs to the clause before it.
    // Step back (at most three clauses) until the context names a charge.
    if (cleanLabel(before) === "fee") {
      for (let back = start, steps = 0; !FEE_NOUN.test(before) && back > 0 && steps < 3; steps++) {
        back = breaks.filter((b) => b < back).pop() ?? 0;
        before = text.slice(back, m.index);
      }
    }
    if (!(yen > 0) || PER_UNIT.test(after)) continue;
    if (CONDITIONAL.test(before) || YEARLY.test(before)) continue;

    const item = { label: cleanLabel(before), yen };
    if (MONTHLY.test(before) || MONTHLY_AFTER.test(after)) {
      if (!/駐車|更新/.test(before)) monthly.push(item);
    }
    else if (NOT_SIGNING.test(before)) continue;
    else if (CLEANING.test(before)) cleaning = (cleaning ?? 0) + yen;
    else signing.push(item);
  }

  if (cleaning == null && CLEANING_NONE.test(text)) cleaning = 0;
  if (!hasAmounts && cleaning == null) return NONE;
  return { hasAmounts, signing, monthly, cleaningYen: cleaning };
}

/** "備考:※ 鍵交換費用【" → "鍵交換費用" · "鍵交換代:あり" → "鍵交換代" */
function cleanLabel(before: string): string {
  const pieces = before
    .split(/[:：]/)
    .map((piece) => piece.replace(/[\s【(\[「~～・)\]】」※]+$/, "").replace(/^[\s・)\]】」※]+/, "").trim())
    .map((piece) => piece.replace(/^.*】/, "").replace(/^(?:[\w-]*\d[\w-]*\s+)+/, "").replace(/\s*(?:\(?月額|\/月)$/, "").trim())
    .filter((piece) => piece !== "" && !/^(?:備考|あり|有|要|加入要)$/.test(piece));
  const label = pieces.pop() ?? "fee";
  return label.length > 24 ? `…${label.slice(-23)}` : label;
}

export const sumFees = (items: readonly FeeItem[]): number => items.reduce((sum, { yen }) => sum + yen, 0);
