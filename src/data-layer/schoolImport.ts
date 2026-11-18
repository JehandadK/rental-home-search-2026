/**
 * Plan a reference-catalog update from a saved list of elementary schools
 * and childcare facilities (`data/reference/imports/osm-schools-*.json`).
 *
 * The list's records are already reference places in the `school` and
 * `childcare` categories, so they join the scored sets:
 *   - an entry the catalog already has (an active place of the same category
 *     and name within `SAME_PLACE_METRES`) is not imported again: the place
 *     migrated from the original files keeps its id, name, position, app id
 *     and order, and gains the entry's address and attributes (its English
 *     name, its city, what is known about the school);
 *   - every other entry is upserted under its own id, keeping the app id and
 *     order it was pinned to on an earlier run;
 *   - an entry saved as retired (a school that closed or merged, which the
 *     source still maps) retires the catalog's place with its reason, and is
 *     never imported.
 * Places missing from the list are left alone: a list covers some cities
 * only, and the catalog holds places outside them. Records whose content would not change are left
 * alone, so re-running is a no-op. App place ids are pinned for the new
 * places.
 */
import { haversineM } from "../domain/geo";
import type { DatasetChangeSet, ReferencePlaceRecord, Retirement } from "./contracts";
import { planPlacePins } from "./referencePins";
import { pinnedAttributes, sameContent } from "./referenceImport";

export const SCHOOL_IMPORT_CATEGORIES: readonly string[] = ["school", "childcare"];

/** Two same-named places of a category this close are one place. */
const SAME_PLACE_METRES = 300;

export interface SchoolImportPlan {
  places: DatasetChangeSet<ReferencePlaceRecord>;
  /** List entries the catalog already has under another id. */
  matched: readonly { record: ReferencePlaceRecord; catalogId: string }[];
  /** How many of the matched catalog places gain or change attributes. */
  enriched: number;
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
  // By catalog id: two list entries may be the same catalog place.
  const enriched = new Map<string, ReferencePlaceRecord>();
  const retire: Retirement[] = [];
  for (const entry of records) {
    if (!SCHOOL_IMPORT_CATEGORIES.includes(entry.category)) throw new Error(`${entry.id} is not a school or childcare record`);
    const same = (others.get(`${entry.category}\n${entry.name}`) ?? [])
      .find((place) => haversineM(place, entry) <= SAME_PLACE_METRES);
    if (entry.status === "retired") {
      if (!entry.retirementReason) throw new Error(`${entry.id} is retired without a retirementReason`);
      const gone = same ?? (known.get(entry.id)?.status === "active" ? known.get(entry.id) : undefined);
      if (gone) retire.push({ id: gone.id, effectiveAt: entry.retiredAt ?? now, reason: entry.retirementReason });
      continue;
    }
    if (same) {
      matched.push({ record: entry, catalogId: same.id });
      const base = enriched.get(same.id) ?? same;
      const record: ReferencePlaceRecord = {
        ...base,
        ...(entry.address ? { address: entry.address } : {}),
        attributes: { ...base.attributes, ...entry.attributes, ...pinnedAttributes(same) },
        updatedAt: now,
      };
      if (!sameContent(same, record)) enriched.set(same.id, record);
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

  // A place the list retires is not also updated.
  for (const { id } of retire) enriched.delete(id);
  return { places: { upsert: [...enriched.values(), ...upsert], ...(retire.length ? { retire } : {}) }, matched, enriched: enriched.size };
}
