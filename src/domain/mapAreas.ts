/**
 * Which areas (cities) the map shows, and how their names read.
 *
 * The map can cover all of Kanto, but drawing ~350 municipalities and ~2,000
 * stations is slow and mostly noise, so it shows a chosen set of cities: by
 * default the search area (Soka and its neighbours). Areas are picked city by
 * city or a whole prefecture at once. Names read in English or Japanese.
 */
import type { ReferenceCity } from "./referenceData";

export type NameLanguage = "en" | "ja";

/** The search area: Soka, the cities with listings beside it, and the neighbours drawn for context. */
export const DEFAULT_AREA_CITY_IDS: readonly string[] = [
  "city:soka", "city:koshigaya", "city:kawaguchi", "city:yashio", "city:adachi",
];

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

/** The default area, limited to cities the data has (all of them when none of the defaults exist). */
export function defaultAreas(cities: readonly ReferenceCity[]): Set<string> {
  const known = new Set(cities.map((city) => city.id));
  const defaults = DEFAULT_AREA_CITY_IDS.filter((id) => known.has(id));
  return new Set(defaults.length ? defaults : known);
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
