/**
 * Saved place selections store catalog ids, so the ids, order, and place
 * details the app derives must not change while reference data moves from
 * bundled files to an injected snapshot. The oracle below is the pre-M5
 * catalog algorithm, applied to the original reference files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "../../node/dataPaths";
import type { ChildcareFacility, Mosque, NamedPlace, PointOfInterest, Station } from "../../domain/types";
import { BUNDLED_REFERENCE } from "./bundledClient";

const PLACE_CATALOG = BUNDLED_REFERENCE.catalog;

const legacy = <T>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T;

interface LegacyCatalogPlace { id: string; name: string; lat: number; lon: number; category: string; subtitle?: string }

function legacyPlaceCatalog(): LegacyCatalogPlace[] {
  const places: Omit<LegacyCatalogPlace, "id">[] = [
    ...legacy<PointOfInterest[]>("pois.json").map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, category: "poi", subtitle: p.address })),
    ...legacy<Mosque[]>("mosques.json").map((m) => ({ name: m.name, lat: m.lat, lon: m.lon, category: "mosque", subtitle: m.address })),
    ...legacy<Station[]>("stations.json").map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, category: "station", subtitle: s.operator ?? undefined })),
    ...legacy<NamedPlace[]>("elementary_schools.json").map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, category: "school" })),
    ...legacy<ChildcareFacility[]>("kindergartens.json").map((c) => ({ name: c.name, lat: c.lat, lon: c.lon, category: "childcare", subtitle: c.type })),
    ...legacy<NamedPlace[]>("bus_stops.json").map((b) => ({ name: b.name, lat: b.lat, lon: b.lon, category: "busStop" })),
  ];
  const used = new Map<string, number>();
  return places.map((p) => {
    const base = `${p.category}:${p.name}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return { ...p, id: seen === 0 ? base : `${base}#${seen}` };
  });
}

const comparable = (p: LegacyCatalogPlace) =>
  ({ id: p.id, category: p.category, name: p.name, lat: p.lat, lon: p.lon, subtitle: p.subtitle || undefined });

describe("place catalog parity with the pre-M5 catalog", () => {
  it("keeps every id, category, name, coordinate, subtitle, and the order", () => {
    const expected = legacyPlaceCatalog();
    expect(expected.length).toBeGreaterThan(0);
    expect(PLACE_CATALOG.places.map(comparable)).toEqual(expected.map(comparable));
  });

  it("keeps the POI scoring roles on the original POI records", () => {
    const pois = legacy<PointOfInterest[]>("pois.json");
    expect(PLACE_CATALOG.withRole("poi1")?.name).toBe(pois.find((p) => p.id === "poi1")?.name);
    expect(PLACE_CATALOG.withRole("poi2")?.name).toBe(pois.find((p) => p.id === "poi2")?.name);
  });
});
