/**
 * Test oracle (shared harness): the pre-M5 place catalog, computed with the
 * app's original algorithm directly from the original reference files.
 * Saved place selections store these ids.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildcareFacility, Mosque, NamedPlace, PointOfInterest, Station } from "../../../domain/types";

export interface LegacyCatalogPlace {
  id: string;
  category: string;
  name: string;
  lat: number;
  lon: number;
  subtitle?: string;
}

export function legacyPlaceCatalog(dataDir: string): LegacyCatalogPlace[] {
  const legacy = <T>(file: string): T => JSON.parse(readFileSync(join(dataDir, file), "utf8")) as T;
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

/** The fields a place catalog must reproduce, with unset subtitles normalised. */
export const comparablePlace = (p: LegacyCatalogPlace) =>
  ({ id: p.id, category: p.category, name: p.name, lat: p.lat, lon: p.lon, subtitle: p.subtitle || undefined });
