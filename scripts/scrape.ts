/**
 * Scrapes family-size rental listings from SUUMO for Soka, Koshigaya and Kawaguchi.
 *
 * Default mode is an optimized incremental discovery crawl:
 *   - asks SUUMO for newest-first results (`po1=09`),
 *   - walks only until two consecutive pages are entirely known,
 *   - merges discoveries into the existing source snapshot,
 *   - never marks unseen records sold (a partial crawl cannot prove absence).
 *
 * Run `npm run scrape -- --full` for a full-market audit. Full mode walks all
 * configured pages and replaces the source snapshot; the subsequent
 * `data:build` reconciliation can then safely mark vanished listings sold.
 *
 * This script owns ONLY src/data/sources/suumo.json. Afterwards run
 * `npm run backfill:parking && npm run data:build && npm run enrich`.
 */
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ShrinkGuardError, readSource, writeSource } from "./lib/dataStore";
import { isSuumoOverlap, mergeSuumoIncremental, suumoKey, suumoMatchKeys } from "./lib/suumoIncremental";
import type { RawListing } from "../src/types";
import { trackingKey } from "./lib/lifecycle";
import { cachedPage } from "./lib/captureStore";
import { DEFAULT_INCREMENTAL_PAGE_CEILING } from "./lib/refreshPlan";

/** 2K / 2DK / 2LDK / 3K / 3DK / 3LDK / 4K / 4DK / 4LDK / 5K+ */
const LAYOUT_CODES = ["05", "06", "07", "08", "09", "10", "11", "12", "13", "14"];
const PAGE_DELAY_MS = 2_000;
const MD_QUERY = LAYOUT_CODES.map((c) => `md=${c}`).join("&");
const NEWEST_FIRST = "po1=09";
/** Stop incremental search after this many all-known pages in a row. */
const OVERLAP_STOP_PAGES = 2;

const CITIES: { sc: string; label: string }[] = [
  { sc: "sc_soka", label: "Soka" },
  { sc: "sc_koshigaya", label: "Koshigaya" },
  { sc: "sc_kawaguchi", label: "Kawaguchi" },
];

const FULL = process.argv.includes("--full");
/** Scan the whole configured newest-first window, ignoring early overlap stop. */
const DEEP = process.argv.includes("--deep");
const maxPagesFlag = process.argv.indexOf("--max-pages");
const MAX_PAGES = maxPagesFlag >= 0
  ? Math.max(1, Number(process.argv[maxPagesFlag + 1]) || 1)
  : DEFAULT_INCREMENTAL_PAGE_CEILING;

const cityUrl = (sc: string, page: number, newestFirst: boolean) => {
  const params = `${MD_QUERY}${newestFirst ? `&${NEWEST_FIRST}` : ""}${page > 1 ? `&page=${page}` : ""}`;
  return `https://suumo.jp/chintai/saitama/${sc}/?${params}`;
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);

async function fetchPage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja-JP,ja;q=0.9" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`SUUMO ${url}: HTTP ${res.status}`);
    return res.text();
  } catch (error) {
    // Node/undici occasionally sees transient macOS DNS ENOTFOUND while curl
    // resolves the same host correctly. Fall back to curl rather than failing
    // a daily refresh; curl still uses normal TLS and the same public URL.
    let args = ["--fail", "--silent", "--show-error", "--location", "--max-time", "45", "-A", USER_AGENT, "-H", "Accept-Language: ja-JP,ja;q=0.9", url];
    let result;
    try {
      result = await execFileAsync("curl", args, { maxBuffer: 8 * 1024 * 1024 });
    } catch (curlError) {
      // Last-resort DNS workaround for the currently published SUUMO origin.
      // TLS still verifies suumo.jp; only name resolution is pinned.
      const message = curlError instanceof Error ? curlError.message : String(curlError);
      if (!message.includes("Could not resolve host")) throw curlError;
      args = ["--resolve", "suumo.jp:443:160.17.3.13", ...args];
      result = await execFileAsync("curl", args, { maxBuffer: 8 * 1024 * 1024 });
    }
    const { stdout } = result;
    if (!stdout.includes("cassetteitem")) throw error;
    return stdout;
  }
}

interface RoomRow {
  floor: string;
  rentYen: number | null;
  adminFeeYen: number;
  depositYen: number | null;
  keyMoneyYen: number | null;
  layout: string;
  sizeM2: number | null;
  detailUrl: string | null;
}

function parseMoveInCell(text: string): number | null {
  const t = text.replace(/\s/g, "");
  if (t === "") return null;
  if (t === "-" || t === "−" || t === "ー" || t.includes("なし")) return 0;
  return parseMan(t);
}

