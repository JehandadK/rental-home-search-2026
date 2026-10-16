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
import { packListings, unpackListings, type WebPayload } from "../../domain/webPayload";
import { REFERENCE_CATALOG_DIR } from "../../storage/json/dataStore";
import { JsonReferenceDataRepository } from "../../storage/json/jsonReferenceDataRepository";
import { createHttpWebDataClient } from "./httpClient";
import { CHECKED_IN_DATA_TIMEOUT_MS } from "../../storage/json/checkedInData.contract";

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

describe("published web data", { timeout: CHECKED_IN_DATA_TIMEOUT_MS }, () => {
  it("publishes the current managed reference catalog (re-run `npm run data:web` if this fails)", async () => {
    const current = await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot();
    expect(published()).toEqual(JSON.parse(JSON.stringify(current)));
  });

  it("publishes listings in the current payload layout, compact (re-run `npm run data:web` if this fails)", () => {
    // What `npm run data:web` writes: the layout packListings makes today, with no indentation.
    // A collector run, or a change to the layout, that leaves the file in another shape fails here.
    const text = readFileSync(join(WEB_PUBLISH_DIR, "listings.json"), "utf8");
    const payload = JSON.parse(text) as WebPayload;
    expect(payload.schemaVersion).toBe(packListings([]).schemaVersion);
    expect(text.trim()).toBe(JSON.stringify(packListings(unpackListings(payload))));
  });

  it("pins an app id on every published place (run `npm run data:reference:app-ids` if this fails)", () => {
    const unpinned = published().places.records
      .filter((record) => record.status === "active" && typeof record.attributes?.appPlaceId !== "string")
      .map((record) => record.id);
    expect(unpinned).toEqual([]);
  });

  it("covers Kanto and the prefectures around it, each with boundaries and rail stations to draw", () => {
    const { cities, boundaries, places } = published();
    const prefectures = new Map<string, string>();
    for (const city of cities.records) if (city.status !== "retired" && city.prefectureEn) prefectures.set(city.id, city.prefectureEn);
    const withBoundary = new Set(boundaries.records.filter((b) => b.status !== "retired").map((b) => prefectures.get(b.cityId)));
    const withStations = new Set(places.records
      .filter((p) => p.category === "railStation" && p.status === "active")
      .map((p) => prefectures.get(String(p.attributes?.cityId))));
    const expected = ["Ibaraki", "Tochigi", "Gunma", "Saitama", "Chiba", "Tokyo", "Kanagawa", "Fukushima", "Yamanashi", "Nagano", "Shizuoka"];
    expect(expected.filter((name) => !withBoundary.has(name))).toEqual([]);
    expect(expected.filter((name) => !withStations.has(name))).toEqual([]);
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
