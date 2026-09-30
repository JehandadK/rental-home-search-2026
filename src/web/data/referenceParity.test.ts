/**
 * Saved place selections store catalog ids, so the ids, order, and place
 * details the app derives must not change while reference data moves from
 * bundled files to an injected snapshot. The oracle is the pre-M5 catalog
 * algorithm applied to the original reference files.
 */
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "../../node/dataPaths";
import { comparablePlace, legacyPlaceCatalog } from "../../storage/json/dataMigrations/legacyPlaceCatalog.contract";
import { BUNDLED_REFERENCE } from "./bundledClient";

const PLACE_CATALOG = BUNDLED_REFERENCE.catalog;

describe("place catalog parity with the pre-M5 catalog", () => {
  it("keeps every id, category, name, coordinate, subtitle, and the order", () => {
    const expected = legacyPlaceCatalog(DATA_DIR);
    expect(expected.length).toBeGreaterThan(0);
    expect(PLACE_CATALOG.places.map(comparablePlace)).toEqual(expected.map(comparablePlace));
  });
});

describe("managed reference catalog parity with the pre-M5 catalog", () => {
  it("reproduces every app id, category, name, coordinate, subtitle, and the order", async () => {
    const { JsonReferenceDataRepository } = await import("../../storage/json/jsonReferenceDataRepository");
    const { REFERENCE_CATALOG_DIR } = await import("../../storage/json/dataStore");
    const { buildReferenceModel } = await import("../../domain/referenceData");
    const { catalog } = buildReferenceModel(await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot());
    expect(catalog.places.map(comparablePlace)).toEqual(legacyPlaceCatalog(DATA_DIR).map(comparablePlace));
  });
});
