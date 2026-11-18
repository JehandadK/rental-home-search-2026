/**
 * Plan a reference-catalog update from a saved list of elementary schools
 * and childcare facilities (`data/reference/imports/osm-schools-*.json`).
 *
 * The list's records are already reference places in the `school` and
 * `childcare` categories, so they join the scored sets:
 *   - an entry the catalog already has (an active place of the same category
 *     and name within `SAME_PLACE_METRES`) is skipped, so the places migrated
 *     from the original files keep their ids, app ids and order;
 *   - every other entry is upserted under its own id, keeping the app id and
 *     order it was pinned to on an earlier run.
 * Nothing is retired: a list covers some cities only, and the catalog holds
 * places outside them. Records whose content would not change are left
 * alone, so re-running is a no-op. App place ids are pinned for the new
 * places.
 */
import { haversineM } from "../domain/geo";
import type { DatasetChangeSet, ReferencePlaceRecord } from "./contracts";
import { planPlacePins } from "./referencePins";
import { pinnedAttributes, sameContent } from "./referenceImport";

export const SCHOOL_IMPORT_CATEGORIES: readonly string[] = ["school", "childcare"];

/** Two same-named places of a category this close are one place. */
const SAME_PLACE_METRES = 300;

export interface SchoolImportPlan {
  places: DatasetChangeSet<ReferencePlaceRecord>;
  /** List entries skipped because the catalog already has them. */
  matched: readonly { record: ReferencePlaceRecord; catalogId: string }[];
}

export function planSchoolImport(
  current: readonly ReferencePlaceRecord[],
  records: readonly ReferencePlaceRecord[],
  now: string,
): SchoolImportPlan {
  const known = new Map(current.map((place) => [place.id, place]));
  const listedIds = new Set(records.map((record) => record.id));
  // Catalog places the list did not bring in itself, by category and name.
  const others = new Map<string, ReferencePlaceRecord[]>();
  for (const place of current) {
    if (place.status !== "active" || listedIds.has(place.id)) continue;
    const key = `${place.category}\n${place.name}`;
    others.set(key, [...(others.get(key) ?? []), place]);
  }

  const matched: { record: ReferencePlaceRecord; catalogId: string }[] = [];
  const imported: ReferencePlaceRecord[] = [];
  for (const entry of records) {
    if (!SCHOOL_IMPORT_CATEGORIES.includes(entry.category)) throw new Error(`${entry.id} is not a school or childcare record`);
    const same = (others.get(`${entry.category}\n${entry.name}`) ?? [])
      .find((place) => haversineM(place, entry) <= SAME_PLACE_METRES);
    if (same) {
      matched.push({ record: entry, catalogId: same.id });
      continue;
    }
    const previous = known.get(entry.id);
    const record: ReferencePlaceRecord = {
      ...entry,
      attributes: { ...entry.attributes, ...pinnedAttributes(previous) },
      status: "active",
      updatedAt: now,
    };
    imported.push(sameContent(previous, record) ? previous! : record);
  }

  // Pin app ids for new places, after everything already pinned.
  const importedIds = new Set(imported.map((record) => record.id));
  const merged = [...current.filter((place) => !importedIds.has(place.id)), ...imported];
  const pins = new Map(planPlacePins(merged, now).map((record) => [record.id, record]));
  const upsert = imported
    .map((record) => pins.get(record.id) ?? record)
    .filter((record) => !sameContent(known.get(record.id), record));

  return { places: { upsert }, matched };
}
