/**
 * Which areas (cities) the map shows, and how their names read.
 *
 * The map can cover all of Kanto, but drawing ~350 municipalities and ~2,000
 * stations is slow and mostly noise, so it shows a chosen set of cities: by
 * default the search area, which is every city the listings are in plus a few
 * neighbours for context. Areas are picked city by city or a whole prefecture
 * at once, and a city whose listings are shown is always drawn. Names read in
 * English or Japanese.
 */
import type { ReferenceCity } from "./referenceData";

export type NameLanguage = "en" | "ja";

/** Neighbours between the searched cities, drawn for context though they have no listings. */
export const CONTEXT_AREA_CITY_IDS: readonly string[] = ["city:yashio", "city:adachi"];

/**
 * The reference cities listings are in. Listings name their city in English
 * ("Katsushika"), as the reference city's `name` does; unnamed ones are skipped.
 */
export function listingAreas(cities: readonly ReferenceCity[], listingCities: Iterable<string | null | undefined>): Set<string> {
  const byName = new Map(cities.map((city) => [city.name, city.id]));
  const ids = new Set<string>();
  for (const name of listingCities) {
    const id = name ? byName.get(name) : undefined;
    if (id) ids.add(id);
  }
  return ids;
}

/** A city's name in the chosen language, falling back to whichever it has. */
export function cityName(city: ReferenceCity, language: NameLanguage): string {
  return language === "ja" ? city.nameLocal ?? city.name : city.name;
}

/** A prefecture's name in the chosen language (Saitama or 埼玉県). */
export function prefectureName(prefecture: PrefectureGroup, language: NameLanguage): string {
  return language === "en" && prefecture.nameEn ? prefecture.nameEn : prefecture.name;
}

export interface PrefectureGroup {
  /** Local name, also the key: 埼玉県. */
  name: string;
  nameEn?: string;
  /** Its cities, in municipality-code order. */
  cities: ReferenceCity[];
}

/** Cities grouped by prefecture, prefectures and cities in code order (茨城 … 神奈川). */
export function groupByPrefecture(cities: readonly ReferenceCity[]): PrefectureGroup[] {
  const groups = new Map<string, PrefectureGroup>();
  for (const city of cities) {
    const key = city.prefecture ?? "";
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { name: key, cities: [] }));
    if (!group.nameEn && city.prefectureEn) group.nameEn = city.prefectureEn;
    group.cities.push(city);
  }
  const code = (city: ReferenceCity) => city.code ?? "99999";
  for (const group of groups.values()) group.cities.sort((a, b) => code(a).localeCompare(code(b)));
  return [...groups.values()].sort((a, b) => code(a.cities[0]).localeCompare(code(b.cities[0])));
}

/**
 * The default area: every city with listings plus the context neighbours,
 * limited to cities the reference has (all of them when none of those exist).
 */
export function defaultAreas(cities: readonly ReferenceCity[], withListings: ReadonlySet<string> = new Set()): Set<string> {
  const known = new Set(cities.map((city) => city.id));
  const defaults = [...withListings, ...CONTEXT_AREA_CITY_IDS].filter((id) => known.has(id));
  return new Set(defaults.length ? defaults : known);
}

/**
 * The cities the map draws: the saved choice (the default area when nothing
 * is saved), minus cities the reference no longer has, plus every city whose
 * listings are on show, so a city new to the data is never left off the map.
 */
export function shownAreas(
  cities: readonly ReferenceCity[],
  saved: readonly string[] | null,
  withListings: ReadonlySet<string>,
  onShow: ReadonlySet<string>,
): Set<string> {
  const known = new Set(cities.map((city) => city.id));
  const chosen = saved == null ? defaultAreas(cities, withListings) : saved.filter((id) => known.has(id));
  return new Set([...chosen, ...onShow]);
}

/** How much of a prefecture is selected, for a tri-state checkbox. */
export function prefectureSelection(group: PrefectureGroup, selected: ReadonlySet<string>): "all" | "some" | "none" {
  const count = group.cities.filter((city) => selected.has(city.id)).length;
  return count === 0 ? "none" : count === group.cities.length ? "all" : "some";
}

/** Select or clear every city of a prefecture. */
export function setPrefecture(selected: ReadonlySet<string>, group: PrefectureGroup, on: boolean): Set<string> {
  const next = new Set(selected);
  for (const city of group.cities) {
    if (on) next.add(city.id);
    else next.delete(city.id);
  }
  return next;
}

/** Toggle one city. */
export function toggleCity(selected: ReadonlySet<string>, cityId: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(cityId)) next.add(cityId);
  return next;
}

/** Case- and script-insensitive match on either name (soka, 草加, Saitama). */
export function matchesCity(city: ReferenceCity, prefecture: PrefectureGroup, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [city.name, city.nameLocal ?? "", prefecture.name, prefecture.nameEn ?? ""]
    .some((text) => text.toLowerCase().includes(q));
}
