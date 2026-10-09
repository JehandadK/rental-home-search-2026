/**
 * UR estates (団地) as the map shows them: every `urDanchi` catalog place,
 * vacant or not. The catalog holds only an estate's stable facts; its
 * vacancies are the rooms UR advertises, i.e. its still-available `ur`
 * listings. Only rooms of two or more rooms are collected, so a count is of
 * family-size vacancies. Attributes are data, so each one is read defensively.
 */
import type { CatalogPlace } from "./places";
import type { EnrichedListing } from "./types";
import { isSold } from "./lifecycle";
import { isRentedOut } from "./availability";
import { UR_SOURCE, urEstateCodeOf } from "./ur";

/** An estate's advertised rooms: how many, and their rent range incl. 共益費. */
export interface UrVacancy {
  count: number;
  rentMin: number;
  rentMax: number;
}

export interface UrEstate {
  place: CatalogPlace;
  /** UR's estate code, e.g. "50_4090". */
  code: string | null;
  /** Catalog city id, when the record carries one. */
  cityId: string | null;
  url: string | null;
  floors: number | null;
  structure: string | null;
  /** Rooms UR advertises now; null when it advertises none. */
  vacancy: UrVacancy | null;
}

/** The estate a listing's UR ad belongs to: the listing's own, else its merged UR ad's. */
function estateCode(listing: EnrichedListing): string | null {
  const own = urEstateCodeOf(listing);
  if (own) return own;
  const ad = listing.sourceListings?.find((reference) => reference.source === UR_SOURCE);
  return ad ? urEstateCodeOf({ id: ad.id, url: ad.url }) : null;
}

/**
 * Vacancies by estate code, from every listing (never the filtered set: the
 * estate layer shows what UR offers whatever the filters hide). Sold and
 * rented-out rooms do not count, as in the table.
 */
export function urVacancies(listings: readonly EnrichedListing[]): Map<string, UrVacancy> {
  const byCode = new Map<string, UrVacancy>();
  for (const listing of listings) {
    if (isSold(listing) || isRentedOut(listing)) continue;
    const code = estateCode(listing);
    if (!code) continue;
    const vacancy = byCode.get(code);
    if (!vacancy) byCode.set(code, { count: 1, rentMin: listing.rent, rentMax: listing.rent });
    else {
      vacancy.count++;
      vacancy.rentMin = Math.min(vacancy.rentMin, listing.rent);
      vacancy.rentMax = Math.max(vacancy.rentMax, listing.rent);
    }
  }
  return byCode;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function urEstate(place: CatalogPlace, vacancies: ReadonlyMap<string, UrVacancy>): UrEstate {
  const attributes = place.attributes ?? {};
  const code = text(attributes.urCode);
  return {
    place,
    code,
    cityId: text(attributes.cityId),
    url: text(attributes.url),
    floors: number(attributes.floors),
    structure: text(attributes.structure),
    vacancy: (code && vacancies.get(code)) || null,
  };
}

export const isVacant = (estate: UrEstate): boolean => estate.vacancy != null;

/** "UR コンフォール松原", without doubling a name that already starts with UR. */
export function urEstateName(estate: UrEstate): string {
  const name = estate.place.name;
  return /^UR/.test(name.normalize("NFKC")) ? name : `UR ${name}`;
}

/**
 * The map label: "UR コンフォール松原 · 空室1", or just the name when UR
 * advertises no family-size room there (it may still have smaller ones).
 */
export function urEstateLabel(estate: UrEstate): string {
  return estate.vacancy ? `${urEstateName(estate)} · 空室${estate.vacancy.count}` : urEstateName(estate);
}

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

/** Hover lines: the vacancies and their rents, then the buildings. */
export function urEstateDetails(estate: UrEstate): string[] {
  const { vacancy } = estate;
  const lines = vacancy
    ? [
        `空室 ${vacancy.count} family room${vacancy.count === 1 ? "" : "s"}`,
        `Rent ${vacancy.rentMin === vacancy.rentMax ? yen(vacancy.rentMin) : `${yen(vacancy.rentMin)}–${yen(vacancy.rentMax)}`} incl. 共益費`,
      ]
    : ["No family-size room advertised"];
  const building = [estate.floors != null ? `${estate.floors} floors` : null, estate.structure].filter(Boolean).join(" · ");
  if (building) lines.push(building);
  return lines;
}
