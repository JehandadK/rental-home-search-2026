import type { ScrapeBatch, ScrapeIngestion } from "../../data-layer/ingestion/contracts";
import { scrapeFingerprint } from "../../data-layer/ingestion/service";
import { type PageCapture, validateCapture } from "../shared/captureStore";
import { parseNiftyPage } from "./nifty";

/** Scraper adapter: capture validation/parsing only. Source reads/merges belong to the data layer. */
export async function ingestNiftyListPage(service: ScrapeIngestion, capture: PageCapture) {
  if (capture.source !== "nifty") throw new Error("Expected a Nifty list capture");
  validateCapture(capture);
  const parsed = parseNiftyPage(capture.html, capture.city, new Date(capture.capturedAt).getFullYear());
  // Do not depend on the optional spool checksum; freshly fetched and cached
  // versions of the same capture must produce the same batch identity.
  const captureId = await scrapeFingerprint({ url: capture.url, html: capture.html, capturedAt: capture.capturedAt });
  const batch: ScrapeBatch = {
    schemaVersion: 1,
    source: "nifty",
    scraper: { name: "nifty-list", version: "1", parserVersion: "1" },
    runId: `nifty-list-capture:${capture.capturedAt}`,
    batchId: captureId,
    mode: "discovery",
    capturedAt: capture.capturedAt,
    scope: { urls: [capture.url], cities: [capture.city], filters: { minRooms: 2, sort: "regDate-desc", page: capture.page } },
    observations: parsed.map((listing) => ({
      sourceListingId: listing.id ?? listing.url!,
      observedAt: capture.capturedAt,
      evidence: { url: capture.url, captureId },
      listing,
    })),
    provenance: {
      mode: "verified newest-first list discovery",
      capturedBy: "scripts/crawl-nifty.ts",
    },
  };
  const ingestion = await service.ingestScrape(batch);
  return { parsedCount: parsed.length, novel: ingestion.novel, added: ingestion.added, updated: ingestion.updated, ingestion };
}
