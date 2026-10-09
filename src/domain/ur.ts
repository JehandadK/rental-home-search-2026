/**
 * UR賃貸住宅 (UR都市機構, public rental housing).
 *
 * UR is the landlord of every UR estate (団地) and leases directly: no 礼金
 * (key money), no 仲介手数料 (agency fee), no 更新料 (renewal fee), no
 * guarantor, and a 敷金 (deposit) of two months' rent. Its estates are kept
 * in the reference catalog as `urDanchi` places, so the map shows every
 * estate whether or not it has a vacancy; its vacant rooms are listings from
 * the `ur` source.
 */
import type { RawListing } from "./types";

/** Listing source id of rooms collected from www.ur-net.go.jp. */
export const UR_SOURCE = "ur";

/** How a listing source is named to people: "UR" for UR's own ads, else the source id. */
export const sourceLabel = (source: string): string => (source === UR_SOURCE ? "UR" : source);

/** Reference-catalog category of UR estates. */
export const UR_PLACE_CATEGORY = "urDanchi";

/** Deposit UR asks for, in months of rent (共益費 excluded). */
export const UR_DEPOSIT_MONTHS = 2;

/**
 * Attributes a `urDanchi` place carries (`ReferencePlaceRecord.attributes`).
 * Only facts that rarely change: the catalog is versioned and each update is
 * a new revision, so vacancies are not kept here. An estate's vacancies are
 * its `ur` listings that are still available ({@link urEstateCodeOf}).
 */
export interface UrEstateAttributes {
  source: "UR都市機構";
  /** UR's estate code: 支社 + 団地 + 識別, e.g. "50_4090". */
  urCode: string;
  /** The estate's page on www.ur-net.go.jp. */
  url: string;
  /** Catalog city id, e.g. "city:soka". */
  cityId: string;
  /** 階数 of the tallest building and 構造, as UR prints them. */
  floors: number | null;
  structure: string | null;
}

/** One estate as the UR collector saw it; the reference import turns it into a `urDanchi` place. */
export interface UrEstateObservation {
  /** UR's estate code, e.g. "50_4090". */
  code: string;
  name: string;
  /** Full address, prefecture first. */
  address: string;
  /** JIS municipality code of the city whose sweep found it, e.g. "11221". */
  cityCode: string;
  lat: number;
  lon: number;
  url: string;
  /** Rooms UR advertised in the sweep (any layout), and their rent range incl. 共益費. */
  vacantRooms: number;
  checkedAt: string;
  vacantRentMin: number | null;
  vacantRentMax: number | null;
  floors: number | null;
  structure: string | null;
}

/**
 * Whether a listing is a UR room: collected from UR itself, or a portal ad
 * whose name starts with "UR"/"ＵＲ" (portals print UR rooms that way, e.g.
 * "ＵＲコンフォール松原").
 */
export function isUrListing(listing: Pick<RawListing, "source" | "name"> & { sourceListings?: RawListing["sourceListings"] }): boolean {
  if (listing.source === UR_SOURCE || listing.sourceListings?.some((ad) => ad.source === UR_SOURCE)) return true;
  return /^UR(?![A-Za-z])/.test(listing.name.normalize("NFKC").trim());
}

const ROOM_ID = /^ur-(\d{2}_\d{3}[0-9a-z])-\d+$/;
const ROOM_URL = /\/(\d{2}_\d{3}[0-9a-z])_room\.html\?/;

/** The UR estate code ("50_4090") of a room collected from UR, from its id or room URL; else null. */
export function urEstateCodeOf(listing: Pick<RawListing, "id" | "url">): string | null {
  return ROOM_ID.exec(listing.id ?? "")?.[1] ?? (listing.url && listing.url.includes("ur-net.go.jp") ? ROOM_URL.exec(listing.url)?.[1] ?? null : null);
}
