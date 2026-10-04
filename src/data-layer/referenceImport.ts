/**
 * Plan a reference-catalog update from an official municipal-boundary and
 * railway-station import (MLIT 国土数値情報 N03 and N02).
 *
 * The plan is explicit upserts and retirements, as the catalog requires:
 *   - every municipality becomes a city; a city already in the catalog (same
 *     prefecture and local name) keeps its id and name, new ones get
 *     `city:jp-<code>` and their English name when one is given (the local
 *     name otherwise), updated when it changes; every city records its code
 *     and English prefecture;
 *   - each city gets one boundary for the edition, and the city's older active
 *     boundaries are retired as replaced;
 *   - every station becomes a `railStation` place (map context, not scored),
 *     and imported stations missing from this edition are retired.
 * Records whose content would not change are left alone, so a repeated import
 * is a no-op. App place ids are pinned for the new stations.
 */
import type { BoundaryGeometry } from "../domain/referenceData";
import type {
  CityBoundaryRecord,
  CityRecord,
  DatasetChangeSet,
  ReferencePlaceRecord,
  Retirement,
} from "./contracts";
import { planPlacePins } from "./referencePins";

/** The place category for imported stations: drawn on the map, not used by the scoring. */
export const RAIL_STATION_CATEGORY = "railStation";

export interface ImportedMunicipality {
  code: string;
  prefecture: string;
  name: string;
  county?: string;
  /** English names (from the 総務省 code list), when known. */
  nameEn?: string;
  prefectureEn?: string;
  geometry: BoundaryGeometry;
}

export interface ImportedStation {
  groupCode: string;
  name: string;
  lat: number;
  lon: number;
  operators: readonly string[];
  lines: readonly { operator: string; line: string }[];
  /** Municipality code the station lies in. */
  municipalityCode: string;
}

export interface ReferenceImport {
  /** Boundary edition, e.g. "N03-20260101". */
  boundaryEdition: string;
  /** Station edition, e.g. "N02-25". */
  stationEdition: string;
  municipalities: readonly ImportedMunicipality[];
  stations: readonly ImportedStation[];
}

export interface ReferenceImportPlan {
  cities: DatasetChangeSet<CityRecord>;
  boundaries: DatasetChangeSet<CityBoundaryRecord>;
  places: DatasetChangeSet<ReferencePlaceRecord>;
}

export interface CurrentReference {
  cities: readonly CityRecord[];
  boundaries: readonly CityBoundaryRecord[];
  places: readonly ReferencePlaceRecord[];
}

