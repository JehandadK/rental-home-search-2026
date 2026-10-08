import type { DetailEnrichmentOptions, DetailPatchBatch } from "../../data-layer/ingestion/contracts";
import { contentFingerprint as scrapeFingerprint } from "../../data-layer/contentIdentity";
import { parseDetail } from "./detailEnrichment";

/** Bump when parseDetail reads more from the same capture, so a cached capture is a new batch, not a replay conflict. */
export const SUUMO_DETAIL_PARSER_VERSION = "2";

export interface DetailCapture { url: string; capturedAt: string; html: string }

export function validateDetailCapture(capture: DetailCapture, expectedUrl: string): void {
  const url = new URL(capture.url);
  if (capture.url !== expectedUrl) throw new Error("Detail capture identity mismatch");
  if (url.protocol !== "https:" || url.hostname !== "suumo.jp" || url.username || url.password) throw new Error("Invalid detail origin");
  if (typeof capture.capturedAt !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(capture.capturedAt) || !Number.isFinite(Date.parse(capture.capturedAt))) throw new Error("Invalid detail capture time");
  if (typeof capture.html !== "string" || capture.html.length > 12_000_000) throw new Error("Invalid/oversized detail capture");
}

/** Only captured fields cross this boundary, never a copy of the stored listing. */
export async function detailCaptureBatch(captures: readonly DetailCapture[], selection: Pick<DetailEnrichmentOptions, "maxRent" | "minSize">): Promise<DetailPatchBatch> {
  if (!captures.length) throw new Error("No detail captures to submit");
  const observations = await Promise.all(captures.map(async (capture) => {
    validateDetailCapture(capture, capture.url);
    return { sourceListingId: capture.url, observedAt: capture.capturedAt,
      evidence: { url: capture.url, captureId: await scrapeFingerprint(capture) }, details: parseDetail(capture.html) };
  }));
  const scraper = { name: "suumo-detail", version: "1", parserVersion: SUUMO_DETAIL_PARSER_VERSION };
  const scope = { urls: captures.map((capture) => capture.url), cities: [],
    filters: { minRooms: 2, maxRent: selection.maxRent, minSize: selection.minSize } };
  const capturedAt = captures.reduce((latest, capture) => Date.parse(capture.capturedAt) > Date.parse(latest) ? capture.capturedAt : latest, captures[0].capturedAt);
  return { schemaVersion: 1, source: "suumo", scraper, observationKind: "detail-patch", mode: "detail-enrichment",
    runId: `suumo-detail-captures:${capturedAt}`, batchId: await scrapeFingerprint({ scraper, scope, captures }),
    capturedAt, scope, observations };
}
