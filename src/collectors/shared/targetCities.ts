/**
 * The municipalities every portal collector searches, with each portal's own
 * identifier for them. Adding a city here adds it to SUUMO, AtHome, RoomSpot
 * and Nifty discovery, native capture import and the refresh stages.
 */
export interface TargetCity {
  /** Stable English label stored on every listing (`listing.city`). */
  label: string;
  /** JIS municipality code; the first two digits are the prefecture. */
  code: string;
  prefecture: "埼玉県" | "東京都";
  /** Romanised prefecture used in portal paths (`/chintai/saitama/…`). */
  prefectureSlug: "saitama" | "tokyo";
  /** Municipality as printed in addresses, after the prefecture. */
  municipality: string;
  suumo: string;
  athome: string;
  nifty: string;
}

export const TARGET_CITIES: readonly TargetCity[] = [
  { label: "Soka", code: "11221", prefecture: "埼玉県", prefectureSlug: "saitama", municipality: "草加市",
    suumo: "sc_soka", athome: "soka-city", nifty: "sokashi_ct" },
  { label: "Koshigaya", code: "11222", prefecture: "埼玉県", prefectureSlug: "saitama", municipality: "越谷市",
    suumo: "sc_koshigaya", athome: "koshigaya-city", nifty: "koshigayashi_ct" },
  // Kawaguchi borders western Soka; its eastern/northern neighbourhoods are
  // especially relevant to Al Sanad School and are ranked by actual distance.
  { label: "Kawaguchi", code: "11203", prefecture: "埼玉県", prefectureSlug: "saitama", municipality: "川口市",
    suumo: "sc_kawaguchi", athome: "kawaguchi-city", nifty: "kawaguchishi_ct" },
  // Tokyo ward just south of Yashio and Misato.
  { label: "Katsushika", code: "13122", prefecture: "東京都", prefectureSlug: "tokyo", municipality: "葛飾区",
    suumo: "sc_katsushika", athome: "katsushika-city", nifty: "katsushikaku_ct" },
];

export const TARGET_CITY_LABELS: readonly string[] = TARGET_CITIES.map((city) => city.label);

export const targetCity = (label: string): TargetCity | undefined => TARGET_CITIES.find((city) => city.label === label);

/** Every prefecture a target city is in, for recognising an address line. */
export const TARGET_PREFECTURES: readonly string[] = [...new Set(TARGET_CITIES.map((city) => city.prefecture))];

/** The target city an address belongs to, if any ("東京都葛飾区…" or "葛飾区…"). */
export function cityForAddress(address: string): TargetCity | undefined {
  const local = TARGET_PREFECTURES.reduce((rest, prefecture) => rest.replace(new RegExp(`^${prefecture}`), ""), address.trim());
  return TARGET_CITIES.find((city) => local.startsWith(city.municipality));
}

/** Portals that print "草加市…" without the prefecture get it from the searched city. */
export function withPrefecture(address: string, cityLabel: string): string {
  if (TARGET_PREFECTURES.some((prefecture) => address.startsWith(prefecture))) return address;
  const prefecture = targetCity(cityLabel)?.prefecture ?? "埼玉県";
  return `${prefecture}${address}`;
}

/**
 * `--city <label>` scopes a collector run to one target city (for example a
 * first, page-capped load of a newly added city). Without it every city runs.
 */
export function selectCities<T>(args: readonly string[], cities: readonly T[], label: (city: T) => string): readonly T[] {
  const flag = args.indexOf("--city");
  if (flag < 0) return cities;
  const wanted = args[flag + 1];
  const selected = cities.filter((city) => label(city) === wanted);
  if (!selected.length) throw new Error(`Unknown --city ${wanted ?? ""}; expected one of ${cities.map(label).join(", ")}`);
  return selected;
}
