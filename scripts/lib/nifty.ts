/** Nifty LIST cards already expose essentials: detail loads are optional. */
import * as cheerio from "cheerio";
import type { RawListing } from "../../src/types";
import { trackingKey } from "./lifecycle";
import { parseYen } from "./parseJa";
import { parseStationDistance } from "../merge-nifty";
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export function niftyMatchKeys(l: RawListing): string[] {
  return [l.id ?? l.url ?? trackingKey(l), `property:${trackingKey(l)}`, `market:${norm(l.address)}|${l.rent}|${l.sizeM2}|${l.layout}`];
}
export function parseNiftyPage(html: string, city: string, year = new Date().getFullYear()): RawListing[] {
  const $ = cheerio.load(html);
  const rows: RawListing[] = [];
  $(".result-bukken-table").each((_, table) => {
    const card = $(table).parent();
    const header = card.children().first();
    const name = header.find("h2").text().replace(/\s+/g, " ").trim().replace(/の賃貸物件$/, "");
    const address = header.find("p").map((_, p) => $(p).text().trim()).get().find((s) => /^埼玉県/.test(s)) ?? "";
    const kv = new Map(header.find("dl").map((_, dl) => ({ key: $(dl).find("dt").text().trim(), value: $(dl).find("dd").text().trim() })).get().map((p) => [p.key, p.value]));
    const age = kv.get("築年数") ?? "";
    const yearText = age.match(/((?:19|20)\d{2})年/);
    const builtYear = /新築/.test(age) ? year : yearText ? Number(yearText[1]) : age.match(/(\d+)年/) ? year - Number(age.match(/(\d+)年/)![1]) : null;
    const station = parseStationDistance(header.find("[data-transport-access]").first().text().trim());
    $(table).find("tbody.click-area").each((_, tbody) => {
      const body = $(tbody), cells = body.find("tr").first().children("td");
      const href = body.find('a[href*="detail_"]').first().attr("href");
      const layout = cells.eq(3).find("p").first().text().trim();
      if (!href || Number(layout.match(/^\d+/)?.[0] ?? 0) < 2) return;
      const size = cells.eq(3).text().match(/([\d.]+)㎡/);
      const rentCells = body.find(".bukken-info-rent p");
      const baseRent = parseYen(rentCells.eq(0).text());
      const adminFeeYen = parseYen(rentCells.eq(1).text());
      if (!name || !address || baseRent == null || !size) throw new Error("Nifty family card missing required fields");
      const money = (label: string) => {
        const text = cells.eq(5).find("dl").filter((_, dl) => $(dl).find("dt").text().trim() === label).find("dd").text();
        const months = text.normalize("NFKC").match(/([\d.]+)[ヶケか]月/);
        return months ? Math.round(Number(months[1]) * baseRent) : parseYen(text);
      };
      const features = [...new Set([...header.find(".badge.is-outline"), ...body.find(".badge.is-outline")].map((el) => $(el).text().trim()))];
      const parkingText = features.find((f) => /駐車場あり|駐車場なし/.test(f));
      rows.push({ id: `nifty-${href.match(/detail_([a-f0-9]+)/)?.[1]}`, source: "nifty", url: new URL(href, "https://myhome.nifty.com").href,
        ...(parkingText ? { parking: { available: parkingText.includes("あり"), monthlyYen: null, location: null, distanceM: null, raw: parkingText } } : {}),
        city, name, address, rent: baseRent + (adminFeeYen ?? 0), layout, sizeM2: Number(size[1]), builtYear,
        advertisedStation: station.station ?? null, stationWalkMin: station.walkMin ?? null,
        depositYen: money("敷"), keyMoneyYen: money("礼"), costs: { adminFeeYen, depositYen: money("敷"), keyMoneyYen: money("礼") },
        building: { floor: cells.eq(2).text().trim(), structure: kv.get("建物構造") ?? null, totalFloors: Number(kv.get("総階数")?.match(/\d+/)?.[0]) || null,
          features }, 
      });
    });
  });
  return rows;
}
export function mergeNiftyIncremental(existing: readonly RawListing[], fresh: readonly RawListing[]): { listings: RawListing[]; added: number; updated: number; overlaps: number } {
  const aliases = new Map(existing.flatMap((l) => niftyMatchKeys(l).map((k) => [k, l] as const)));
  const seen = new Set<string>(), used = new Set<RawListing>(), listings: RawListing[] = [];
  let added = 0, updated = 0;
  for (const l of fresh) {
    const keys = niftyMatchKeys(l);
    if (keys.some((k) => seen.has(k))) continue;
    const prior = keys.map((k) => aliases.get(k)).find(Boolean);
    keys.forEach((k) => seen.add(k));
    if (prior) {
      used.add(prior); updated++;
      listings.push({ ...prior, ...l, ...(l.parking?.available && prior.parking?.available && prior.parking.monthlyYen != null ? { parking: prior.parking } : {}), costs: { ...prior.costs, ...l.costs },
        // List cards have no tenancy data. Do not invent an empty object on replay.
        ...(prior.tenancy || l.tenancy ? { tenancy: { ...prior.tenancy, ...l.tenancy } } : {}),
        building: { ...prior.building, ...l.building, features: [...new Set([...(prior.building?.features ?? []), ...(l.building?.features ?? [])])] } });
    } else { listings.push(l); added++; }
  }
  listings.push(...existing.filter((l) => !used.has(l) && !niftyMatchKeys(l).some((k) => seen.has(k))));
  return { listings, added, updated, overlaps: updated };
}
