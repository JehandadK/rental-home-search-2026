/**
 * App-facing place identity (M5). Saved place selections store the id the
 * app derives for each place, so every active catalog place is pinned to
 * that id and to its position in the app's list. This plans the pins for
 * places that do not have one yet (places added since the last pinning):
 * the id and position the app gives them now, never an id already pinned
 * to another record, retired ones included.
 */
import { APP_ORDER_ATTRIBUTE, APP_PLACE_ID_ATTRIBUTE, buildPlaceCatalog } from "../domain/places";
import type { ReferencePlaceRecord } from "./contracts";

/** The records to upsert; empty when every active place is already pinned. */
export function planPlacePins(current: readonly ReferencePlaceRecord[], updatedAt: string): ReferencePlaceRecord[] {
  const appIds = new Map(buildPlaceCatalog(current).places.map((place) => [place.recordId, place.id]));
  let nextOrder = Math.max(-1, ...current.map((record) => {
    const order = record.attributes?.[APP_ORDER_ATTRIBUTE];
    return typeof order === "number" ? order : -1;
  })) + 1;
  const changes: ReferencePlaceRecord[] = [];
  // Catalog order: pinned places first, then unpinned ones in record order.
  for (const record of current) {
    if (record.status !== "active" || typeof record.attributes?.[APP_PLACE_ID_ATTRIBUTE] === "string") continue;
    const appPlaceId = appIds.get(record.id);
    if (!appPlaceId) continue;
    changes.push({
      ...record,
      attributes: { ...record.attributes, [APP_PLACE_ID_ATTRIBUTE]: appPlaceId, [APP_ORDER_ATTRIBUTE]: nextOrder++ },
      updatedAt,
    });
  }
  return changes;
}
