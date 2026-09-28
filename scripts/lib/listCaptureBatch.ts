import type { ScrapeBatch } from "../../src/data-layer/ingestion/contracts";
import { contentFingerprint } from "../../src/data-layer/contentIdentity";
import { validateCapture, type PageCapture } from "./captureStore";
import { assertParsedFamilies } from "./captureValidation";
import { parseAthomePage } from "./athome";
import { parseRoomspotPage } from "./roomspot";
import { parseNiftyPage } from "./nifty";
import { parsePage as parseSuumoPage } from "../scrape";

/** Parsing and evidence only: all source reads, freshness, matching and writes live behind the client. */
export async function listCaptureBatch(capture: PageCapture, native?: { runId: string; receipt: string }): Promise<ScrapeBatch> {
  validateCapture(capture);
  const parsed = capture.source === "athome" ? parseAthomePage(capture.html, capture.city)
    : capture.source === "roomspot" ? parseRoomspotPage(capture.html, capture.city)
      : capture.source === "nifty" ? parseNiftyPage(capture.html, capture.city, new Date(capture.capturedAt).getFullYear())
        : parseSuumoPage(capture.html, new Date(capture.capturedAt).getFullYear()).map((row) => ({ ...row, city: capture.city }));
  assertParsedFamilies(capture, parsed);
  const captureId = await contentFingerprint({ source: capture.source, url: capture.url, city: capture.city, page: capture.page, capturedAt: capture.capturedAt, html: capture.html });
  return { schemaVersion: 1, source: capture.source,
    scraper: { name: native ? "native-capture" : `${capture.source}-list`, version: "1", parserVersion: "1" }, mode: "discovery",
    runId: native ? `native-capture:${native.runId}` : `${capture.source}-page:${capture.capturedAt}`, batchId: native?.receipt ?? captureId,
    capturedAt: capture.capturedAt, scope: { urls: [capture.url], cities: [capture.city], filters: { page: capture.page } },
    observations: parsed.map((listing) => ({ sourceListingId: capture.source === "suumo" ? listing.url! : listing.id ?? listing.url!,
      observedAt: capture.capturedAt, listing, evidence: { url: capture.url, captureId } })),
    ...(native ? { provenance: { mode: "bounded native-browser discovery", capturedBy: "scripts/import-capture.ts (native browser export)" } } : {}),
  };
}
