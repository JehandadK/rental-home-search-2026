/** SUUMO search-result page parser: one family-sized room per building cassette. */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { RawListing } from "../../domain/types";

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
