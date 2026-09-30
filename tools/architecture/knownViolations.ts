/**
 * Imports that break the layer rules today. The architecture test fails on any
 * violation not listed here and on any entry that no longer occurs, so this
 * list can only shrink. M5 removes the rest.
 */
export interface KnownViolation {
  from: string;
  to: string;
  until: "M5";
  fix: string;
}

const referenceData = (file: string): KnownViolation => ({
  from: "src/domain/reference.ts",
  to: `src/data/${file}`,
  until: "M5",
  fix: "Load through the injected web data client",
});

export const KNOWN_VIOLATIONS: KnownViolation[] = [
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
