/**
 * One sweep of UR's vacancies for the target cities.
 *
 * UR is the only landlord of its estates and its city list is the whole
 * estate set, so a sweep sees every estate of a city (with or without
 * vacancies) and every room it advertises. Per city:
 *   1. `bukken_result`        every estate and its vacant-room count;
 *   2. `detail_bukken_room`   the rooms of each estate with vacancies;
 *   3. `detail_room`          each room in full (lease, features, photos).
 * Once per sweep, `map_marker` gives every estate's coordinates. Rooms we
 * hold from earlier sweeps that UR no longer lists are looked up one by one:
 * `detail_room` answering null is UR's own "no longer advertised" (the
 * room page then redirects to the estate), recorded as positive evidence.
 */
import type { UrEstateObservation } from "../../domain/ur";
import type { RawListing } from "../../domain/types";
import { estateListParams, estateObservation, markerParams, parseEstateRows, parseMarkers, parseRoomDetail, parseRoomRows,
  roomDetailParams, roomListParams, roomListing, type UrCityQuery, type UrEstateRow, type UrMarker, type UrRoomRow } from "./urApi";
import type { UrApi } from "./urBrowser";

export const ESTATE_PAGE_SIZE = 30;
/** UR returns 5 rooms per page of `detail_bukken_room`. */
const ROOMS_PER_PAGE = 5;
const MAX_PAGES = 20;

export interface UrSweepOptions {
  cities: readonly UrCityQuery[];
  /** Box covering the cities, for `map_marker`. */
  box: { south: number; west: number; north: number; east: number };
  /** UR rooms already held (listing ids `ur-{code}-{jkss}`), checked when UR no longer lists them. */
  knownRoomIds: readonly string[];
  now(): string;
  /** Pause between calls; UR's own pages call the API a few times per view. */
  pause(): Promise<void>;
  log?(line: string): void;
}

export interface UrRoomGone { id: string; checkedAt: string; evidence: string }

export interface UrSweep {
  capturedAt: string;
  /** Every room UR advertises in the swept cities, any layout. */
  rooms: RawListing[];
  estates: UrEstateObservation[];
  /** Estates without coordinates from `map_marker` (outside the box): not placed on the map. */
  unplaced: { code: string; name: string }[];
  /** Earlier rooms UR now answers "not found" for. */
  gone: UrRoomGone[];
  /** Earlier rooms UR stopped listing but still answers for (e.g. 申込受付中): left alone. */
  stillAnswering: string[];
  calls: number;
}

const ROOM_ID = /^ur-(\d{2}_\d{3}[0-9a-z])-(\d{9})$/;

export async function sweepUr(api: UrApi, options: UrSweepOptions): Promise<UrSweep> {
  const capturedAt = options.now();
  let calls = 0;
  const call = async (endpoint: string, params: Parameters<UrApi["call"]>[1]) => {
    if (calls++) await options.pause();
    return api.call(endpoint, params);
  };

  const markers = new Map<string, UrMarker>(parseMarkers(await call("bukken/search/map_marker/", markerParams(options.box)))
    .map((marker) => [marker.code, marker]));
  const sweep: UrSweep = { capturedAt, rooms: [], estates: [], unplaced: [], gone: [], stillAnswering: [], calls: 0 };
  const seen = new Set<string>();
  const estateOf = new Map<string, { city: UrCityQuery; estate: UrEstateRow }>();

  for (const city of options.cities) {
    const estates: UrEstateRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = parseEstateRows(await call("bukken/result/bukken_result/", estateListParams(city, page, ESTATE_PAGE_SIZE)));
      estates.push(...rows.filter((row) => !estates.some((known) => known.code === row.code)));
      if (rows.length < ESTATE_PAGE_SIZE || estates.length >= (rows[0]?.estateCount ?? 0)) break;
    }
    options.log?.(`${city.label}: ${estates.length} estates, ${estates.reduce((sum, estate) => sum + estate.roomCount, 0)} vacant rooms`);
    for (const estate of estates) {
      estateOf.set(estate.code, { city, estate });
      const rooms: UrRoomRow[] = [];
      for (let page = 0; estate.roomCount > 0 && page < MAX_PAGES; page++) {
        const rows = parseRoomRows(await call("bukken/detail/detail_bukken_room/", roomListParams(estate, page)));
        rooms.push(...rows.filter((row) => !rooms.some((known) => known.jkss === row.jkss)));
        if (rows.length < ROOMS_PER_PAGE || rooms.length >= (rows[0]?.roomCount ?? 0)) break;
      }
      for (const room of rooms) {
        const detail = parseRoomDetail(await call("bukken/detail/detail_room/", roomDetailParams(estate, room.jkss)));
        const listing = roomListing(city, estate, room, detail, capturedAt);
        seen.add(listing.id!);
        sweep.rooms.push(listing);
      }
      const observation = estateObservation(city, estate, markers.get(estate.code), rooms, capturedAt);
      if (observation) sweep.estates.push(observation);
      else sweep.unplaced.push({ code: estate.code, name: estate.name });
    }
  }

  // Rooms UR stopped listing: ask for each one, in a swept estate only.
  for (const id of options.knownRoomIds) {
    const match = ROOM_ID.exec(id);
    const owner = match ? estateOf.get(match[1]) : undefined;
    if (!match || !owner || seen.has(id)) continue;
    const detail = parseRoomDetail(await call("bukken/detail/detail_room/", roomDetailParams(owner.estate, match[2])));
    if (detail) sweep.stillAnswering.push(id);
    else sweep.gone.push({ id, checkedAt: options.now(), evidence: "UR detail_room returned no room (no longer advertised)" });
  }
  sweep.calls = calls;
  return sweep;
}
