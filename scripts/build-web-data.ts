/**
 * Publish the data the browser fetches (public/data/, served by Vite):
 *
 *   listings.json   the compact listing payload
 *   reference.json  the managed reference catalog snapshot (cities,
 *                   boundaries, places), exported through the repository
 *
 * `listings.json` remains the complete archival/enrichment artifact for CLI
 * analysis. The dashboard recomputes all proximity fields through
 * ProximityIndex, so shipping the seven baked nearest-place objects and
 * geocoder audit string wastes ~1 MB. This derivative removes only those
 * redundant fields; costs, lifecycle, parking and listing details remain.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, DATA_DIR, REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { WEB_PUBLISH_DIR } from "../src/node/dataPaths";
import { mkdir } from "node:fs/promises";
import type { EnrichedListing } from "../src/domain/types";
import { normalizeListingAttributes } from "../src/domain/listingAttributes";
import { deduplicateListings } from "../src/domain/listingDedup";
import { packListings } from "../src/domain/webPayload";
import { withAvailability } from "../src/domain/availability";
import { readAvailability } from "../src/storage/json/availabilityStore";

const INPUT = join(DATA_DIR, "listings.json");
const OUTPUT = join(WEB_PUBLISH_DIR, "listings.json");
const REFERENCE_OUTPUT = join(WEB_PUBLISH_DIR, "reference.json");

const listings = JSON.parse(await readFile(INPUT, "utf8")) as EnrichedListing[];
// Keep the browser payload clean even when listings.json came from an older
// build. `data:build` uses the same matcher, while this is a final safeguard.
const availability = await readAvailability();
// Bake portal availability checks (data/availability.json) into each ad so the
// dashboard can hide properties every portal has taken down.
const uniqueListings = (deduplicateListings(listings) as EnrichedListing[]).map((listing) => withAvailability(listing, availability));
const compact = uniqueListings.map((listing) => {
  const {
    poi1: _poi1,
    poi2: _poi2,
    station: _station,
    busStop: _busStop,
    school: _school,
    kindergarten: _kindergarten,
    childcareAny: _childcareAny,
    geocodeMatched: _geocodeMatched,
    // These verbose audit/detail fields remain in archival listings.json and
    // source files, but are not rendered by the dashboard. Keep the compact
    // structured fields that scoring and expanded rows actually consume.
    notes: _notes,
    agency: _agency,
    agencyInfo: _agencyInfo,
    sourceDetails: _sourceDetails,
    ...webListing
  } = listing;
  // Normalize at build time, not on every browser render. The raw value is
  // retained only when it adds information beyond the bilingual labels; this
  // avoids repeating the same Japanese text three times in the web bundle.
  const attributes = normalizeListingAttributes(listing).map((attribute) => ({
    ...attribute,
    raw: attribute.raw === attribute.labelJa ? "" : attribute.raw,
  }));
  return { ...webListing, attributes };
});

const payload = packListings(compact);
const reference = await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot();
await mkdir(WEB_PUBLISH_DIR, { recursive: true });
await atomicWriteJson(OUTPUT, payload);
// Compact: the Kanto boundaries are ~100k coordinates, a third the size without indentation.
await atomicWriteJson(REFERENCE_OUTPUT, reference, { compact: true });
const before = Buffer.byteLength(JSON.stringify(listings));
const after = Buffer.byteLength(JSON.stringify(payload));
console.log(
  `Wrote ${OUTPUT}: ${compact.length} listings (${listings.length - uniqueListings.length} duplicates merged), ` +
    `${(after / 1024).toFixed(0)} KiB (${Math.round((1 - after / before) * 100)}% smaller than listings.json)`,
);
console.log(
  `Wrote ${REFERENCE_OUTPUT}: reference catalog ${reference.revision.slice(0, 12)} ` +
    `(${reference.cities.records.length} cities, ${reference.boundaries.records.length} boundaries, ${reference.places.records.length} places)`,
);