function parseMan(text: string): number | null {
  const m = text.replace(/\s/g, "").match(/([\d.]+)万円/);
  return m ? Math.round(parseFloat(m[1]) * 10_000) : null;
}

function parseYen(text: string): number {
  const m = text.match(/([\d,]+)円/);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
}

function parseSize(text: string): number | null {
  const m = text.match(/([\d.]+)m/);
  return m ? parseFloat(m[1]) : null;
}

function parseBuiltYear(text: string, currentYear: number): number | null {
  if (text.includes("新築")) return currentYear;
  const m = text.match(/築(\d+)年/);
  return m ? currentYear - parseInt(m[1], 10) : null;
}

function parseStationLine(text: string): { station: string | null; walkMin: number | null } {
  const m = text.match(/\/\s*(.+?駅)\s*歩(\d+)分/);
  if (!m) return { station: null, walkMin: null };
  return { station: m[1], walkMin: parseInt(m[2], 10) };
}

function parseRoomRows($: cheerio.CheerioAPI, cassette: Element): RoomRow[] {
  const rows: RoomRow[] = [];
  $(cassette)
    .find(".cassetteitem_other tbody tr.js-cassette_link")
    .each((_, tr) => {
      const $tr = $(tr);
      rows.push({
        floor: $tr.find("td").eq(2).text().trim(),
        rentYen: parseMan($tr.find(".cassetteitem_price--rent").text()),
        adminFeeYen: parseYen($tr.find(".cassetteitem_price--administration").text()),
        depositYen: parseMoveInCell($tr.find(".cassetteitem_price--deposit").text()),
        keyMoneyYen: parseMoveInCell($tr.find(".cassetteitem_price--gratuity").text()),
        layout: $tr.find(".cassetteitem_madori").text().trim(),
        sizeM2: parseSize($tr.find(".cassetteitem_menseki").text()),
        detailUrl: $tr.find("a[href*='bc=']").attr("href") ?? null,
      });
    });
  return rows;
}

function pickFamilyRoom(rows: RoomRow[]): RoomRow | null {
  const sized = rows.filter((r) => r.rentYen !== null && r.sizeM2 !== null);
  if (sized.length === 0) return null;
  return sized.reduce((best, r) => ((r.sizeM2 ?? 0) > (best.sizeM2 ?? 0) ? r : best));
}

export function parsePage(html: string, currentYear: number): RawListing[] {
  const $ = cheerio.load(html);
  const listings: RawListing[] = [];

  $(".cassetteitem").each((_, cassette) => {
    const name = $(cassette).find(".cassetteitem_content-title").text().trim();
    const address = $(cassette).find(".cassetteitem_detail-col1").text().trim();
    const stationTexts = $(cassette)
      .find(".cassetteitem_detail-col2 .cassetteitem_detail-text")
      .map((_, el) => $(el).text().trim())
      .get();
    const ageText = $(cassette).find(".cassetteitem_detail-col3 div").first().text().trim();
    const room = pickFamilyRoom(parseRoomRows($, cassette));
    if (!name || !address || !room || room.rentYen === null || room.sizeM2 === null) return;

    const nearest = parseStationLine(stationTexts[0] ?? "");
    const detailUrl = room.detailUrl ? new URL(room.detailUrl, "https://suumo.jp").href : undefined;

    listings.push({
      id: `suumo-${name}-${room.layout}-${room.rentYen}`.replace(/\s+/g, ""),
      name,
      address,
      rent: room.rentYen + room.adminFeeYen,
      depositYen: room.depositYen,
      keyMoneyYen: room.keyMoneyYen,
      layout: room.layout,
      sizeM2: room.sizeM2,
      builtYear: parseBuiltYear(ageText, currentYear),
      advertisedStation: nearest.station,
      stationWalkMin: nearest.walkMin,
      url: detailUrl ?? null,
      source: "suumo",
      notes: `${ageText}・${room.floor}・管理費込`,
      costs: { adminFeeYen: room.adminFeeYen },
      building: { floor: room.floor || null },
    });
  });

  return listings;
}

