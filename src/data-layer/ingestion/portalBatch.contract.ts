/**
 * Runs the live AtHome/RoomSpot merge (`preparePortalBatch`) over a stored
 * snapshot and one discovery batch, for parser and merge tests (a shared test
 * harness, so production code may not import it).
 */
import type { RawListing } from "../../domain/types";
import { preparePortalBatch, type BrowserPortal } from "./portalPolicy";

const storedAt = "2026-09-24T00:00:00.000Z", capturedAt = "2026-09-25T00:00:00.000Z";

export function preparePortalRows(source: BrowserPortal, prior: readonly RawListing[], fresh: readonly RawListing[]) {
  const prepared = preparePortalBatch({ schemaVersion: 1, source, scraper: { name: `${source}-list`, version: "1", parserVersion: "1" },
    runId: "run-1", batchId: "batch-1", mode: "discovery", capturedAt, scope: { urls: [], cities: ["Soka"], filters: {} },
    observations: fresh.map((listing) => ({ sourceListingId: listing.id!, observedAt: capturedAt, evidence: { url: listing.url!, captureId: "fixture" }, listing })) },
  { source, revision: "revision-1", scrapedAt: storedAt, completeSnapshot: false, listings: prior, archivedListings: [] });
  return { ...prepared, listings: prepared.reconciliation.listings, retirements: prepared.reconciliation.retirements };
}
