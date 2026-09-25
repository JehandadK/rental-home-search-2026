/**
 * Prints the top-scoring listings under the default config — a quick
 * CLI companion to the web UI ("judge what is best for us").
 *
 * Run with: npm run rank [-- -n 20]
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config/scoring";
import { scoreListing } from "../src/domain/scoring";
import { isNewListing, isSold } from "../src/domain/lifecycle";
import type { EnrichedListing } from "../src/types";

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "listings.json");

const nFlagIndex = process.argv.indexOf("-n");
const topN = nFlagIndex >= 0 ? Math.max(1, parseInt(process.argv[nFlagIndex + 1], 10) || 15) : 15;

/** `--bike` scores distances at cycling speed instead of walking speed. */
const byBicycle = process.argv.includes("--bike");
const CONFIG = byBicycle
  ? { ...DEFAULT_CONFIG, travelMode: "bicycle" as const }
  : DEFAULT_CONFIG;

const listings = JSON.parse(await readFile(DATA_FILE, "utf-8")) as EnrichedListing[];

const ranked = listings
  .map((l) => ({ l, s: scoreListing(l, CONFIG) }))
  .filter((x) => x.s.total != null)
  .sort((a, b) => (b.s.total ?? 0) - (a.s.total ?? 0));

const yen = new Intl.NumberFormat("ja-JP");
const row = (r: (typeof ranked)[number], i: number) => {
  const { l, s } = r;
  const score = (s.total ?? 0).toFixed(1).padStart(5);
  const rent = `¥${yen.format(l.rent)}`.padStart(9);
  const size = `${l.sizeM2 ?? "?"}㎡`.padStart(8);
  const layout = (l.layout ?? "?").padEnd(5);
  const city = (l.city ?? "?").slice(0, 9).padEnd(9);
  const flags = `${isSold(l) ? " SOLD" : ""}${isNewListing(l) ? " NEW" : ""}`;
  const minutes = (key: "poi1" | "poi2" | "station") =>
    `${s.parts.find((p) => p.key === key)?.value?.toFixed(0) ?? "?"}m`;
  const stationName = l.station?.name ?? l.advertisedStation ?? "?";
  const stn = `${stationName} ${minutes("station")}`;
  const alSanad = minutes("poi1");
  const masjid = minutes("poi2");
  return `${String(i + 1).padStart(3)}. ${score} ${city} ${rent} ${size} ${layout} ${l.name.slice(0, 22).padEnd(22)} ${stn.padEnd(16)} alSanad:${alSanad.padEnd(6)} masjid:${masjid}${flags}`;
};

console.log(
  `Top ${topN} of ${ranked.length} listings ` +
    `(default weights, ${byBicycle ? "🚲 bicycle" : "🚶 walking"} distances)\n`,
);
ranked.slice(0, topN).forEach((r, i) => console.log(row(r, i)));

const scored = ranked.map((r) => r.s.total ?? 0);
console.log(
  `\nScore distribution: max ${Math.max(...scored).toFixed(1)}, ` +
    `median ${scored[Math.floor(scored.length / 2)].toFixed(1)}, ` +
    `min ${Math.min(...scored).toFixed(1)}`,
);
