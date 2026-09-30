import type { RawListing } from "../../domain/types";
import { parseFloors } from "../../domain/japaneseText";
import type { SourceFieldCorrection } from "./contracts";

/** "築5年・1階・管理費込" → the floor segment, if present. */
function floorFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const segment = notes.split("・").find((part) => /階/.test(part) && !/階建/.test(part));
  return segment?.trim() || null;
}

/** v1 preserves the existing backfill's rules; it never infers an admin fee amount. */
export function backfillSuumoNotes(listing: RawListing): RawListing {
  const floor = listing.building?.floor ?? floorFromNotes(listing.notes);
  const { totalFloors } = parseFloors(floor ?? undefined);
  const next: RawListing = { ...listing };
  if (floor) {
    next.building = { ...listing.building, floor, ...(totalFloors ? { totalFloors } : {}) };
  }
  if (listing.notes?.includes("管理費込") && listing.costs?.adminFeeYen === undefined) {
    next.costs = { ...listing.costs, adminFeeYen: null };
  }
  return next;
}

/** Capture only the three fields this reviewed rule can change. */
export function suumoNoteChanges(before: RawListing, after: RawListing): SourceFieldCorrection[] {
  const values: [SourceFieldCorrection["field"], string | number | null | undefined, string | number | null | undefined][] = [
    ["building.floor", before.building?.floor, after.building?.floor],
    ["building.totalFloors", before.building?.totalFloors, after.building?.totalFloors],
    ["costs.adminFeeYen", before.costs?.adminFeeYen, after.costs?.adminFeeYen],
  ];
  return values.flatMap(([field, prior, next]) => prior === next || next === undefined ? []
    : [{ field, ...(prior === undefined ? {} : { before: prior }), after: next }]);
}
