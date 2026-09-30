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
 */
import type { EnrichedListing, GeoPoint, RawListing } from "./types";
import { toProximity } from "./geo";
import {
  BUS_STOPS,
  CHILDCARE_FACILITIES,
  ELEMENTARY_SCHOOLS,
  KINDERGARTENS_ONLY,
  POINTS_OF_INTEREST,
  STATIONS,
} from "./reference";
import { nearestPlace } from "./geo";

/** Default walking-time estimation knobs, mirroring DEFAULT_CONFIG. */
const WALK_SPEED_M_PER_MIN = 80;
const DETOUR_FACTOR = 1.3;

export function enrichListing(raw: RawListing, coords: GeoPoint, matched?: string): EnrichedListing {
  const proximityTo = (places: Parameters<typeof nearestPlace>[1]) => {
    const nearest = nearestPlace(coords, places);
    if (!nearest) return undefined;
    return toProximity(coords, nearest.place, WALK_SPEED_M_PER_MIN, DETOUR_FACTOR);
  };

  return {
    ...raw,
    geocoded: true,
    lat: coords.lat,
    lon: coords.lon,
    geocodeMatched: matched,
    poi1: toProximity(coords, POINTS_OF_INTEREST[0], WALK_SPEED_M_PER_MIN, DETOUR_FACTOR),
    poi2: toProximity(coords, POINTS_OF_INTEREST[1], WALK_SPEED_M_PER_MIN, DETOUR_FACTOR),
    station: proximityTo(STATIONS),
    busStop: proximityTo(BUS_STOPS),
    school: proximityTo(ELEMENTARY_SCHOOLS),
    kindergarten: proximityTo(KINDERGARTENS_ONLY),
    childcareAny: proximityTo(CHILDCARE_FACILITIES),
  };
}