async function main(): Promise<void> {
  if (FULL) throw new Error("Authoritative --full requires verified per-city exhaustion, not configured page caps. Use --deep for safe non-destructive discovery.");
  const currentYear = new Date().getFullYear();
  const previous = await readSource("suumo");
  if (!FULL && !previous) {
    throw new Error("No SUUMO snapshot exists. Bootstrap once with `npm run scrape -- --full`.");
  }

  const knownAliases = new Set((previous?.listings ?? []).flatMap(suumoMatchKeys));
  const discovered: RawListing[] = [];
  const seenThisRun: RawListing[] = [];
  let pagesFetched = 0;
  const observedAtByKey: Record<string, string> = {};

  console.log(
    FULL
      ? "Full-market audit (absence may mark sold)"
      : DEEP
        ? "Deep newest-first discovery (no deletions)"
        : "Incremental newest-first discovery (no deletions)",
  );

  for (const city of CITIES) {
    console.log(`\n=== ${city.label} (${city.sc}) ===`);
    let consecutiveKnownPages = 0;
    const pageLimit = MAX_PAGES;

    for (let page = 1; page <= pageLimit; page++) {
      const capture = await cachedPage({ source: "suumo", city: city.label, url: cityUrl(city.sc, page, !FULL), page }, () => fetchPage(cityUrl(city.sc, page, !FULL)));
      const parsed = parsePage(capture.html, currentYear).map((listing) => ({ ...listing, city: city.label }));
      if (parsed.length === 0) throw new Error("SUUMO page had no usable records; capture retained for offline diagnosis");
      for (const listing of parsed) observedAtByKey[trackingKey(listing)] = capture.capturedAt;
      pagesFetched++;
      let novel = 0;
      let overlap = 0;
      let duplicate = 0;

      for (const listing of parsed) {
        if (seenThisRun.some((seen) => isSuumoOverlap(seen, listing))) {
          duplicate++;
          continue;
        }
        seenThisRun.push(listing);
        discovered.push(listing);
        if (suumoMatchKeys(listing).some((alias) => knownAliases.has(alias))) overlap++;
        else novel++;
      }

      console.log(`  page ${page}: ${parsed.length} properties (${novel} new, ${overlap} known, ${duplicate} duplicate)`);
      if (parsed.length === 0) break;

      if (!FULL && !DEEP) {
        consecutiveKnownPages = novel === 0 ? consecutiveKnownPages + 1 : 0;
        if (consecutiveKnownPages >= OVERLAP_STOP_PAGES) {
          console.log(`  stopped: ${OVERLAP_STOP_PAGES} consecutive pages were entirely known`);
          break;
        }
      }
      await sleep(PAGE_DELAY_MS);
    }
  }

  // Exact IDs of genuinely new ads from this run let parking backfill touch
  // only those detail pages rather than every historical unknown.
  const newListingIds = discovered
    .filter((listing) => !suumoMatchKeys(listing).some((alias) => knownAliases.has(alias)))
    .map(suumoKey);

  const mergedWithHistory = mergeSuumoIncremental(previous?.listings ?? [], discovered);
  // In a full audit, keep only records observed now, but still use the merge
  // to preserve their expensive parking detail. Incremental mode also keeps
  // unseen history because a newest-first prefix cannot establish absence.
  const merged = {
    ...mergedWithHistory,
    listings: FULL
      ? mergedWithHistory.listings.filter((listing) =>
          discovered.some((fresh) => isSuumoOverlap(fresh, listing)),
        )
      : mergedWithHistory.listings,
  };

  const { path, previousCount } = await writeSource(
    {
      source: "suumo",
      scrapedAt: new Date().toISOString(),
      completeSnapshot: FULL,
      provenance: {
        mode: FULL ? "full-market audit" : DEEP ? "deep newest-first" : "incremental newest-first",
        pagesFetched,
        cities: CITIES.map((c) => `${c.label} (${c.sc}, emergency ceiling ${MAX_PAGES}p)`),
        layoutCodes: LAYOUT_CODES.join(","),
        newListings: merged.added,
        newListingIds,
        // Lets data:build distinguish ads actually observed in this partial
        // crawl from stale records preserved in the source snapshot.
        observedTrackingKeys: [...new Set(discovered.map(trackingKey))],
        observedAtByKey,
        overlappingListings: merged.overlaps,
        capturedBy: "scripts/scrape.ts",
      },
      listings: merged.listings,
    },
    { force: process.argv.includes("--force") },
  );

  console.log(`\nWrote ${merged.listings.length} listings (was ${previousCount}) to ${path}`);
  console.log(`Discovered ${merged.added} new; refreshed ${merged.updated} overlapping; fetched ${pagesFetched} pages.`);
  if (!FULL) console.log("Unseen existing listings were preserved; use --full when you need authoritative SOLD detection.");
  console.log("Next: npm run backfill:parking && npm run data:build && npm run enrich");
}

// Native-browser imports reuse the parser without starting a network collector.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => {
  if (err instanceof ShrinkGuardError) {
    console.error(`\n${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
