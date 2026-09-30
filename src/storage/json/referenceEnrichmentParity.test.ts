/**
 * `npm run enrich` measures proximities against the managed catalog rather
 * than the original reference files. For the current data that must not
 * change a single baked proximity in listings.json.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enrichListing } from "../../domain/enrichListing";
import { buildReferenceModel } from "../../domain/referenceData";
import type { EnrichedListing } from "../../domain/types";
import { DATA_DIR, REFERENCE_CATALOG_DIR } from "./dataStore";
import { JsonReferenceDataRepository } from "./jsonReferenceDataRepository";

const PROXIMITY_FIELDS = ["poi1", "poi2", "station", "busStop", "school", "kindergarten", "childcareAny"] as const;

describe("enrichment against the managed reference catalog", () => {
  it("reproduces every baked proximity in listings.json", async () => {
    const { catalog } = buildReferenceModel(await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot());
    const listings = JSON.parse(readFileSync(join(DATA_DIR, "listings.json"), "utf8")) as EnrichedListing[];
    const geocoded = listings.filter((listing) => listing.geocoded && listing.lat != null && listing.lon != null);
    expect(geocoded.length).toBeGreaterThan(0);

    const mismatches = geocoded.filter((listing) => {
      const enriched = enrichListing(listing, { lat: listing.lat!, lon: listing.lon! }, listing.geocodeMatched, catalog);
      return PROXIMITY_FIELDS.some((field) => JSON.stringify(enriched[field]) !== JSON.stringify(listing[field]));
    });
    expect(mismatches.map((listing) => listing.name)).toEqual([]);
  });
});