export function planReferenceImport(current: CurrentReference, input: ReferenceImport, now: string): ReferenceImportPlan {
  const boundarySource = `ksj:${input.boundaryEdition}`;
  const stationSource = `ksj:${input.stationEdition}`;

  // Cities: reuse a catalog city with the same prefecture and local name.
  const existingCity = new Map(current.cities
    .filter((city) => city.status === "active")
    .map((city) => [`${city.prefecture ?? ""}|${city.nameLocal ?? city.name}`, city]));
  const cityIdByCode = new Map<string, string>();
  const cityUpserts: CityRecord[] = [];
  const knownCities = new Map(current.cities.map((city) => [city.id, city]));
  for (const municipality of input.municipalities) {
    const existing = existingCity.get(`${municipality.prefecture}|${municipality.name}`);
    const id = existing?.id ?? `city:jp-${municipality.code}`;
    cityIdByCode.set(municipality.code, id);
    const record: CityRecord = {
      ...existing,
      id,
      // Cities this import created (city:jp-…) take the current English name, so a
      // corrected reading reaches them; curated cities (city:soka…) keep theirs
      // unless they only have the Japanese one.
      name: existing && !existing.id.startsWith("city:jp-") && existing.name !== existing.nameLocal
        ? existing.name
        : municipality.nameEn ?? existing?.name ?? municipality.name,
      nameLocal: municipality.name,
      prefecture: municipality.prefecture,
      ...(municipality.prefectureEn ? { prefectureEn: municipality.prefectureEn } : {}),
      code: municipality.code,
      status: "active",
      updatedAt: now,
    };
    if (!sameContent(knownCities.get(id), record)) cityUpserts.push(record);
  }

  // Boundaries: one per city for this edition; older active ones are replaced.
  const knownBoundaries = new Map(current.boundaries.map((boundary) => [boundary.id, boundary]));
  const boundaryUpserts: CityBoundaryRecord[] = [];
  const boundaryRetirements: Retirement[] = [];
  const editionSlug = input.boundaryEdition.toLowerCase();
  for (const municipality of input.municipalities) {
    const cityId = cityIdByCode.get(municipality.code)!;
    const id = `boundary:${cityId}:${editionSlug}`;
    const record: CityBoundaryRecord = {
      id,
      cityId,
      geometry: municipality.geometry,
      source: boundarySource,
      status: "active",
      updatedAt: now,
    };
    if (!sameContent(knownBoundaries.get(id), record)) boundaryUpserts.push(record);
    for (const older of current.boundaries) {
      if (older.cityId === cityId && older.id !== id && older.status === "active") {
        boundaryRetirements.push({ id: older.id, effectiveAt: now, reason: `Replaced by the ${boundarySource} boundary ${id}` });
      }
    }
  }

  // Stations: map-context places, one per N02 station group.
  const knownPlaces = new Map(current.places.map((place) => [place.id, place]));
  const imported: ReferencePlaceRecord[] = [];
  for (const station of input.stations) {
    const id = `${RAIL_STATION_CATEGORY}:${station.groupCode}`;
    const previous = knownPlaces.get(id);
    const record: ReferencePlaceRecord = {
      id,
      category: RAIL_STATION_CATEGORY,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      subtitle: station.operators.join("・"),
      attributes: {
        // Keep the pinned app id and order the record already has.
        ...pinnedAttributes(previous),
        operators: station.operators.join("・"),
        lines: station.lines.map(({ operator, line }) => `${operator} ${line}`).join("・"),
        lineCount: station.lines.length,
        cityId: cityIdByCode.get(station.municipalityCode) ?? null,
        ksjGroupCode: station.groupCode,
        source: stationSource,
      },
      status: "active",
      updatedAt: now,
    };
    imported.push(sameContent(previous, record) ? previous! : record);
  }
  const importedIds = new Set(imported.map((record) => record.id));
  const placeRetirements: Retirement[] = current.places
    .filter((place) => place.category === RAIL_STATION_CATEGORY && place.status === "active" && !importedIds.has(place.id))
    .map((place) => ({ id: place.id, effectiveAt: now, reason: `Not in the ${stationSource} station data` }));

  // Pin app ids for stations that have none yet, after everything already pinned.
  const merged = [...current.places.filter((place) => !importedIds.has(place.id)), ...imported];
  const pins = new Map(planPlacePins(merged, now).map((record) => [record.id, record]));
  const placeUpserts = imported
    .map((record) => pins.get(record.id) ?? record)
    .filter((record) => !sameContent(knownPlaces.get(record.id), record));

  return {
    cities: { upsert: cityUpserts },
    boundaries: { upsert: boundaryUpserts, retire: boundaryRetirements },
    places: { upsert: placeUpserts, retire: placeRetirements },
  };
}

function pinnedAttributes(record: ReferencePlaceRecord | undefined): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  const id = record?.attributes?.appPlaceId;
  const order = record?.attributes?.appOrder;
  if (typeof id === "string") result.appPlaceId = id;
  if (typeof order === "number") result.appOrder = order;
  return result;
}

/** Same record apart from its update time. */
function sameContent<T extends { updatedAt: string }>(previous: T | undefined, next: T): boolean {
  if (!previous) return false;
  return stableJson({ ...previous, updatedAt: "" }) === stableJson({ ...next, updatedAt: "" });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner);
}
