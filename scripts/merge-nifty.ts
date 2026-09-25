/**
 * Converts Nifty (myhome.nifty.com) detail-page scrapes into RawListing[]
 * and merges them into src/data/listings_raw.json.
 *
 * Input:  src/data/nifty_detail_raw.json  — detail pages captured through
 *         the logged-in browser session (see pi-web-ui bridge).
 * Output: src/data/sources/nifty.json     — this script owns that file and
 *         nothing else; SUUMO data is never touched.
 *
 * Run with: npm run import:nifty
 * Afterwards: npm run data:build && npm run enrich
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ShrinkGuardError, writeSource, readSource } from "./lib/dataStore";
import {
  parseDepositKeyMoney,
  parseFloors,
  parseGuarantorRequired,
  parseImmediate,
  parseLease,
  parseYen,
  parseYenStrict,
  splitTags,
  sumMonthlyExtras,
  sumOneOffFees,
} from "./lib/parseJa";
import type { RawListing } from "../src/types";
import { trackingKey } from "./lib/lifecycle";
import { parseParking } from "./lib/parking";
import { mergeNiftyIncremental, niftyMatchKeys } from "./lib/nifty";

const NIFTY_PATH = join(DATA_DIR, "nifty_detail_raw.json");

export interface NiftyDetail {
  capturedAt?: string;
  url: string;
  httpStatus?: number;
  h1?: string;
  kv?: Record<string, string>;
  error?: string;
}

interface NiftyDump {
  source: string;
  scrapedAt: string;
  listings: NiftyDetail[];
}

/** "8.5万円＋ 管理費等－円" → 85000 · "11.1万円＋ 管理費等3500円" → 114500 */
function parseRent(text: string): { rent: number | null; adminNote: string | null } {
  const base = text.match(/([\d.]+)万円/);
  const yen = text.match(/([\d,]+)円/);
  let rent: number | null = null;
  if (base) rent = Math.round(parseFloat(base[1]) * 10_000);
  else if (yen) rent = parseInt(yen[1].replace(/,/g, ""), 10);
  const admin = text.match(/管理費等\s*([\d,]+)円/);
  const adminYen = admin ? parseInt(admin[1].replace(/,/g, ""), 10) : 0;
  if (rent !== null) rent += adminYen;
  return { rent, adminNote: adminYen > 0 ? `管理費${adminYen}円込` : null };
}

/** "3LDK（専有面積：78.6㎡）" → { layout: "3LDK", sizeM2: 78.6 } */
function parseLayout(text: string): { layout: string | null; sizeM2: number | null } {
  const layout = text.split("（")[0]?.trim() || null;
  const size = text.match(/([\d.]+)㎡/);
  return { layout, sizeM2: size ? parseFloat(size[1]) : null };
}

