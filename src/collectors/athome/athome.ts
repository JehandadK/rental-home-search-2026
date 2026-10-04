/** Pure parsers and incremental merge helpers for athome.co.jp list pages. */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { ParkingInfo, RawListing } from "../../domain/types";
import { isExplicitNone, parseYen as parseJapaneseYen } from "../shared/parseJa";
import { collectPhotos, photoKind } from "../shared/photos";
import { withPrefecture } from "../shared/targetCities";

function parseMan(text: string): number | null {
  const m = text.replace(/\s/g, "").match(/([\d.]+)万円/);
  return m ? Math.round(Number(m[1]) * 10_000) : null;
}

function parseYen(text: string): number {
  const m = text.match(/([\d,]+)円/);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
}

function parseBuiltYear(text: string): number | null {
  const m = text.match(/(19\d{2}|20\d{2})年/);
  return m ? Number(m[1]) : null;
}

function parseStation(text: string): { station: string | null; walkMin: number | null } {
  const quoted = text.match(/[「『]([^」』]+)[」』]\s*駅?\s*徒歩(\d+)分/);
  const plain = text.match(/(?:^|[/／\s])([^/／\s「」『』]+駅)\s*徒歩(\d+)分/);
  const m = quoted ?? plain;
  if (!m) return { station: null, walkMin: null };
  return { station: m[1].replace(/駅$/, "") + "駅", walkMin: Number(m[2]) };
}

/** AtHome prints move-in money in rent multiples (e.g. 1.5ヶ月 / なし). */
function parseMoveInMonths(text: string | undefined, baseRent: number): number | null {
  if (!text) return null;
  if (isExplicitNone(text)) return 0;
  const months = text.normalize("NFKC").match(/([\d.]+)\s*(?:ヶ月|か月|ケ月)/);
  if (months) return Math.round(Number(months[1]) * baseRent);
  return parseJapaneseYen(text);
}

function roomParking($: cheerio.CheerioAPI, room: Element): ParkingInfo | undefined {
  const facility = $(room).find(".p-property__information-facility li").filter((_, li) =>
    $(li).text().includes("駐車場"),
  ).first();
  if (!facility.length) return undefined;
  const available = !facility.hasClass("p-property__information-facility_disabled-list");
  return { monthlyYen: null, available, location: null, distanceM: null, raw: facility.text().trim() };
}

/** Layouts in scope: 2K and larger, matching the SUUMO collector. */
export function isFamilyLayout(layout: string | null): boolean {
  const rooms = layout?.normalize("NFKC").match(/^(\d+)/)?.[1];
  return rooms != null && Number(rooms) >= 2;
}

/** Parse all in-scope advertised rooms from one AtHome city results page. */
export function parseAthomePage(html: string, city: string): RawListing[] {
  const $ = cheerio.load(html);
  const listings: RawListing[] = [];

  $(".p-property").each((_, property) => {
    const building = $(property);
    const name = building.find(".p-property__title--building").first().text().trim();
    const address = building.find('i[title="所在地"]').closest("dl").find("dd").text().trim();
    const traffic = building.find('i[title="交通"]').closest("dl").find("dd").text().replace(/\s+/g, " ").trim();
    const buildingText = building.find('i[title="家"]').closest("dl").find("dd").text().replace(/\s+/g, " ").trim();
    const station = parseStation(traffic);
    // Captures carry the building's carousel and each room's floor plan as data-src.
    const imageOf = (img: Parameters<typeof $>[0]) => ({ url: $(img).attr("data-src"), kind: photoKind($(img).attr("alt")) });
    const buildingPhotos = building.find(".p-property__photos img").map((_, img) => imageOf(img)).get();

    building.find(".p-property__room--detailbox").each((_, room) => {
      const box = $(room);
      const id = box.attr("data-bukken-no")?.trim();
      const rentBase = parseMan(box.find(".p-property__information-rent").parent().text());
      if (!id || !name || !address || rentBase == null) return;
      const adminFee = parseYen(box.find(".p-property__information-price span").text());
      const floorCell = box.find(".p-property__room-floorplan");
      const layout = floorCell.find(".p-property__floor").text().trim() || null;
      if (!isFamilyLayout(layout)) return;
      const sizeMatch = floorCell.find("span").text().match(/([\d.]+)m[²2]/i);
      const money = box.find(".p-property__room-keymoney").children().map((_, child) => $(child).text().trim()).get();
      const depositYen = parseMoveInMonths(money[0], rentBase);
      const keyMoneyYen = parseMoveInMonths(money[1], rentBase);
      const detailHref = box.find('a[href*="/chintai/"]').last().attr("href");
      const detailUrl = detailHref ? new URL(detailHref, "https://www.athome.co.jp").href : `https://www.athome.co.jp/chintai/${id}/`;
      // Amenity flags sit either inside the room box or directly after it,
      // depending on which AtHome list template is active.
      const parking = roomParking($, room) ?? roomParking($, property);
      const facilities = (box.find(".p-property__information-facility li").length ? box : building)
        .find(".p-property__information-facility li");
      const photos = collectPhotos([...buildingPhotos, ...box.find("img.p-property__room-photo").map((_, img) => imageOf(img)).get()],
        "athome", "https://www.athome.co.jp");

      listings.push({
        id: `athome-${id}`,
        name: name.replace(/\s+\d+階建$/, ""),
        address: withPrefecture(address, city),
        city,
        rent: rentBase + adminFee,
        layout,
        sizeM2: sizeMatch ? Number(sizeMatch[1]) : null,
        builtYear: parseBuiltYear(buildingText),
        depositYen,
        keyMoneyYen,
        parking,
        advertisedStation: station.station,
        stationWalkMin: station.walkMin,
        url: detailUrl,
        source: "athome",
        notes: `${buildingText}・管理費${adminFee.toLocaleString()}円`,
        costs: { adminFeeYen: adminFee, depositYen, keyMoneyYen, parking: parking ?? null },
        building: {
          totalFloors: Number(buildingText.match(/(\d+)階建/)?.[1]) || null,
          // The newer list template omits amenities altogether. Absence is
          // unknown, not an explicit empty list that erases older evidence.
          ...(facilities.length ? { conditions: facilities
            .filter((_, li) => !$(li).hasClass("p-property__information-facility_disabled-list"))
            .map((_, li) => $(li).text().trim()).get() } : {}),
        },
        ...(photos ? { photos } : {}),
      });
    });
  });

  return listings;
}
