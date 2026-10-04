/**
 * The reference data the app works with: cities, their boundaries, and the
 * place catalog, built from one loaded reference snapshot.
 *
 * The input shapes are structural, so the data layer's
 * `ReferenceDataSnapshot` can be passed in directly; the domain does not
 * depend on how or where the snapshot was stored.
 */
import { buildPlaceCatalog, type PlaceCatalog, type ReferencePlace } from "./places";

/** GeoJSON-like coordinates are [longitude, latitude] pairs. */
export type Position = readonly [longitude: number, latitude: number];
export type PolygonCoordinates = readonly (readonly Position[])[];

/** Polygon and multipolygon both support cities with multiple boundary pieces. */
export type BoundaryGeometry =
  | { type: "Polygon"; coordinates: PolygonCoordinates }
  | { type: "MultiPolygon"; coordinates: readonly PolygonCoordinates[] };

export interface ReferenceCity {
  id: string;
  name: string;
  nameLocal?: string;
  /** 埼玉県, 東京都…; the map draws borders between prefectures. */
  prefecture?: string;
  /** English prefecture name (Saitama). */
  prefectureEn?: string;
  /** 5-digit municipality code, for ordering. */
  code?: string;
  status?: "active" | "retired";
}

export interface ReferenceBoundary {
  id: string;
  cityId: string;
  geometry: BoundaryGeometry;
  status?: "active" | "retired";
}

/** Any snapshot with city, boundary, and place records. */
export interface ReferenceSnapshotLike {
  revision: string;
  cities: { records: readonly ReferenceCity[] };
  boundaries: { records: readonly ReferenceBoundary[] };
  places: { records: readonly ReferencePlace[] };
}

export interface ReferenceModel {
  revision: string;
  catalog: PlaceCatalog;
  /** Active cities, in snapshot order. */
  cities: readonly ReferenceCity[];
  /** Active boundaries of active cities; a city may have several. */
  boundaries: readonly ReferenceBoundary[];
}

export function buildReferenceModel(snapshot: ReferenceSnapshotLike): ReferenceModel {
  const cities = snapshot.cities.records.filter((city) => city.status !== "retired");
  const cityIds = new Set(cities.map((city) => city.id));
  return {
    revision: snapshot.revision,
    catalog: buildPlaceCatalog(snapshot.places.records),
    cities,
    boundaries: snapshot.boundaries.records.filter(
      (boundary) => boundary.status !== "retired" && cityIds.has(boundary.cityId),
    ),
  };
}

/** "Soka · 草加" for a city with a local name; the name alone otherwise. */
export function cityLabel(city: ReferenceCity): string {
  const local = city.nameLocal?.replace(/[市区町村]$/u, "");
  return local && local !== city.name ? `${city.name} · ${local}` : city.name;
}
