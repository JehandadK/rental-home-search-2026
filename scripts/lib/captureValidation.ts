import * as cheerio from "cheerio";
import type { RawListing } from "../../src/domain/types";
import type { SourceFile } from "../../src/storage/json/dataStore";
import type { PageCapture } from "./captureStore";
import { trackingKey } from "../../src/data-layer/lifecycle";
import { sourceObservationFallbackTime } from "../../src/data-layer/sourceObservationTime";

/** A parser failure must not be mistaken for a page containing no family units. */
export function assertParsedFamilies(capture: PageCapture, rows: readonly RawListing[]): void {
  const $ = cheerio.load(capture.html);
  const selector = capture.source === "suumo" ? ".cassetteitem_madori" : capture.source === "athome" ? ".p-property__floor" : capture.source === "roomspot" ? ".kokoku-list-condition__layout" : ".result-bukken-table tbody.click-area tr:first-child td:nth-child(4)";
  const familyCandidates = $(selector).toArray().some((el) => Number($(el).text().trim().normalize("NFKC").match(/^(\d+)/)?.[1] ?? 0) >= 2);
  if (familyCandidates && rows.length === 0) throw new Error("Family units were present but none parsed; capture retained, source unchanged");
}
/** Older replayed captures can enrich new IDs, but cannot overwrite newer ads. */
export function newerRows(previous: SourceFile | null, rows: readonly RawListing[], at: string, aliases: (l: RawListing) => string[]): RawListing[] {
  const index = new Map((previous?.listings ?? []).flatMap((l) => aliases(l).map((key) => [key, l] as const)));
  const times = (previous?.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  return rows.filter((row) => {
    const prior = aliases(row).map((key) => index.get(key)).find(Boolean);
    const previousTime = prior ? times[trackingKey(prior)] ?? sourceObservationFallbackTime(previous) : undefined;
    return previousTime === undefined || Date.parse(at) >= Date.parse(previousTime);
  });
}
