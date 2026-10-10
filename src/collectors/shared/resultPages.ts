/**
 * Where a city's newest-first results end. Collectors stop on the last page
 * page 1 reports (or that a short page proves) instead of requesting the page
 * after it, and treat a recognised "no results" answer past page 1 as the end
 * of that city's results. Neither is evidence of market exhaustion or SOLD.
 */
import * as cheerio from "cheerio";
import type { PageCapture } from "./captureStore";

/**
 * Cards on a full results page: RoomSpot because the collector requests
 * `item_per_page=30`; AtHome because it always serves 30 (every capture
 * since 2026-09). A page with fewer cards is the city's last page.
 */
export const RESULT_PAGE_SIZE = { roomspot: 30, athome: 30 } as const;

const CARD_SELECTOR = { roomspot: "article.data", athome: ".p-property" } as const;

/**
 * The portal answered a page past page 1 with no results (empty, no cards, or
 * an HTTP 404). Browser adapters throw it only for pages they recognise; blocks,
 * verification and unrecognised pages remain ordinary errors.
 */
export class EndOfResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndOfResultsError";
  }
}

/** The city's last results page as this capture shows it, when it shows one. */
export function lastResultsPage(capture: PageCapture): number | undefined {
  const $ = cheerio.load(capture.html);
  if (capture.source === "suumo") {
    // SUUMO numbers every page link, always including the last one.
    const pages = $("ol.pagination-parts li").toArray()
      .map((item) => Number($(item).text().trim())).filter((page) => Number.isSafeInteger(page) && page > 0);
    return pages.length ? Math.max(capture.page, ...pages) : undefined;
  }
  if (capture.source === "roomspot" || capture.source === "athome") {
    return $(CARD_SELECTOR[capture.source]).length < RESULT_PAGE_SIZE[capture.source] ? capture.page : undefined;
  }
  return undefined;
}
