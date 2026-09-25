import type { ListingRepository } from "../../src/data-layer/contracts";
import { type PageCapture, validateCapture } from "./captureStore";
import { trackingKey } from "./lifecycle";
import { mergeNiftyIncremental, niftyMatchKeys, parseNiftyPage } from "./nifty";
import { sourceObservationBatch } from "./sourceObservationBatch";

/** Checkpoint one validated list page; neither canonical builds nor browser IO belong here. */
export async function ingestNiftyListPage(repository: ListingRepository, capture: PageCapture) {
  if (capture.source !== "nifty") throw new Error("Expected a Nifty list capture");
  validateCapture(capture);
  const previous = await repository.readSource("nifty");
  const parsed = parseNiftyPage(capture.html, capture.city, new Date(capture.capturedAt).getFullYear());
  const known = new Set((previous?.listings ?? []).flatMap(niftyMatchKeys));
  const novel = parsed.filter((listing) => !niftyMatchKeys(listing).some((key) => known.has(key))).length;
  const merged = mergeNiftyIncremental(previous?.listings ?? [], parsed);
  const observedAtByKey = { ...(previous?.provenance?.observedAtByKey as Record<string, string> ?? {}) };
  for (const listing of parsed) observedAtByKey[trackingKey(listing)] = capture.capturedAt;

  const ingestion = await repository.ingest(sourceObservationBatch({
    source: "nifty",
    previous: previous?.listings ?? [],
    current: merged.listings,
    expectedRevision: previous?.revision ?? null,
    observedAt: capture.capturedAt,
    observedAtByKey,
    provenance: {
      ...previous?.provenance,
      mode: "verified newest-first list discovery",
      capturedBy: "scripts/crawl-nifty.ts",
      observedTrackingKeys: parsed.map(trackingKey),
      observedAtByKey,
    },
    matchKeys: niftyMatchKeys,
  }));
  return { parsedCount: parsed.length, novel, added: merged.added, updated: merged.updated, ingestion };
}
