/**
 * Plan a reference-catalog update from one UR sweep: every UR estate (団地)
 * of the swept cities becomes a `urDanchi` place, so the map can show it
 * whether or not it has a vacancy.
 *
 *   - an estate is upserted under `urDanchi:{UR code}`, keeping the app id
 *     and order it was pinned to on an earlier run. Vacancies are not kept
 *     (they are the estate's `ur` listings), so a sweep rewrites an estate
 *     only when UR changes its name, address, position or buildings;
 *   - an estate of a swept city that UR no longer lists is retired (UR's city
 *     list is the whole estate set, so absence there is UR's own word);
 *     estates of cities not in this sweep are left alone;
 *   - a record whose content would not change is left alone, so re-running
 *     with the same sweep is a no-op. App ids are pinned for new estates.
 */
import { UR_PLACE_CATEGORY, type UrEstateAttributes, type UrEstateObservation } from "../domain/ur";
import type { CityRecord, DatasetChangeSet, ReferencePlaceRecord, Retirement } from "./contracts";
import { planPlacePins } from "./referencePins";
import { pinnedAttributes, sameContent } from "./referenceImport";

export const urEstatePlaceId = (code: string): string => `${UR_PLACE_CATEGORY}:${code}`;

export interface UrEstateImportPlan {
  places: DatasetChangeSet<ReferencePlaceRecord>;
  /** Estates whose city code is not in the catalog: not imported. */
  unknownCity: readonly UrEstateObservation[];
}

export function planUrEstateImport(
  current: readonly ReferencePlaceRecord[],
  cities: readonly CityRecord[],
  estates: readonly UrEstateObservation[],
  sweptCityCodes: readonly string[],
  now: string,
): UrEstateImportPlan {
  const known = new Map(current.map((place) => [place.id, place]));
  const cityByCode = new Map(cities.filter((city) => city.status === "active" && city.code).map((city) => [city.code!, city]));
  const unknownCity: UrEstateObservation[] = [];
  const imported: ReferencePlaceRecord[] = [];
  for (const estate of estates) {
    const city = cityByCode.get(estate.cityCode);
    if (!city) { unknownCity.push(estate); continue; }
    const id = urEstatePlaceId(estate.code);
    const previous = known.get(id);
    const attributes: UrEstateAttributes = {
      source: "UR都市機構", urCode: estate.code, url: estate.url, cityId: city.id,
      floors: estate.floors, structure: estate.structure,
    };
    const record: ReferencePlaceRecord = {
      id, category: UR_PLACE_CATEGORY, name: estate.name, nameLocal: estate.name, address: estate.address,
      lat: estate.lat, lon: estate.lon, subtitle: `UR賃貸 · ${city.nameLocal ?? city.name}`,
      attributes: { ...attributes, ...pinnedAttributes(previous) },
      status: "active", updatedAt: now,
    };
    imported.push(sameContent(previous, record) ? previous! : record);
  }

  const importedIds = new Set(imported.map((record) => record.id));
  const sweptCityIds = new Set(sweptCityCodes.map((code) => cityByCode.get(code)?.id).filter(Boolean));
  const retire: Retirement[] = current
    .filter((place) => place.category === UR_PLACE_CATEGORY && place.status === "active" && !importedIds.has(place.id)
      && sweptCityIds.has(place.attributes?.cityId as string))
    .map((place) => ({ id: place.id, effectiveAt: now, reason: "No longer in UR's estate list for its city" }));

  const merged = [...current.filter((place) => !importedIds.has(place.id)), ...imported];
  const pins = new Map(planPlacePins(merged, now).map((record) => [record.id, record]));
  const upsert = imported
    .map((record) => pins.get(record.id) ?? record)
    .filter((record) => !sameContent(known.get(record.id), record));
  return { places: { upsert, retire }, unknownCity };
}
