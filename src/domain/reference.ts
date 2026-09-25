/**
 * Typed access to the bundled reference data (see src/data/).
 *
 * Sources: OpenStreetMap via Overpass (stations, schools, childcare, bus
 * stops, city boundary), GSI Japan geocoding (POI coordinates).
 */
import type {
  ChildcareFacility,
  EnrichedListing,
  NamedPlace,
  Mosque,
  PointOfInterest,
  Station,
} from "../types";
import poisJson from "../data/pois.json";
import stationsJson from "../data/stations.json";
import schoolsJson from "../data/elementary_schools.json";
import kindergartensJson from "../data/kindergartens.json";
import busStopsJson from "../data/bus_stops.json";
import boundaryJson from "../data/soka_boundary.json";
import neighborBoundariesJson from "../data/neighbor_boundaries.json";
// Browser-optimized derivative: baked nearest-place fields are omitted because
// ProximityIndex computes them for the user's current place selection.
import listingsJson from "../data/listings_web.json";
import mosquesJson from "../data/mosques.json";
import { unpackListings, type WebPayload } from "./webPayload";

/** The two points of interest: Al Sanad School and Baitul Aman Masjid. */
export const POINTS_OF_INTEREST = poisJson as PointOfInterest[];

/** Mosques/masjids/musallas in the surrounding search region. */
export const MOSQUES = mosquesJson as Mosque[];

/** All rail stations in and around Soka (any operator, for nearest-station). */
export const STATIONS = stationsJson as Station[];

/** The 21 public elementary schools (市立小学校) of Soka City. */
export const ELEMENTARY_SCHOOLS = schoolsJson as NamedPlace[];

/** Kindergartens, certified child centres and daycares within the city. */
export const CHILDCARE_FACILITIES = kindergartensJson as ChildcareFacility[];

/** 幼稚園/認定こども園 only — daycares excluded unless the user opts in. */
export const KINDERGARTENS_ONLY = CHILDCARE_FACILITIES.filter((f) => f.type !== "hoikuen");

/** Bus stops within the Soka city boundary. */
export const BUS_STOPS = busStopsJson as NamedPlace[];

/** Soka city boundary ring as [lon, lat] pairs (for the map). */
export const SOKA_BOUNDARY = boundaryJson as [number, number][];

/** A named city boundary ring, for drawing neighbouring municipalities. */
export interface CityBoundary {
  name: string;
  ring: [number, number][];
}

/** Neighbouring cities (Koshigaya, Yashio, Kawaguchi, Adachi) for map context. */
export const NEIGHBOR_BOUNDARIES = neighborBoundariesJson as CityBoundary[];

/** Scraped + enriched listings; compacted by `npm run data:web`. */
export const BASE_LISTINGS = unpackListings(listingsJson as unknown as WebPayload | EnrichedListing[]);
