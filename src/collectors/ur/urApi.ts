/**
 * UR賃貸住宅's own JSON API (www.ur-net.go.jp → chintai.r6.ur-net.go.jp/chintai/api/),
 * as its pages call it. Pure: request parameters in, parsed records out. See
 * research/ur-sites/ur-net-official.md §5 for the endpoints and fields.
 *
 * Every endpoint is a form POST that answers with a JSON array, or `null`
 * for "nothing" (also for a request missing a parameter). Values are strings
 * with HTML and units: "108,400円", "50&#13217;", "7階 /14階".
 */
import { UR_DEPOSIT_MONTHS, UR_SOURCE, type UrEstateObservation } from "../../domain/ur";
import type { ListingPhoto, RawListing } from "../../domain/types";

/** One form field, as jQuery serialises it (`{ name, value }`, repeatable). */
export interface FormField { name: string; value: string | number | boolean | string[] }

export const UR_HOST = "www.ur-net.go.jp";
export const UR_ORIGIN = `https://${UR_HOST}`;

/** The estate ID UR uses in its URLs: 支社 + "_" + 団地 + 識別 ("50_4090"). */
export const estateCode = (row: { shisya: string; danchi: string; shikibetu: string }): string =>
  `${row.shisya}_${row.danchi}${row.shikibetu}`;

export const estateUrl = (block: string, prefecture: string, code: string): string =>
  `${UR_ORIGIN}/chintai/${block}/${prefecture}/${code}.html`;

export const roomUrl = (block: string, prefecture: string, code: string, jkss: string): string =>
  `${UR_ORIGIN}/chintai/${block}/${prefecture}/${code}_room.html?JKSS=${jkss}`;

/** Listing id of one UR room: the estate code plus UR's room code (JKSS). */
export const urListingId = (code: string, jkss: string): string => `ur-${code}-${jkss}`;

/** One city to sweep: UR's block/prefecture slugs, prefecture code and `skcs` (JIS city code without the prefecture). */
export interface UrCityQuery {
  /** Our city label (`TargetCity.label`). */
  label: string;
  /** JIS municipality code, e.g. "11221". */
  code: string;
  block: string;
  prefecture: string;
  prefectureName: string;
  /**
   * UR answered HTTP 500 for some municipalities without UR estates (once, in
   * a dry run; not on the next sweep). After one retry the sweep skips such a
   * city instead of failing, and concludes nothing about it.
   */
  optional?: boolean;
}

const FILTERS_BLANK: FormField[] = ["rent_low", "rent_high", "floorspace_low", "floorspace_high"].map((name) => ({ name, value: "" }));

/**
 * `bukken/result/bukken_result/`: one row per estate of a city. UR answers
 * null unless the room-paging fields are present too, blank as its city
 * pages send them (checked 2026-10-09).
 */
export function estateListParams(city: UrCityQuery, pageIndex: number, pageSize: number): FormField[] {
  const tdfk = city.code.slice(0, 2);
  return [
    ...FILTERS_BLANK, { name: "walk", value: "" }, { name: "years", value: "" },
    { name: "mode", value: "area" }, { name: "skcs", value: city.code.slice(2) }, { name: "block", value: city.block },
    { name: "tdfk", value: [tdfk] }, { name: "rireki_tdfk", value: [tdfk] },
    { name: "orderByField", value: "1" }, { name: "pageSize", value: String(pageSize) }, { name: "pageIndex", value: pageIndex },
    { name: "shisya", value: "" }, { name: "danchi", value: "" }, { name: "shikibetu", value: "" },
    { name: "pageIndexRoom", value: "0" }, { name: "sp", value: "" },
  ];
}

