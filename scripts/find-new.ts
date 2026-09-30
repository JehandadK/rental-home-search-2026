/**
 * Report newly discovered active listings under the app's scoring parameters.
 *
 * Defaults to the app's default weights and a 14-day NEW window. Optional
 * hard gates answer "within our parameters" without re-fetching anything:
 *
 *   npm run find:new
 *   npm run find:new -- --min-score 45 --max-rent 130000 --min-size 45 -n 30
 *   npm run find:new -- --bike --parking required
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/domain/scoringConfig";
import { isNewListing, isSold } from "../src/domain/lifecycle";
import { parkingInfo } from "../src/domain/moveInCost";
import { scoreListing } from "../src/domain/scoring";
import type { EnrichedListing } from "../src/domain/types";

const argv = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const number = (flag: string, fallback: number): number => {
  const raw = value(flag);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const topN = Math.max(1, number("-n", number("--limit", 25)));
const minScore = number("--min-score", 0);
const maxRent = number("--max-rent", Number.POSITIVE_INFINITY);
const minSize = number("--min-size", 0);
const parking = value("--parking") ?? "any";
const source = value("--source");
const todayOnly = argv.includes("--today");
if (!["any", "required", "free"].includes(parking)) {
  throw new Error("--parking must be any, required, or free");
}

const dataFile = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "listings.json");
const listings = JSON.parse(await readFile(dataFile, "utf8")) as EnrichedListing[];
const config = argv.includes("--bike")
  ? { ...DEFAULT_CONFIG, travelMode: "bicycle" as const }
  : DEFAULT_CONFIG;

const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
const fresh = listings.filter((listing) => {
  if (isSold(listing) || !isNewListing(listing)) return false;
  if (source && listing.source !== source) return false;
  if (todayOnly && (!listing.firstSeenAt || Date.parse(listing.firstSeenAt) < todayStart.getTime())) return false;
  return true;
});
const rows = fresh
  .map((listing) => ({ listing, score: scoreListing(listing, config) }))
  .filter(({ listing, score }) => {
    if ((score.total ?? -1) < minScore) return false;
    if (listing.rent > maxRent || (listing.sizeM2 ?? -1) < minSize) return false;
    const p = parkingInfo(listing);
    // Unknown parking is retained, matching the UI's conservative semantics.
    if (parking === "required" && p && !p.available) return false;
    if (parking === "free" && p && (!p.available || (p.monthlyYen ?? 0) > 0)) return false;
    return true;
  })
  .sort((a, b) => (b.score.total ?? -1) - (a.score.total ?? -1));

const yen = new Intl.NumberFormat("ja-JP");
console.log(
  `${rows.length} of ${fresh.length} ${todayOnly ? "TODAY'S NEW" : "NEW"} active listings match` +
    `${source ? ` from ${source}` : ""}` +
    ` (score ≥${minScore}, rent ≤${Number.isFinite(maxRent) ? `¥${yen.format(maxRent)}` : "any"},` +
    ` size ≥${minSize || "any"}㎡, parking ${parking}, ${config.travelMode})\n`,
);

for (const [i, { listing, score }] of rows.slice(0, topN).entries()) {
  const part = (key: string) => score.parts.find((p) => p.key === key)?.value;
  const p = parkingInfo(listing);
  const parkingText = !p
    ? "?"
    : !p.available
      ? "none"
      : p.monthlyYen == null
        ? "available, price ?"
        : p.monthlyYen === 0
          ? "free"
          : `¥${yen.format(p.monthlyYen)}`;
  console.log(
    `${String(i + 1).padStart(2)}. ${(score.total ?? 0).toFixed(1).padStart(5)}  ` +
      `${listing.city?.padEnd(9) ?? "?        "} ¥${yen.format(listing.rent).padStart(7)}  ` +
      `${String(listing.sizeM2 ?? "?").padStart(5)}㎡ ${String(listing.layout ?? "?").padEnd(5)} ` +
      `${listing.name}\n` +
      `    station ${Math.round(part("station") ?? 0)}m · Al Sanad ${Math.round(part("poi1") ?? 0)}m` +
      ` · Masjid ${Math.round(part("poi2") ?? 0)}m · parking ${parkingText}` +
      `${listing.url ? `\n    ${listing.url}` : ""}`,
  );
}

if (rows.length > topN) console.log(`\n…${rows.length - topN} more; raise -n to show them.`);
