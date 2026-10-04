/**
 * The portals' own listing dates (情報公開日 / 情報更新日 / 次回更新日), read
 * from any captured text: a detail table row (`情報更新日` → `2026/9/28`) or
 * free text (`情報公開日：2026/08/29 次回更新日：2026/09/06`). Dates are the
 * portal's calendar dates in Japan, kept as `YYYY-MM-DD`.
 */
export interface PortalListingDates {
  /** 情報公開日 / 物件公開日 / 掲載開始日 / 掲載日 / 登録日 — first published on the portal. */
  publishedOn?: string;
  /** 情報更新日 / 最終更新日 / 更新日 — the ad was last refreshed. */
  updatedOn?: string;
  /** 次回更新日 / 次回更新予定日 — the portal's next scheduled refresh. */
  nextUpdateOn?: string;
}

const DATE = String.raw`(\d{4})\s*[/年.\-]\s*(\d{1,2})\s*[/月.\-]\s*(\d{1,2})\s*日?`;
const SEP = String.raw`\s*[:：]?\s*`;
const PATTERNS: [keyof PortalListingDates, RegExp][] = [
  ["publishedOn", new RegExp(`(?:情報公開日|物件公開日|掲載開始日|掲載日|登録日)${SEP}${DATE}`)],
  ["nextUpdateOn", new RegExp(`次回更新(?:予定)?日${SEP}${DATE}`)],
  ["updatedOn", new RegExp(`(?<!次回)(?:情報|最終)?更新日${SEP}${DATE}`)],
];

const isoDate = (y: string, m: string, d: string): string | undefined => {
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Dates found in `text`; the first match of each label wins. */
export function parsePortalListingDates(text: string): PortalListingDates {
  const normalized = text.normalize("NFKC");
  const dates: PortalListingDates = {};
  for (const [field, pattern] of PATTERNS) {
    const match = pattern.exec(normalized);
    const iso = match && isoDate(match[1], match[2], match[3]);
    if (iso) dates[field] = iso;
  }
  return dates;
}

/** Dates from a detail table (label → value rows) plus any free text. */
export function portalListingDatesFrom(details: Record<string, string> | undefined, ...texts: (string | null | undefined)[]): PortalListingDates {
  const rows = Object.entries(details ?? {}).map(([label, value]) => `${label}：${value}`);
  return parsePortalListingDates([...rows, ...texts.filter(Boolean)].join("\n"));
}
