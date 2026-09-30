import * as cheerio from "cheerio";
import type { RawListing } from "../../domain/types";
import type { PageCapture } from "./captureStore";

/** A parser failure must not be mistaken for a page containing no family units. */
export function assertParsedFamilies(capture: PageCapture, rows: readonly RawListing[]): void {
  const $ = cheerio.load(capture.html);
  const selector = capture.source === "suumo" ? ".cassetteitem_madori" : capture.source === "athome" ? ".p-property__floor" : capture.source === "roomspot" ? ".kokoku-list-condition__layout" : ".result-bukken-table tbody.click-area tr:first-child td:nth-child(4)";
  const familyCandidates = $(selector).toArray().some((el) => Number($(el).text().trim().normalize("NFKC").match(/^(\d+)/)?.[1] ?? 0) >= 2);
  if (familyCandidates && rows.length === 0) throw new Error("Family units were present but none parsed; capture retained, source unchanged");
}
