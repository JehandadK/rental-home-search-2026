/**
 * Imports that break the layer rules today. The architecture test fails on any
 * violation not listed here and on any entry that no longer occurs, so this
 * list can only shrink. M4 must remove every "M4" entry; M5 removes the rest.
 * When a file moves, update its paths here in the same commit.
 */
export interface KnownViolation {
  from: string;
  to: string;
  until: "M4" | "M5";
  fix: string;
}

const referenceData = (file: string): KnownViolation => ({
  from: "src/domain/reference.ts",
  to: `src/data/${file}`,
  until: "M5",
  fix: "Load through the injected web data client",
});

export const KNOWN_VIOLATIONS: KnownViolation[] = [
  // Collector → CLI
  { from: "scripts/lib/listCaptureBatch.ts", to: "scripts/scrape.ts", until: "M4", fix: "Move the SUUMO parsePage into collectors" },
  { from: "scripts/lib/nifty.ts", to: "scripts/merge-nifty.ts", until: "M4", fix: "Move parseStationDistance into collectors" },
  // CLI → CLI
  { from: "scripts/backfill-parking.ts", to: "scripts/enrich-details.ts", until: "M4", fix: "Move the enrichDetails runner into collectors; both CLIs call it" },
  // Collector → storage
  { from: "scripts/lib/captureStore.ts", to: "src/storage/json/dataStore.ts", until: "M4", fix: "Take CAPTURE_DIR and atomic writes from src/node/" },
  { from: "scripts/lib/captureValidation.ts", to: "src/storage/json/dataStore.ts", until: "M4", fix: "Move newerRows (freshness is a data-layer rule; only tests use it) out of collectors" },
  // Collector → data-layer internals
  { from: "scripts/lib/captureValidation.ts", to: "scripts/lib/lifecycle.ts", until: "M4", fix: "Import trackingKey from the domain" },
  { from: "scripts/lib/captureValidation.ts", to: "src/data-layer/sourceObservationTime.ts", until: "M4", fix: "Move newerRows out of collectors" },
  { from: "scripts/lib/athome.ts", to: "src/data-layer/ingestion/portalPolicy.ts", until: "M4", fix: "Remove policy re-exports; callers import the data layer" },
  { from: "scripts/lib/roomspot.ts", to: "src/data-layer/ingestion/portalPolicy.ts", until: "M4", fix: "Remove policy re-exports; callers import the data layer" },
  { from: "scripts/lib/nifty.ts", to: "src/data-layer/ingestion/niftyPolicy.ts", until: "M4", fix: "Remove policy re-exports; callers import the data layer" },
  { from: "scripts/lib/detailEnrichment.ts", to: "src/data-layer/ingestion/suumoDetailPolicy.ts", until: "M4", fix: "Remove policy re-exports; callers import the data layer" },
  { from: "scripts/lib/niftyIngestion.ts", to: "src/data-layer/ingestion/service.ts", until: "M4", fix: "Publish scrapeFingerprint as a public helper or stop needing it" },
  { from: "scripts/lib/suumoDetailIngestion.ts", to: "src/data-layer/ingestion/service.ts", until: "M4", fix: "Publish scrapeFingerprint as a public helper or stop needing it" },
  { from: "scripts/lib/portalCollector.ts", to: "src/data-layer/ingestion/portalDiscovery.ts", until: "M4", fix: "Publish portalPageUrl with the portal discovery contract" },
  { from: "scripts/lib/sourceObservationBatch.ts", to: "src/data-layer/sourceObservationBatch.ts", until: "M4", fix: "Delete the compatibility shim" },
  { from: "scripts/lib/suumoIncremental.ts", to: "src/data-layer/ingestion/suumoIdentity.ts", until: "M4", fix: "Delete the unreferenced compatibility shim" },
  // Collector → refresh
  { from: "scripts/lib/portalCollector.ts", to: "scripts/lib/refreshPlan.ts", until: "M4", fix: "Collectors own DEFAULT_INCREMENTAL_PAGE_CEILING; refresh passes overrides" },
  // Domain → web
  { from: "src/domain/diagnostics.ts", to: "src/web/lib/export.ts", until: "M4", fix: "Move the ScoredRow type into the domain" },
  // Bundled persisted data
  ...[
    "pois.json",
    "stations.json",
    "elementary_schools.json",
    "kindergartens.json",
    "bus_stops.json",
    "soka_boundary.json",
    "neighbor_boundaries.json",
    "listings_web.json",
    "mosques.json",
  ].map(referenceData),
];
