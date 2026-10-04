/**
 * Plan a reference-catalog update from a saved Google Maps masjid list
 * (`data/reference/imports/google-maps-masjids-japan.json`).
 *
 * The list's records are already reference places in the `mosque` category,
 * so they join the scored mosque set:
 *   - an entry the capture matched to a catalog mosque (`catalogMatchId`) is
 *     that mosque already and is skipped, so the hand-picked records keep
 *     their names, ids and order;
 *   - every other entry is upserted under its own id, keeping the app id and
 *     order it was pinned to on an earlier run;
 *   - an entry saved as retired (an unbuilt mosque, a duplicate pin) is
 *     retired in the catalog with its reason and never re-imported;
 *   - list mosques imported earlier but missing from this list are retired.
 * Records whose content would not change are left alone, so re-running is a
 * no-op. App place ids are pinned for the new mosques.
 */
import type { DatasetChangeSet, ReferencePlaceRecord, Retirement } from "./contracts";
import { planPlacePins } from "./referencePins";
import { pinnedAttributes, sameContent } from "./referenceImport";

/** The `source` attribute every list record carries. */
export const MASJID_LIST_SOURCE = "Google Maps shared list";

/** Capture-time de-duplication hints, not catalog data. */
const MATCH_ATTRIBUTES = ["catalogMatchId", "catalogMatchName", "catalogMatchDistM"] as const;

export interface MasjidListImport {
  /** Google's id for the list (`provenance.listId` in the saved file). */
  listId: string;
  records: readonly ReferencePlaceRecord[];
}

export interface MasjidImportPlan {
  places: DatasetChangeSet<ReferencePlaceRecord>;
  /** List entries skipped because the catalog already has them. */
  matched: readonly { record: ReferencePlaceRecord; catalogId: string }[];
}

export function planMasjidImport(
  current: readonly ReferencePlaceRecord[],
  input: MasjidListImport,
  now: string,
): MasjidImportPlan {
  const known = new Map(current.map((place) => [place.id, place]));
  const matched: { record: ReferencePlaceRecord; catalogId: string }[] = [];
  const imported: ReferencePlaceRecord[] = [];
  const retire: Retirement[] = [];
  for (const entry of input.records) {
    if (entry.category !== "mosque") throw new Error(`${entry.id} is not a mosque record`);
    if (entry.status === "retired") {
      if (!entry.retirementReason) throw new Error(`${entry.id} is retired without a retirementReason`);
      if (known.get(entry.id)?.status === "active") {
        retire.push({ id: entry.id, effectiveAt: entry.retiredAt ?? now, reason: entry.retirementReason });
      }
      continue;
    }
    const matchId = entry.attributes?.catalogMatchId;
    if (typeof matchId === "string" && known.get(matchId)?.status === "active") {
      matched.push({ record: entry, catalogId: matchId });
      continue;
    }
    const previous = known.get(entry.id);
    const attributes = { ...entry.attributes };
    for (const key of MATCH_ATTRIBUTES) delete attributes[key];
    const record: ReferencePlaceRecord = {
      ...entry,
      attributes: { ...attributes, ...pinnedAttributes(previous), source: MASJID_LIST_SOURCE, googleListId: input.listId },
      status: "active",
      updatedAt: now,
    };
    imported.push(sameContent(previous, record) ? previous! : record);
  }

  const importedIds = new Set(imported.map((record) => record.id));
  const listedIds = new Set(input.records.map((record) => record.id));
  for (const place of current) {
    if (place.category === "mosque" && place.status === "active" && !listedIds.has(place.id)
      && place.attributes?.source === MASJID_LIST_SOURCE && place.attributes?.googleListId === input.listId) {
      retire.push({ id: place.id, effectiveAt: now, reason: `No longer in Google Maps list ${input.listId}` });
    }
  }

  // Pin app ids for new mosques, after everything already pinned.
  const merged = [...current.filter((place) => !importedIds.has(place.id)), ...imported];
  const pins = new Map(planPlacePins(merged, now).map((record) => [record.id, record]));
  const upsert = imported
    .map((record) => pins.get(record.id) ?? record)
    .filter((record) => !sameContent(known.get(record.id), record));

  return { places: { upsert, retire }, matched };
}