/** "1979年1月" → 1979 · "新築" handled by caller if needed */
function parseBuiltYear(text: string): number | null {
  const m = text.match(/(\d{4})年/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Nifty's station cell sometimes gives distance instead of 徒歩分
 * ("草加駅 3.6km"). Convert with the Japanese walking convention so the
 * scorer does not discard useful agency data and fall back to coarse geocode.
 */
export function parseStationDistance(text: string): { station?: string; walkMin?: number } {
  const direct = parseStation(text);
  if (direct.station) return direct;
  const match = text.match(/([^\s/／]+駅)\s*([\d.]+)\s*km/i);
  if (!match) return {};
  return {
    station: normaliseStationName(match[1]),
    walkMin: Math.ceil((Number(match[2]) * 1000) / 80),
  };
}

/** "東武伊勢崎線/新田駅 歩7分" or "新田駅 歩6分\n （伊勢崎線）" → { station, walkMin } */
export function parseStation(text: string): { station?: string; walkMin?: number } {
  const m = text.match(/[/／]?\s*(.+?駅)\s*歩(\d+)分/);
  if (!m) return {};
  const station = normaliseStationName(m[1]);
  return { station, walkMin: parseInt(m[2], 10) };
}

/**
 * Reduces a station cell to the bare station name so it matches the naming
 * used by SUUMO entries and stations.json:
 *   "東武伊勢崎線/新田駅"                      → "新田駅"
 *   "利用可能駅（ニフティ不動産調べ）谷塚駅"        → "谷塚駅"
 */
export function normaliseStationName(raw: string): string {
  let name = raw.replace(/\s/g, "");
  // Drop the line prefix (東武伊勢崎線/…) and any leading boilerplate.
  name = name.split(/[/／]/).pop() ?? name;
  name = name.replace(/^.*?調べ）/, "").replace(/^利用可能駅/, "");
  return name;
}

/** First non-empty line of a scraped cell, e.g. "即\n\n質問…" → "即". */
function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/** Page H1: "日商岩井草加マンション 新田駅より徒歩7分 （…） 4階 3LDKの賃貸物件…" → building name */
function parseName(h1: string): string {
  return h1.split(/\s+\S+駅より/)[0]?.trim() ?? h1.trim();
}

/** URL …/detail_<hash>/ → "nifty-<hash>" */
function parseId(url: string): string | null {
  const m = url.match(/detail_([a-f0-9]+)/i);
  return m ? `nifty-${m[1]}` : null;
}

/** The agency name is the only kv key that is not a fixed label. */
const KNOWN_LABELS = new Set([
  "その他の情報", "バルコニー面積", "リフォーム", "交通", "交通機関", "保証会社", "保証金",
  "入居可能時期", "取引態様", "契約期間", "建物構造", "所在地", "敷金/礼金", "更新料",
  "条件等", "築年月", "設備", "賃料", "間取り", "間取り詳細(帖)", "階数/階建", "駐車場",
]);

function parseAgency(kv: Record<string, string>): string | null {
  const label = Object.keys(kv).find((k) => !KNOWN_LABELS.has(k));
  return label ?? null;
}

export function toRawListing(detail: NiftyDetail): RawListing | null {
  if (detail.error || !detail.kv || (detail.httpStatus != null && detail.httpStatus !== 200)) return null;
  const kv = detail.kv;
  const { rent, adminNote } = parseRent(kv["賃料"] ?? "");
  const { layout, sizeM2 } = parseLayout(kv["間取り"] ?? "");
  // 交通機関 (agency-stated) wins; 交通 (Nifty reference) is the fallback.
  const station =
    parseStationDistance(kv["交通機関"] ?? "").station !== undefined
      ? parseStationDistance(kv["交通機関"] ?? "")
      : parseStationDistance(kv["交通"] ?? "");

  const moveIn = firstLine(kv["入居可能時期"]);
  const parking = firstLine(kv["駐車場"]);
  const noteParts = [
    firstLine(kv["階数/階建"]),
    firstLine(kv["建物構造"]),
    firstLine(kv["契約期間"]) && firstLine(kv["契約期間"]) !== "－"
      ? `契約:${firstLine(kv["契約期間"]).replace(/\s/g, "")}`
      : null,
    moveIn === "即" ? "即入居可" : moveIn ? `入居:${moveIn}` : null,
    firstLine(kv["敷金/礼金"]) ? `敷礼:${firstLine(kv["敷金/礼金"])}` : null,
    firstLine(kv["条件等"]) && firstLine(kv["条件等"]) !== "－" ? firstLine(kv["条件等"]) : null,
    parking && parking !== "－" ? `駐車場:${parking}` : null,
    adminNote,
  ].filter((p): p is string => Boolean(p && p !== "－"));

  // Detail cells can contain inquiry-button text after the actual value.
  // Parse only the first line so "無 / 無\n質問…" remains an explicit zero
  // rather than turning the second 無 into unknown.
  const { depositYen, keyMoneyYen } = parseDepositKeyMoney(firstLine(kv["敷金/礼金"]));
  const { leaseType, leaseMonths } = parseLease(kv["契約期間"] ?? kv["その他の情報"]);
  const { floor, totalFloors } = parseFloors(kv["階数/階建"]);
  const otherInfo = kv["その他の情報"];

  const address = kv["所在地"] ?? "";
  return {
    id: parseId(detail.url),
    name: parseName(detail.h1 ?? ""),
    address,
    city: address.includes("越谷市")
      ? "Koshigaya"
      : address.includes("草加市")
        ? "Soka"
        : address.includes("川口市")
          ? "Kawaguchi"
          : undefined,
    rent: rent ?? 0,
    layout,
    sizeM2,
    builtYear: parseBuiltYear(kv["築年月"] ?? ""),
    advertisedStation: station.station ?? null,
    stationWalkMin: station.walkMin ?? null,
    url: detail.url,
    source: "nifty",
    notes: noteParts.join("・"),
    agency: parseAgency(kv),
    sourceDetails: kv,
    parking: parking && !/^[－-]$/.test(parking) ? parseParking(parking) : undefined,
    costs: {
      depositYen,
      keyMoneyYen,
      adminFeeYen: parseYen(kv["賃料"]?.split("管理費等")[1] ?? null),
      parkingYen: parseYen(firstLine(kv["駐車場"])),
      // 更新料 is often simply omitted, so a dash must not read as "free".
      renewalFeeYen: parseYenStrict(kv["更新料"]),
      oneOffFeesYen: sumOneOffFees(otherInfo),
      monthlyExtrasYen: sumMonthlyExtras(otherInfo),
      guarantorRequired: parseGuarantorRequired(kv["保証会社"]),
      feeNotes: otherInfo && otherInfo !== "－" ? otherInfo : null,
    },
    tenancy: {
      leaseType,
      leaseMonths,
      availableFrom: firstLine(kv["入居可能時期"]) || null,
      immediateMoveIn: parseImmediate(firstLine(kv["入居可能時期"])),
    },
    building: {
      floor,
      totalFloors,
      structure: firstLine(kv["建物構造"]) || null,
      features: splitTags(kv["設備"]),
      conditions: splitTags(firstLine(kv["条件等"])),
    },
  };
}

async function main(): Promise<void> {
  const dump = JSON.parse(await readFile(NIFTY_PATH, "utf8")) as NiftyDump;
  const converted = dump.listings
    .map(toRawListing)
    .filter((l): l is RawListing => {
      if (l === null || l.address === "" || l.rent <= 0) return false;
      // Keep the source aligned with SUUMO and AtHome: family layouts only.
      const rooms = l.layout?.normalize("NFKC").match(/^(\d+)/)?.[1];
      return rooms != null && Number(rooms) >= 2;
    });

  const skipped = dump.listings.length - converted.length;
  const previous = await readSource("nifty");
  const existingAliases = new Map((previous?.listings ?? []).flatMap((l) => niftyMatchKeys(l).map((key) => [key, l] as const)));
  const priorTimes = (previous?.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const detailsByUrl = new Map(dump.listings.map((d) => [d.url, d]));
  const eligible = converted.filter((l) => {
    const prior = niftyMatchKeys(l).map((k) => existingAliases.get(k)).find(Boolean);
    if (!prior) return true;
    const at = detailsByUrl.get(l.url!)?.capturedAt;
    return at != null && at > (priorTimes[trackingKey(prior)] ?? previous?.scrapedAt ?? "");
  });
  const merged = mergeNiftyIncremental(previous?.listings ?? [], eligible);
  const { path, previousCount } = await writeSource(
    {
      source: "nifty",
      scrapedAt: [previous?.scrapedAt ?? "", dump.scrapedAt ?? ""].sort().at(-1) || new Date().toISOString(),
      // The merge capture adds newly seen pages but preserves prior detail
      // records; it is discovery data, not proof that every old ad is live.
      completeSnapshot: false,
      provenance: {
        ...previous?.provenance,
        capturedBy: "logged-in browser session via Pi Control Chrome",
        detailPages: dump.listings.length,
        familyListings: converted.length,
        // Legacy captures without per-page timestamps are NOT observed today.
        observedTrackingKeys: eligible.filter((l) => detailsByUrl.get(l.url!)?.capturedAt).map(trackingKey),
        observedAtByKey: { ...priorTimes, ...Object.fromEntries(eligible.flatMap((l) => {
          const at = detailsByUrl.get(l.url!)?.capturedAt; return at ? [[trackingKey(l), at]] : [];
        })) },
        input: "src/data/nifty_detail_raw.json",
      },
      listings: merged.listings,
    },
    { force: process.argv.includes("--force") },
  );

  const delta = previousCount ? ` (was ${previousCount})` : "";
  console.log(`Wrote ${merged.listings.length} nifty listings${delta} to ${path}; ${merged.added} added, ${merged.updated} newer detail updates` + (skipped ? `, ${skipped} skipped` : ""));
  if (process.argv.includes("--verbose")) for (const l of converted) {
    console.log(`  ${l.name} — ¥${l.rent.toLocaleString()} ${l.layout} ${l.sizeM2}㎡`);
  }
  console.log(`\nNext: npm run data:build && npm run enrich`);
}

// Only run when invoked as a script, so tests can import the parsers.
const invokedDirectly = process.argv[1]?.includes("merge-nifty");
if (invokedDirectly) {
  main().catch((err) => {
    if (err instanceof ShrinkGuardError) {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  });
}
