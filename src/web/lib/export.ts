/**
 * Export ranked results as CSV or Markdown for sharing / record-keeping.
 */
import { FEATURE_PARAMETERS, SCORE_PARAMETERS } from "../../domain/scoringConfig";
import { listingKey } from "../../domain/listingKey";
import { sourceListings as portalReferences } from "../../domain/listingDedup";
import type { MarkMap } from "../../domain/marks";
import type { ListingScore, ScoredRow } from "../../domain/scoring";

const partValue = (score: ListingScore, key: string) =>
  score.parts.find((p) => p.key === key)?.value ?? "";

const HEADERS = [
  "rank", "source", "status", "decision_mark", "first_seen_at", "name", "rent_jpy", "layout", "size_m2", "built_year",
  "rent_per_exclusive_m2_jpy",
  ...SCORE_PARAMETERS.filter((p) => !["rent", "rentPerM2", "size", "yearBuilt"].includes(p.key)).map(
    (p) => `${p.key}_value`,
  ),
  ...FEATURE_PARAMETERS.map((feature) => feature.key),
  "all_attributes_en_ja", "score", "url",
];

function rows(items: ScoredRow[], marks: MarkMap): (string | number)[][] {
  return items.map(({ listing, score }, i) => [
    i + 1,
    portalReferences(listing).map(({ source }) => source).join(" + "),
    listing.status ?? "active",
    marks[listingKey(listing)] ?? "",
    listing.firstSeenAt ?? "",
    listing.name,
    listing.rent,
    listing.layout ?? "",
    listing.sizeM2 ?? "",
    listing.builtYear ?? "",
    partValue(score, "rentPerM2"),
    ...SCORE_PARAMETERS.filter((p) => !["rent", "rentPerM2", "size", "yearBuilt"].includes(p.key)).map((p) =>
      partValue(score, p.key),
    ),
    ...FEATURE_PARAMETERS.map((feature) => {
      const value = partValue(score, feature.key);
      return value === 1 ? "yes" : value === 0 ? "no" : "unknown";
    }),
    (listing.attributes ?? []).map((attribute) =>
      `${attribute.labelEn} (${attribute.labelJa}):${attribute.state == null ? "info" : attribute.state ? "yes" : "no"}`,
    ).join("; "),
    score.total != null ? score.total.toFixed(1) : "",
    portalReferences(listing).map(({ url }) => url).filter(Boolean).join(" "),
  ]);
}

export function toCsv(items: ScoredRow[], marks: MarkMap = {}): string {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [HEADERS, ...rows(items, marks)].map((r) => r.map(escape).join(",")).join("\n");
}

export function toMarkdown(items: ScoredRow[], marks: MarkMap = {}): string {
  const header = "| " + HEADERS.join(" | ") + " |";
  const divider = "|" + HEADERS.map(() => " --- ").join("|") + "|";
  const body = rows(items, marks).map((r) => "| " + r.join(" | ") + " |");
  return [header, divider, ...body].join("\n");
}
