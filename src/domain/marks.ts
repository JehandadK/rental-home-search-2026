/**
 * Decision marks: the user's own per-listing labels — shortlisted, applied,
 * already taken, not interested, no foreigners. They answer "what did I
 * decide about this property?" at a glance, so ruled-out homes stop
 * cluttering the search and narrowed-down candidates stand out.
 *
 * Marks are user state, not listing data: they live in their own
 * user-state store (see web/userState/), keyed by listingKey. The key
 * prefers the stable source id, so marks survive scrapes and data rebuilds.
 */

/** A decision the user has made about a listing. */
export type ListingMark =
  | "shortlisted"
  | "applied"
  | "taken"
  | "not-interested"
  | "no-foreigners";

/** Marks keyed by listingKey. An absent key means "no decision yet". */
export type MarkMap = Record<string, ListingMark>;

export interface MarkMeta {
  key: ListingMark;
  label: string;
  labelJa: string;
  icon: string;
  /**
   * positive — a candidate worth pursuing (shortlisted, applied)
   * negative — ruled out (taken, not interested, no foreigners)
   */
  tone: "positive" | "negative";
}

/** Every mark, in dropdown display order: candidates first, then ruled out. */
export const LISTING_MARKS: readonly MarkMeta[] = [
  { key: "shortlisted", label: "Shortlisted", labelJa: "候補", icon: "★", tone: "positive" },
  { key: "applied", label: "Applied", labelJa: "申込済", icon: "📨", tone: "positive" },
  { key: "taken", label: "Already taken", labelJa: "成約済", icon: "🔒", tone: "negative" },
  { key: "not-interested", label: "Not interested", labelJa: "見送り", icon: "👎", tone: "negative" },
  { key: "no-foreigners", label: "No foreigners", labelJa: "外国人不可", icon: "🚫", tone: "negative" },
];

const META: Record<ListingMark, MarkMeta> = Object.fromEntries(
  LISTING_MARKS.map((meta) => [meta.key, meta]),
) as Record<ListingMark, MarkMeta>;

export function markMeta(mark: ListingMark | undefined): MarkMeta | null {
  return mark ? META[mark] : null;
}

/** True for marks that rule a listing out of consideration. */
export function isRuledOut(mark: ListingMark | undefined): boolean {
  return mark != null && META[mark].tone === "negative";
}

/**
 * How decision marks narrow the listing set:
 *   all          — show everything (default)
 *   hideRuledOut — drop listings already ruled out; the day-to-day view
 *   shortlist    — only the candidates (shortlisted / applied)
 *   unmarked     — only listings with no decision yet (triage mode)
 *   ruledOut     — only ruled-out listings, to review past decisions
 */
export type MarkFilter = "all" | "hideRuledOut" | "shortlist" | "unmarked" | "ruledOut";

export const MARK_FILTERS: readonly { key: MarkFilter; label: string; hint: string }[] = [
  { key: "all", label: "all", hint: "Show listings regardless of decision marks" },
  {
    key: "hideRuledOut",
    label: "hide ruled out",
    hint: "Hide taken, not-interested and no-foreigners listings",
  },
  {
    key: "shortlist",
    label: "shortlist only",
    hint: "Only shortlisted or applied listings",
  },
  {
    key: "unmarked",
    label: "undecided only",
    hint: "Only listings you have not marked yet",
  },
  {
    key: "ruledOut",
    label: "ruled out only",
    hint: "Only ruled-out listings, to review past decisions",
  },
];

/** True when a listing with this mark passes the mark filter. */
export function matchesMarkFilter(mark: ListingMark | undefined, filter: MarkFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "hideRuledOut":
      return !isRuledOut(mark);
    case "shortlist":
      return mark != null && !isRuledOut(mark);
    case "unmarked":
      return mark == null;
    case "ruledOut":
      return isRuledOut(mark);
  }
}

/**
 * Sort rank for grouping by decision: candidates first, then undecided,
 * then ruled out. Ties are left to the caller (score is a good tiebreak).
 */
export function markRank(mark: ListingMark | undefined): number {
  if (mark == null) return 1;
  return isRuledOut(mark) ? 2 : 0;
}

/**
 * Headline counts over the marks of the current listing set (pass the mark
 * of each listing in turn; undefined for unmarked).
 */
export function summarizeMarks(marks: readonly (ListingMark | undefined)[]): {
  candidates: number;
  ruledOut: number;
  total: number;
} {
  let candidates = 0;
  let ruledOut = 0;
  for (const mark of marks) {
    if (mark == null) continue;
    if (isRuledOut(mark)) ruledOut++;
    else candidates++;
  }
  return { candidates, ruledOut, total: candidates + ruledOut };
}
