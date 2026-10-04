/**
 * Which places each distance parameter measures against.
 *
 * `null` means "use every place in the category" (the default, equivalent to
 * the old baked-in nearest-anything behaviour). A set of ids narrows it: only
 * the stations you would actually use, only the schools your children could
 * attend, only 幼稚園 rather than every daycare, and so on.
 */
import type { EnrichedListing } from "./types";
import { PARAMETER_SOURCES, type DistanceParameterKey, type PlaceCatalog } from "./places";
import type { ProximityIndex } from "./proximityIndex";

export interface PlaceSelection {
  /**
   * Per parameter: the chosen place ids, or null for "any place in the
   * category". The score measures the nearest of the chosen places.
   */
  byParameter: Record<DistanceParameterKey, string[] | null>;
}

/**
 * Default selection: every parameter, including the private school and the
 * mosque, is the nearest of every place in its category.
 */
export function defaultSelection(): PlaceSelection {
  return {
    byParameter: {
      poi1: null,
      poi2: null,
      station: null,
      busStop: null,
      kindergarten: null,
      school: null,
    },
  };
}

/** Ids selected for a parameter, as a lookup set (null = unrestricted, empty = cleared). */
function allowedSet(selection: PlaceSelection, key: DistanceParameterKey): Set<string> | null {
  const ids = selection.byParameter[key];
  return ids == null ? null : new Set(ids);
}

/** Build selection lookup sets once per complete listing pass, not once per row. */
export function selectionAllowedSets(
  selection: PlaceSelection,
): Record<DistanceParameterKey, Set<string> | null> {
  return Object.fromEntries(
    (Object.keys(PARAMETER_SOURCES) as DistanceParameterKey[]).map((key) => [key, allowedSet(selection, key)]),
  ) as Record<DistanceParameterKey, Set<string> | null>;
}

/**
 * Recompute every distance-based proximity for one listing according to the
 * current selection. Returns a shallow copy; scoring turns metres into
 * minutes using the travel-mode knobs.
 */
export function applySelection(
  listing: EnrichedListing,
  listingIndex: number,
  index: ProximityIndex,
  selection: PlaceSelection,
  allowedSets = selectionAllowedSets(selection),
): EnrichedListing {
  const next: EnrichedListing = { ...listing };

  for (const key of Object.keys(PARAMETER_SOURCES) as DistanceParameterKey[]) {
    assign(next, key, index.nearestIn(listingIndex, PARAMETER_SOURCES[key].category, allowedSets[key]));
  }

  // Childcare has a second view: "any facility including 保育園". When the
  // user has hand-picked facilities, both views honour that pick.
  const childcareAllowed = allowedSets.kindergarten;
  next.childcareAny =
    index.nearestIn(listingIndex, "childcare", childcareAllowed) ?? undefined;

  return next;
}

/** Write a proximity onto the listing field that matches the parameter. */
function assign(
  listing: EnrichedListing,
  key: DistanceParameterKey,
  proximity: ReturnType<ProximityIndex["nearestIn"]>,
): void {
  const value = proximity ?? undefined;
  switch (key) {
    case "poi1":
      listing.poi1 = value;
      break;
    case "poi2":
      listing.poi2 = value;
      break;
    case "station":
      listing.station = value;
      break;
    case "busStop":
      listing.busStop = value;
      break;
    case "kindergarten":
      listing.kindergarten = value;
      break;
    case "school":
      listing.school = value;
      break;
  }
}

/** Human summary of a parameter's current selection, for the panel. */
export function describeSelection(
  selection: PlaceSelection,
  key: DistanceParameterKey,
  catalog: PlaceCatalog,
): string {
  const ids = selection.byParameter[key];
  if (ids == null || ids.length === 0) return "nearest of all";
  if (ids.length === 1) return `only ${catalog.byId.get(ids[0])?.name ?? "1 place"}`;
  return `nearest of ${ids.length} chosen`;
}