/** `bukken/detail/detail_bukken_room/`: the vacant rooms of one estate, 5 per page. */
export function roomListParams(estate: EstateRef, pageIndex: number): FormField[] {
  return [
    ...FILTERS_BLANK, { name: "shisya", value: estate.shisya }, { name: "danchi", value: estate.danchi },
    { name: "shikibetu", value: estate.shikibetu }, { name: "newBukkenRoom", value: "" }, { name: "orderByField", value: 0 }, { name: "orderBySort", value: 0 },
    { name: "pageIndex", value: pageIndex }, { name: "sp", value: "" },
  ];
}

/** `bukken/detail/detail_room/`: one room in full. */
export function roomDetailParams(estate: EstateRef, jkss: string): FormField[] {
  return [{ name: "id", value: jkss }, { name: "shisya", value: estate.shisya }, { name: "danchi", value: estate.danchi },
    { name: "shikibetu", value: estate.shikibetu }, { name: "sp", value: "" }];
}

/** `bukken/search/map_marker/`: coordinates of every estate in a box. */
export function markerParams(box: { south: number; west: number; north: number; east: number }): FormField[] {
  return [...FILTERS_BLANK, { name: "ne_lat", value: box.north }, { name: "ne_lng", value: box.east },
    { name: "sw_lat", value: box.south }, { name: "sw_lng", value: box.west }, { name: "small", value: false }];
}

export interface EstateRef { shisya: string; danchi: string; shikibetu: string }

/** An estate row from `bukken_result`. */
export interface UrEstateRow extends EstateRef {
  code: string;
  name: string;
  /** Address as UR prints it, without the prefecture ("草加市松原1-4ほか"). */
  place: string;
  traffic: string[];
  /** Vacant rooms UR advertises today. */
  roomCount: number;
  /** Estates in the city, for paging. */
  estateCount: number;
  floors: number | null;
  structure: string | null;
}

/** A vacant room row from `detail_bukken_room`. */
export interface UrRoomRow {
  jkss: string;
  /** "1号棟701号室". */
  name: string;
  rentYen: number;
  /** Rent before a discount scheme, when one applies. */
  normalRentYen: number | null;
  commonFeeYen: number;
  layout: string;
  sizeM2: number | null;
  floor: string | null;
  floorPlanUrl: string | null;
  schemes: string[];
  designs: string[];
  /** Rooms in the estate, for paging. */
  roomCount: number;
}

/** The parts of `detail_room` a listing uses. */
export interface UrRoomDetail {
  floor: string | null;
  /** 管理年数: years UR has managed the building. */
  managedYears: number | null;
  availableFrom: string | null;
  features: string[];
  /** 設備 and 特徴, split. */
  facilities: string[];
  parking: string | null;
  notes: string[];
  photos: { url: string; caption: string }[];
  schemes: string[];
}

export interface UrMarker { code: string; lat: number; lon: number; roomCount: number }

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === "object") : []);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const strip = (html: string): string => html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&#13217;/g, "㎡")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
const int = (value: unknown): number | null => {
  const match = typeof value === "string" || typeof value === "number" ? String(value).normalize("NFKC").replace(/,/g, "").match(/\d+(?:\.\d+)?/) : null;
  return match ? Number(match[0]) : null;
};
/** "108,400円" → 108400. */
export const yen = (value: unknown): number | null => (typeof value === "string" && /円/.test(value) ? int(strip(value)) : null);
const list = (value: unknown): string[] => (typeof value === "string" ? value.split(/[、,]/).map((part) => part.trim()).filter(Boolean) : []);
const items = (html: unknown): string[] => (typeof html === "string"
  ? [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => strip(match[1])).filter(Boolean) : []);
const names = (value: unknown, ...keys: string[]): string[] => rows(value)
  .map((row) => keys.map((key) => text(row[key])).find(Boolean)).filter((name): name is string => !!name);

