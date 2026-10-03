/** Pure RoomSpot search-result parser and incremental merge helpers. */
import * as cheerio from "cheerio";
import type { RawListing } from "../../domain/types";
import { isExplicitNone, parseYen } from "../shared/parseJa";
import { collectPhotos, photoKind } from "../shared/photos";

export function isFamilyLayout(layout: string | null): boolean {
  const rooms = layout?.normalize("NFKC").match(/^(\d+)/)?.[1];
  return rooms != null && Number(rooms) >= 2;
}

function parseRent(text: string): number | null {
  const normalized = text.normalize("NFKC").replace(/[\s,]/g, "");
  const man = normalized.match(/(\d+)万(\d+)?/);
  if (man) return Number(man[1]) * 10_000 + Number(man[2] ?? 0);
  return parseYen(normalized);
}

function parseMonths(text: string, baseRent: number): number | null {
  const normalized = text.normalize("NFKC").trim();
  if (isExplicitNone(normalized) || /(^|\s)0(?:\.0+)?ヶ月/.test(normalized)) return 0;
  const match = normalized.match(/([\d.]+)ヶ月/);
  if (match) return Math.round(Number(match[1]) * baseRent);
  return parseYen(normalized);
}

function parseStation(text: string): { station: string | null; walkMin: number | null } {
  const match = text.match(/([^\s]+駅)\s*徒歩(\d+)分/);
  return match ? { station: match[1], walkMin: Number(match[2]) } : { station: null, walkMin: null };
}

/** Parse all 2K+ room rows from RoomSpot's result HTML. */
export function parseRoomspotPage(html: string, city: string): RawListing[] {
  const $ = cheerio.load(html);
  const listings: RawListing[] = [];
  $("article.data").each((_, article) => {
    const building = $(article);
    const buildingName = building.find("h2").first().text().trim();
    const address = building.find(".kokoku-list-data__address").last().text().replace(/\s+/g, " ").trim();
    const traffic = building.find(".kokoku-list-data__access").last().text().replace(/\s+/g, " ").trim();
    const ageText = building.find(".kokoku-list-data__age").last().text().trim();
    const station = parseStation(traffic);
    const builtYear = Number(ageText.match(/(19\d{2}|20\d{2})年/)?.[1]) || null;
    // The card's lead picture is the building; each room row carries its floor plan.
    const imageOf = (img: Parameters<typeof $>[0], fallback: "exterior" | "photo") =>
      ({ url: $(img).attr("data-src"), kind: photoKind($(img).attr("alt"), fallback) });
    const buildingPhotos = building.find(".wp-block-image img").map((_, img) => imageOf(img, "exterior")).get();

    building.find(".room_data tbody tr").each((_, row) => {
      const tr = $(row);
      const href = tr.find('a[href*="/rent/"]').first().attr("href");
      const id = href?.match(/\/rent\/(\d+)/)?.[1];
      const layoutText = tr.find(".kokoku-list-condition__layout").text().replace(/\s+/g, " ").trim();
      const layout = layoutText.match(/(\d+(?:S?LDK|SDK|SLDK|DK|LDK|K))/i)?.[1] ?? null;
      if (!id || !href || !buildingName || !address || !isFamilyLayout(layout)) return;
      const size = layoutText.match(/([\d.]+)㎡/);
      const priceCell = tr.find(".kokoku-list-condition__price");
      const baseRent = parseRent(priceCell.find("strong").text());
      if (baseRent == null) return;
      // The PC span is the canonical admin fee; avoid counting hidden mobile duplicate text.
      const adminFee = parseYen(priceCell.find("span.pc").first().text()) ?? 0;
      const moveIn = tr.find(".kokoku-list-condition__deposit").text().replace(/\s+/g, " ");
      const depositText = moveIn.match(/敷金\s*([^/]+?)(?=礼金|\/|$)/)?.[1]?.trim() ?? "";
      const keyText = moveIn.match(/礼金\s*([^/]+?)$/)?.[1]?.trim() ?? "";
      const floor = tr.find(".kokoku-list-condition__floor").text().trim() || null;
      const photos = collectPhotos([...buildingPhotos, ...tr.find("img").map((_, img) => imageOf(img, "photo")).get()],
        "roomspot", "https://www.roomspot.net");

      listings.push({
        id: `roomspot-${id}`,
        name: `${buildingName}${floor ? ` ${floor}` : ""}`,
        address: address.startsWith("埼玉県") ? address : `埼玉県${address}`,
        city,
        rent: baseRent + adminFee,
        layout,
        sizeM2: size ? Number(size[1]) : null,
        builtYear,
        depositYen: parseMonths(depositText, baseRent),
        keyMoneyYen: parseMonths(keyText, baseRent),
        advertisedStation: station.station,
        stationWalkMin: station.walkMin,
        url: new URL(href, "https://www.roomspot.net").href,
        source: "roomspot",
        notes: `${ageText}${floor ? `・${floor}` : ""}・管理費${adminFee.toLocaleString()}円`,
        costs: {
          adminFeeYen: adminFee,
          depositYen: parseMonths(depositText, baseRent),
          keyMoneyYen: parseMonths(keyText, baseRent),
        },
        building: { floor },
        ...(photos ? { photos } : {}),
      });
    });
  });
  return listings;
}
