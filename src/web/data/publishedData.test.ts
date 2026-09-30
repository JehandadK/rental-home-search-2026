/**
 * The published assets (public/data/) are what the app now loads. Saved
 * place selections store catalog ids, and M5 must not change any score, so
 * this checks the published data against the pre-M5 behaviour: the place
 * catalog the app derived from the original reference files, and the scores
 * it computed from them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR, WEB_PUBLISH_DIR } from "../../node/dataPaths";
import { buildPlaceCatalog, type ReferencePlace } from "../../domain/places";
import { ProximityIndex } from "../../domain/proximityIndex";
import { applySelection, defaultSelection } from "../../domain/placeSelection";
import { buildReferenceModel, type ReferenceModel } from "../../domain/referenceData";
import { scoreListing } from "../../domain/scoring";
import { DEFAULT_CONFIG } from "../../domain/scoringConfig";
import type { ChildcareFacility, EnrichedListing, PointOfInterest } from "../../domain/types";
import { REFERENCE_CATALOG_DIR } from "../../storage/json/dataStore";
import { JsonReferenceDataRepository } from "../../storage/json/jsonReferenceDataRepository";
import { comparablePlace, legacyPlaceCatalog } from "../../storage/json/dataMigrations/legacyPlaceCatalog.contract";
import { createHttpWebDataClient } from "./httpClient";

/** Serve public/data/ the way Vite does. */
const fileFetch: typeof fetch = async (input) => {
  const name = String(input).replace(/^\/data\//, "");
  try {
    return new Response(readFileSync(join(WEB_PUBLISH_DIR, name), "utf8"), { status: 200 });
  } catch {
    return new Response("not found", { status: 404 });
  }
};

let listings: readonly EnrichedListing[];
let reference: ReferenceModel;

beforeAll(async () => {
  const client = createHttpWebDataClient({ baseUrl: "/data/", fetch: fileFetch });
  const [listingResult, referenceResult] = await Promise.all([client.queryListings(), client.loadReferenceSnapshot()]);
  listings = listingResult.data.listings;
  reference = buildReferenceModel(referenceResult.data);
});

describe("published web data", () => {
  it("publishes the current managed reference catalog (re-run `npm run data:web` if this fails)", async () => {
    const published = JSON.parse(readFileSync(join(WEB_PUBLISH_DIR, "reference.json"), "utf8")) as unknown;
    const current = await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot();
    expect(published).toEqual(JSON.parse(JSON.stringify(current)));
  });

  it("reproduces the pre-M5 place catalog: every id, category, name, coordinate, subtitle, and the order", () => {
    expect(reference.catalog.places.map(comparablePlace)).toEqual(legacyPlaceCatalog(DATA_DIR).map(comparablePlace));
  });

  it("gives every listing the same score as the original reference files did", () => {
    // The pre-M5 app: the catalog derived from the original files, with the
    // POI roles and facility types those files carried.
    const legacy = legacyPlaceCatalog(DATA_DIR);
    const pois = JSON.parse(readFileSync(join(DATA_DIR, "pois.json"), "utf8")) as PointOfInterest[];
    const childcare = JSON.parse(readFileSync(join(DATA_DIR, "kindergartens.json"), "utf8")) as ChildcareFacility[];
    let poi = 0;
    let facility = 0;
    const legacyPlaces = legacy.map((place): ReferencePlace => {
      if (place.category === "poi") return { ...place, attributes: { legacyRole: pois[poi++].id } };
      if (place.category === "childcare") return { ...place, attributes: { facilityType: childcare[facility++].type } };
      return place;
    });
    const legacyCatalog = buildPlaceCatalog(legacyPlaces);

    const scores = (catalog: typeof legacyCatalog) => {
      const index = new ProximityIndex(listings, catalog);
      const selection = defaultSelection(catalog);
      return listings.map((listing, i) => scoreListing(applySelection(listing, i, index, selection), DEFAULT_CONFIG));
    };
    expect(listings.length).toBeGreaterThan(0);
    expect(scores(reference.catalog)).toEqual(scores(legacyCatalog));
  });
});
