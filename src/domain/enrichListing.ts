/**
 * Turn coordinates into a fully enriched listing by measuring proximities
 * to every reference category. Shared by the batch enrichment script and
 * the "add a listing" form — one code path, one behaviour.
 *
 * Note: since the dashboard gained runtime place selection, the app no
 * longer depends on these baked-in proximities — `ProximityIndex` recomputes
 * every distance in the browser so the user can change which places count.
 * They are kept because they make `listings.json` self-describing (useful
 * for the CLI ranker, exports and eyeballing the data) and they are the
 * fallback for any consumer that does not build an index.
 *
 * The baked `poi1`/`poi2` fields follow the places carrying those scoring
 * roles; any number of other POIs can exist in the catalog.
 */
import type { EnrichedListing, GeoPoint, RawListing } from "./types";
import { nearestPlace, toProximity } from "./geo";
import { isKindergarten, type CatalogPlace, type PlaceCatalog } from "./places";

/** Default walking-time estimation knobs, mirroring DEFAULT_CONFIG. */
const WALK_SPEED_M_PER_MIN = 80;
const DETOUR_FACTOR = 1.3;

export function enrichListing(
  raw: RawListing,
  coords: GeoPoint,
  matched: string | undefined,
  catalog: PlaceCatalog,
): EnrichedListing {
  const toPlace = (place: CatalogPlace | undefined) =>
    place ? toProximity(coords, place, WALK_SPEED_M_PER_MIN, DETOUR_FACTOR) : undefined;
  const proximityTo = (places: readonly CatalogPlace[]) => toPlace(nearestPlace(coords, places)?.place);

  return {
    ...raw,
    geocoded: true,
    lat: coords.lat,
    lon: coords.lon,
    geocodeMatched: matched,
    poi1: toPlace(catalog.withRole("poi1")),
    poi2: toPlace(catalog.withRole("poi2")),
    station: proximityTo(catalog.inCategory("station")),
    busStop: proximityTo(catalog.inCategory("busStop")),
    school: proximityTo(catalog.inCategory("school")),
    kindergarten: proximityTo(catalog.inCategory("childcare").filter(isKindergarten)),
    childcareAny: proximityTo(catalog.inCategory("childcare")),
  };
}
