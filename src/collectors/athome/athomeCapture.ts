import * as cheerio from "cheerio";
import { isFamilyLayout } from "./athome";
import type { PageCapture } from "../shared/captureStore";
import { TARGET_CITIES } from "../shared/targetCities";

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]!);

/** Offline projection of Chrome's downloaded public results; never executes page scripts. */
export function athomeDownloadedCapture(html: string, url: string, capturedAt: string): PageCapture & { sortedNewest: true } {
  const u = new URL(url);
  // City-path results (`/soka-city/list/`) filter by city; the prefecture search now ignores `cities`/`cityCds`.
  const path = u.pathname.match(/^\/chintai\/([a-z]+)\/(?:([a-z]+)-city\/)?list\/(?:page([1-9]\d*)\/)?$/);
  const key = path?.[2] ?? u.searchParams.get("cities") ?? "";
  const city = TARGET_CITIES.find((candidate) => candidate.athome === `${key}-city` && candidate.prefectureSlug === path?.[1]);
  if (u.origin !== "https://www.athome.co.jp" || !path || !city ||
      (!path[2] && (u.searchParams.get("cityCds") !== city.code || u.searchParams.get("pref") !== city.code.slice(0, 2))) ||
      u.searchParams.get("sort") !== "33" || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("Invalid AtHome capture URL, city, sort, or observation time");
  }
  const $ = cheerio.load(html);
  if ($('select[name="SORT"]').val() !== "33") throw new Error("AtHome newest-first sort not verified in downloaded HTML");
  const cards = $(".property-card");
  if (!cards.length) throw new Error("No AtHome property cards; blocked/unsupported page is not exhaustion");
  // Pictures ride along as data-src/alt only; the parser decides what is a real photo.
  const photo = (img: Parameters<typeof $>[0], className: string) => {
    const url = $(img).attr("data-src") || $(img).attr("src") || "";
    return url ? `<img class="${className}" data-src="${esc(url)}" alt="${esc($(img).attr("alt") ?? "")}">` : "";
  };
  const projected = cards.map((_, card) => {
    const p = $(card);
    const text = (selector: string) => p.find(selector).first().text().replace(/\s+/g, " ").trim();
    const name = text(".property-title"), address = text(".info-item--location");
    if (!name || !(address.startsWith(city.prefecture) ? address.slice(city.prefecture.length) : address).startsWith(city.municipality)) throw new Error("AtHome card has missing title or wrong city");
    const rooms = p.find(".room-info-section").map((_, room) => {
      const r = $(room);
      const layout = r.find(".layout-size > span").eq(0).text().trim();
      if (!layout) throw new Error("AtHome room layout missing; refusing a silent parser failure");
      if (!isFamilyLayout(layout)) return "";
      const size = r.find(".layout-size > span").eq(1).text().trim();
      const rent = r.find(".price > .rent").text().trim();
      const admin = r.find(".price > span:not(.rent)").text().trim();
      const href = r.find('a[href*="/chintai/"]').first().attr("href") ?? r.closest('a[href*="/chintai/"]').attr("href");
      const detail = href ? new URL(href, u.origin) : undefined;
      const id = detail?.pathname.match(/^\/chintai\/(\d+)\/$/)?.[1];
      if (detail?.origin !== u.origin || !id || !/[\d.]+万円/.test(rent) || !/[\d.]+m[²2]/i.test(size)) {
        throw new Error("AtHome family room missing a valid ID, rent, or area");
      }
      const money = r.find(".fees > span").map((_, e) => `<p>${esc($(e).text().trim())}</p>`).get().join("");
      // Modern cards omit amenities. Do not turn absence into false flags or
      // empty feature arrays that would erase older, explicitly observed data.
      return `<div class="p-property__room--detailbox" data-bukken-no="${id}">` +
        `<p class="p-property__information-price"><b class="p-property__information-rent">${esc(rent)}</b><span>${esc(admin)}</span></p>` +
        `<div class="p-property__room-keymoney">${money}</div>` +
        `<div class="p-property__room-floorplan"><div class="p-property__floor">${esc(layout)}</div><span>${esc(size)}</span></div>` +
        r.find(".room-image img").map((_, img) => photo(img, "p-property__room-photo")).get().join("") +
        `<a href="${u.origin}/chintai/${id}/">detail</a></div>`;
    }).get().join("");
    return `<div class="p-property"><h2 class="p-property__title--building">${esc(name)}</h2>` +
      `<dl><i title="所在地"></i><dd>${esc(address)}</dd></dl>` +
      `<dl><i title="交通"></i><dd>${esc(text(".info-item--station"))}</dd></dl>` +
      `<dl><i title="家"></i><dd>${esc(text(".info-item--type"))}</dd></dl>` +
      `<div class="p-property__photos">${p.find(".image-item img").map((_, img) => photo(img, "")).get().join("")}</div>${rooms}</div>`;
  }).get().join("");
  return { schemaVersion: 1, source: "athome", city: city.label, url: u.href,
    page: Number(path[3] ?? 1), capturedAt, httpStatus: 200, sortedNewest: true, html: projected };
}
