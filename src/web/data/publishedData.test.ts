/**
 * The published assets (public/data/) are what the app loads. They must be
 * current with the managed catalog, load through the runtime client, and
 * pin an app id on every place, since saved place selections store those ids.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReferenceDataSnapshot } from "../../data-layer/contracts";
import { WEB_PUBLISH_DIR } from "../../node/dataPaths";
import { buildReferenceModel } from "../../domain/referenceData";
import { REFERENCE_CATALOG_DIR } from "../../storage/json/dataStore";
import { JsonReferenceDataRepository } from "../../storage/json/jsonReferenceDataRepository";
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

const published = () => JSON.parse(readFileSync(join(WEB_PUBLISH_DIR, "reference.json"), "utf8")) as ReferenceDataSnapshot;

describe("published web data", () => {
  it("publishes the current managed reference catalog (re-run `npm run data:web` if this fails)", async () => {
    const current = await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot();
    expect(published()).toEqual(JSON.parse(JSON.stringify(current)));
  });

  it("pins an app id on every published place (run `npm run data:reference:app-ids` if this fails)", () => {
    const unpinned = published().places.records
      .filter((record) => record.status === "active" && typeof record.attributes?.appPlaceId !== "string")
      .map((record) => record.id);
    expect(unpinned).toEqual([]);
  });

  it("loads through the runtime client into a usable reference model", async () => {
    const client = createHttpWebDataClient({ baseUrl: "/data/", fetch: fileFetch });
    const [listings, reference] = await Promise.all([client.queryListings(), client.loadReferenceSnapshot()]);
    expect(listings.data.listings.length).toBeGreaterThan(0);
    const model = buildReferenceModel(reference.data);
    expect(model.catalog.withRole("poi1")).toBeDefined();
    expect(model.boundaries.length).toBeGreaterThan(0);
  });
});