export function parseEstateRows(value: unknown): UrEstateRow[] {
  return rows(value).flatMap((row) => {
    const shisya = text(row.shisya), danchi = text(row.danchi), shikibetu = text(row.shikibetu), name = text(row.danchiNm), place = text(row.place);
    if (!shisya || !danchi || shikibetu == null || !name || !place) return [];
    const ref = { shisya, danchi, shikibetu };
    return [{ ...ref, code: estateCode(ref), name, place, traffic: items(row.traffic), roomCount: int(row.roomCount) ?? 0,
      estateCount: int(row.bukkenCount) ?? 0, floors: int(row.floorAll), structure: text(row.kouzou) }];
  });
}

export function parseRoomRows(value: unknown): UrRoomRow[] {
  return rows(value).flatMap((row) => {
    const jkss = text(row.id), rent = yen(row.rent), layout = text(row.type);
    if (!jkss || !/^\d+$/.test(jkss) || rent == null || !layout) return [];
    return [{ jkss, name: text(row.name) ?? jkss, rentYen: rent, normalRentYen: yen(row.rent_normal), commonFeeYen: yen(row.commonfee) ?? 0,
      layout: layout.normalize("NFKC"), sizeM2: int(typeof row.floorspace === "string" ? strip(row.floorspace) : null),
      floor: text(row.floor), floorPlanUrl: text(row.madori), schemes: names(row.system, "制度名"), designs: names(row.design, "デザイン名", "デザイン_HTML"),
      roomCount: int(row.allCount) ?? 0 }];
  });
}

/** `detail_room` answers `null` (or an empty array) for a room UR no longer advertises. */
export function parseRoomDetail(value: unknown): UrRoomDetail | null {
  const row = rows(value)[0];
  if (!row || !text(row.id)) return null;
  const photos = rows(row.img).flatMap((image) => {
    const url = text(image["画像パス"]);
    return url ? [{ url: url.replace(/([^:])\/\/+/g, "$1/"), caption: text(image.ALT) ?? text(image["コメント"]) ?? "" }] : [];
  });
  const notes = items(row.biko);
  return {
    floor: text(row.floor) ?? text(row.floor_sp),
    managedYears: int(row.year),
    availableFrom: text(row.availableDate),
    features: Array.isArray(row.feature_pickup) ? row.feature_pickup.filter((item): item is string => typeof item === "string") : [],
    facilities: [...list(row.facility), ...list(row.feature)],
    parking: typeof row.parking === "string" && row.parking.trim() ? strip(row.parking) : null,
    notes: notes.map((note) => note.replace(/^・/, "")),
    photos,
    schemes: names(row.system, "制度名"),
  };
}

export function parseMarkers(value: unknown): UrMarker[] {
  return rows(value).flatMap((row) => {
    const code = text(row.id), lat = Number(row.lat), lon = Number(row.lng);
    return code && Number.isFinite(lat) && Number.isFinite(lon) ? [{ code, lat, lon, roomCount: int(row.roomCount) ?? 0 }] : [];
  });
}

/** The first walk line of UR's 交通 list: station and the longest walk in its range ("徒歩2～9分" → 9). */
export function walkingAccess(traffic: readonly string[]): { station: string; walkMin: number } | null {
  for (const line of traffic) {
    const station = line.match(/「([^」]+)」駅/)?.[1];
    const walk = line.normalize("NFKC").match(/徒歩(\d+)(?:[~～-](\d+))?分/);
    if (station && walk && !/バス/.test(line)) return { station, walkMin: Number(walk[2] ?? walk[1]) };
  }
  return null;
}

/** "草加市松原1-4ほか" → "埼玉県草加市松原1-4ほか". */
export const fullAddress = (city: UrCityQuery, place: string): string =>
  place.startsWith(city.prefectureName) ? place : `${city.prefectureName}${place}`;

const FIXED_TERM = /定借|定期借家|URライト/;

/**
 * A listing for one vacant room. UR's lease terms are fixed: 敷金 two months
 * of rent (共益費 excluded), and no 礼金, 仲介手数料, 更新料 or guarantor.
 */
