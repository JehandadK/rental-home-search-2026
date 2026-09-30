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
   * category". For target parameters (poi1/poi2) the first id wins.
   */
  byParameter: Record<DistanceParameterKey, string[] | null>;
}

/**
 * Default selection: the first POI (Al Sanad) as the target; everything else,
 * including the mosque, is the nearest of every place in its category.
 */
export function defaultSelection(catalog: PlaceCatalog): PlaceSelection {
  const firstPoi = catalog.inCategory(PARAMETER_SOURCES.poi1.category)[0];
  return {
    byParameter: {
      poi1: firstPoi ? [firstPoi.id] : null,
      poi2: null,
      station: null,
      busStop: null,
      kindergarten: null,
      school: null,
    },
  };
}

/** Ids selected for a parameter, as a lookup set (null = unrestricted). */
function allowedSet(selection: PlaceSelection, key: DistanceParameterKey): Set<string> | null {
  const ids = selection.byParameter[key];
  if (ids == null || ids.length === 0) return null;
  return new Set(ids);
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
    const source = PARAMETER_SOURCES[key];
    const allowed = allowedSets[key];

    if (source.mode === "target") {
      const targetId = selection.byParameter[key]?.[0];
      const proximity = targetId ? index.proximityToPlace(listingIndex, targetId) : null;
      assign(next, key, proximity);
      continue;
    }

    assign(next, key, index.nearestIn(listingIndex, source.category, allowed));
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
  const source = PARAMETER_SOURCES[key];
  if (ids == null || ids.length === 0) {
    return source.mode === "target" ? "none chosen" : "nearest of all";
  }
  if (source.mode === "target") {
    return catalog.byId.get(ids[0])?.name ?? "unknown";
  }
  if (ids.length === 1) return `only ${catalog.byId.get(ids[0])?.name ?? "1 place"}`;
  return `nearest of ${ids.length} chosen`;
}
