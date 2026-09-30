/**
 * Scrapes family-size rental listings from SUUMO for Soka, Koshigaya and Kawaguchi.
 *
 * Default mode is an optimized incremental discovery crawl:
 *   - asks SUUMO for newest-first results (`po1=09`),
 *   - walks only until two consecutive pages are entirely known,
 *   - merges discoveries into the existing source snapshot,
 *   - never marks unseen records sold (a partial crawl cannot prove absence).
 *
 * `--full` remains guarded until per-city exhaustion can be verified. Capped
 * discovery never establishes absence. The application layer stages observations
 * and commits once the bounded crawl succeeds; cached pages survive failures.
 *
 * This collector submits only source observations. Afterwards run
 * `npm run backfill:parking && npm run data:build && npm run enrich`.
 */
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKUP_DIR, JsonSourceStore, ShrinkGuardError, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService, scrapeFingerprint } from "../src/data-layer/ingestion/service";
import type { ScrapeBatch, SuumoDiscoveryClient } from "../src/data-layer/ingestion/contracts";
import type { RawListing } from "../src/domain/types";
import { cachedPage, validateCapture, type PageCapture } from "../src/collectors/shared/captureStore";
import { DEFAULT_INCREMENTAL_PAGE_CEILING } from "../src/refresh/refreshPlan";

/** 2K / 2DK / 2LDK / 3K / 3DK / 3LDK / 4K / 4DK / 4LDK / 5K+ */
const LAYOUT_CODES = ["05", "06", "07", "08", "09", "10", "11", "12", "13", "14"];
const PAGE_DELAY_MS = 2_000;
const MD_QUERY = LAYOUT_CODES.map((c) => `md=${c}`).join("&");
const NEWEST_FIRST = "po1=09";
const CITIES: { sc: string; label: string }[] = [
  { sc: "sc_soka", label: "Soka" },
  { sc: "sc_koshigaya", label: "Koshigaya" },
  { sc: "sc_kawaguchi", label: "Kawaguchi" },
];

const cityUrl = (sc: string, page: number, newestFirst: boolean) => {
  const params = `${MD_QUERY}${newestFirst ? `&${NEWEST_FIRST}` : ""}${page > 1 ? `&page=${page}` : ""}`;
  return `https://suumo.jp/chintai/saitama/${sc}/?${params}`;
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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

/** The adapter submits all parsed observations; identity and deduplication belong to the data layer. */
export async function suumoCaptureBatch(capture: PageCapture): Promise<ScrapeBatch> {
  if (capture.source !== "suumo") throw new Error("Expected a SUUMO capture");
  validateCapture(capture);
  const parsed = parsePage(capture.html, new Date(capture.capturedAt).getFullYear()).map((listing) => ({ ...listing, city: capture.city }));
  if (!parsed.length) throw new Error("SUUMO page had no usable records; capture retained for offline diagnosis");
  const captureId = await scrapeFingerprint({ source: capture.source, city: capture.city, url: capture.url, page: capture.page,
    capturedAt: capture.capturedAt, html: capture.html });
  return { schemaVersion: 1, source: "suumo", scraper: { name: "suumo-list", version: "1", parserVersion: "1" },
    runId: `suumo-page:${capture.capturedAt}`, batchId: captureId, mode: "discovery", capturedAt: capture.capturedAt,
    scope: { urls: [capture.url], cities: [capture.city], filters: { page: capture.page, sort: "newest", layoutCodes: LAYOUT_CODES.join(",") } },
    observations: parsed.map((listing) => ({ sourceListingId: listing.url!, observedAt: capture.capturedAt,
      evidence: { url: capture.url, captureId }, listing })),
  };
}

export interface SuumoScrapeDependencies {
  client: SuumoDiscoveryClient;
  page(meta: Pick<PageCapture, "source" | "city" | "url" | "page">): Promise<PageCapture>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export async function runSuumoScrape(args: readonly string[], dependencies: SuumoScrapeDependencies) {
  if (args.includes("--full")) throw new Error("Authoritative --full requires verified per-city exhaustion, not configured page caps. Use --deep for safe non-destructive discovery.");
  const deep = args.includes("--deep");
  const flag = args.indexOf("--max-pages");
  const maxPages = flag >= 0 ? Math.max(1, Math.floor(Number(args[flag + 1]) || 1)) : DEFAULT_INCREMENTAL_PAGE_CEILING;
  const session = await dependencies.client.beginSuumoDiscovery({ deep, maxPages, layoutCodes: LAYOUT_CODES,
    cities: CITIES.map((city) => ({ code: city.sc, label: city.label })) });
  let pagesFetched = 0;
  dependencies.log(deep ? "Deep newest-first discovery (no deletions)" : "Incremental newest-first discovery (no deletions)");
  for (const city of CITIES) {
    dependencies.log(`\n=== ${city.label} (${city.sc}) ===`);
    for (let page = 1; page <= maxPages; page++) {
      const meta = { source: "suumo" as const, city: city.label, url: cityUrl(city.sc, page, true), page };
      const capture = await dependencies.page(meta);
      if (capture.url !== meta.url || capture.city !== meta.city || capture.page !== page) throw new Error("SUUMO capture identity mismatch");
      const result = session.stagePage(await suumoCaptureBatch(capture));
      pagesFetched++;
      dependencies.log(`  page ${page}: ${result.parsedCount} properties (${result.novel} new, ${result.overlap} known, ${result.duplicate} duplicate)`);
      if (result.stopReason === "overlap") {
        dependencies.log("  stopped: 2 consecutive pages were entirely known");
        break;
      }
      await dependencies.sleep(PAGE_DELAY_MS);
    }
  }
  const result = await session.commit({ allowShrink: args.includes("--force") });
  dependencies.log(`\nWrote ${result.currentCount} listings (was ${result.previousCount})`);
  dependencies.log(`Discovered ${result.added} new; refreshed ${result.updated} overlapping; retired ${result.retired} superseded source ad(s); fetched ${pagesFetched} pages.`);
  dependencies.log("Unseen history was retained; no SOLD decisions were made.");
  dependencies.log("Next: npm run backfill:parking && npm run data:build && npm run enrich");
  return result;
}

async function main(): Promise<void> {
  await runSuumoScrape(process.argv.slice(2), {
    client: new ListingIngestionService(new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR))),
    page: (meta) => cachedPage(meta, () => fetchPage(meta.url)), sleep, log: console.log,
  });
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