export function roomListing(city: UrCityQuery, estate: UrEstateRow, room: UrRoomRow, detail: UrRoomDetail | null, capturedAt: string): RawListing {
  const access = walkingAccess(estate.traffic);
  const schemes = [...new Set([...room.schemes, ...(detail?.schemes ?? [])])];
  const floor = detail?.floor ?? room.floor;
  const totalFloors = floor ? int(floor.split("/")[1]) : null;
  const photos: ListingPhoto[] = [
    ...(room.floorPlanUrl ? [{ url: room.floorPlanUrl.replace(/([^:])\/\/+/g, "$1/"), kind: "floorPlan" as const, source: UR_SOURCE }] : []),
    ...(detail?.photos ?? []).map((photo) => ({ url: photo.url, kind: /間取/.test(photo.caption) || /\.gif$/i.test(photo.url) ? "floorPlan" as const : "photo" as const, source: UR_SOURCE })),
  ].filter((photo, index, all) => all.findIndex((other) => other.url === photo.url) === index);
  const feeNotes = [
    schemes.length ? `対象制度: ${schemes.join("、")}` : null,
    room.normalRentYen ? `割引前家賃 ${room.normalRentYen.toLocaleString("ja-JP")}円` : null,
  ].filter(Boolean).join(" / ");
  const year = new Date(capturedAt).getFullYear();
  return {
    id: urListingId(estate.code, room.jkss),
    name: `UR${estate.name}`,
    address: fullAddress(city, estate.place),
    city: city.label,
    rent: room.rentYen + room.commonFeeYen,
    layout: room.layout,
    sizeM2: room.sizeM2,
    // 管理年数 counts from when UR began managing the building, its completion for most estates.
    builtYear: detail?.managedYears != null ? year - detail.managedYears : null,
    depositYen: room.rentYen * UR_DEPOSIT_MONTHS,
    keyMoneyYen: 0,
    advertisedStation: access?.station ?? null,
    stationWalkMin: access?.walkMin ?? null,
    url: roomUrl(city.block, city.prefecture, estate.code, room.jkss),
    source: UR_SOURCE,
    ...(photos.length ? { photos } : {}),
    notes: [room.name, floor, ...estate.traffic].filter(Boolean).join(" · "),
    costs: {
      depositYen: room.rentYen * UR_DEPOSIT_MONTHS, keyMoneyYen: 0, adminFeeYen: room.commonFeeYen,
      renewalFeeYen: 0, agencyFeeYen: 0, guarantorRequired: false, feeNotes: feeNotes || null,
    },
    tenancy: {
      leaseType: schemes.some((scheme) => FIXED_TERM.test(scheme)) ? "fixed-term" : "regular",
      availableFrom: detail?.availableFrom ?? null,
      immediateMoveIn: detail?.availableFrom ? /随時|即/.test(detail.availableFrom) : null,
    },
    building: {
      floor: floor?.split("/")[0].trim() ?? null,
      totalFloors: totalFloors ?? estate.floors,
      structure: estate.structure,
      features: [...new Set([...(detail?.features ?? []), ...(detail?.facilities ?? [])])],
      conditions: [...(detail?.notes ?? []), ...room.designs],
    },
    agency: "UR都市機構",
  };
}

/** The estate as the reference catalog keeps it. */
export function estateObservation(city: UrCityQuery, estate: UrEstateRow, marker: UrMarker | undefined,
  rooms: readonly UrRoomRow[], checkedAt: string): UrEstateObservation | null {
  if (!marker) return null;
  const rents = rooms.map((room) => room.rentYen + room.commonFeeYen);
  return {
    code: estate.code, name: estate.name, address: fullAddress(city, estate.place), cityCode: city.code,
    lat: marker.lat, lon: marker.lon, url: estateUrl(city.block, city.prefecture, estate.code),
    vacantRooms: Math.max(estate.roomCount, rooms.length), checkedAt,
    vacantRentMin: rents.length ? Math.min(...rents) : null, vacantRentMax: rents.length ? Math.max(...rents) : null,
    floors: estate.floors, structure: estate.structure,
  };
}
