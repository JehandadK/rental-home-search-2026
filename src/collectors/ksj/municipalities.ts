/**
 * Municipal boundaries from MLIT 国土数値情報 N03 (行政区域), one GeoJSON
 * FeatureCollection per prefecture.
 *
 * N03 has one feature per piece of land, keyed by the municipality code
 * (N03_007): cities, towns and villages, Tokyo's special wards, and each ward
 * of a designated city (さいたま市南区, 横浜市中区…). Pieces with the same
 * code are joined into one municipality. Tokyo's remote islands (the Izu and
 * Ogasawara municipalities under the 大島・三宅・八丈・小笠原 支庁) are left
 * out: they lie up to 1,000 km south and would shrink the mainland to a speck.
 * So is land not yet assigned to any municipality (所属未定地, code PP000).
 */
import type { BoundaryGeometry } from "../../domain/referenceData";
import { simplifyShared, type Polygon, type SimplifyOptions } from "./topology";

export interface N03Properties {
  N03_001: string; // prefecture
  N03_002?: string | null; // sub-prefecture (支庁・振興局)
  N03_003?: string | null; // county (郡) or designated city
  N03_004?: string | null; // municipality
  N03_005?: string | null; // designated-city ward
  N03_007?: string | null; // municipality code
}

export interface N03Feature {
  type: "Feature";
  properties: N03Properties;
  geometry: { type: "Polygon"; coordinates: Polygon } | { type: "MultiPolygon"; coordinates: Polygon[] } | null;
}

export interface N03FeatureCollection {
  type: "FeatureCollection";
  features: N03Feature[];
}

export interface Municipality {
  /** 5-digit 全国地方公共団体コード (without the check digit), as N03 gives it. */
  code: string;
  prefecture: string;
  /** Local name: さいたま市南区 for a ward, 伊奈町 for a town (the county is in `county`). */
  name: string;
  county?: string;
  geometry: BoundaryGeometry;
}

export interface MunicipalityImport {
  municipalities: Municipality[];
  /** Features left out, with why, for the import report. */
  skipped: { code: string | null; name: string; reason: string; features: number }[];
}

/**
 * Tokyo's remote-island municipalities, by code: 大島町 利島村 新島村 神津島村
 * (大島支庁), 三宅村 御蔵島村 (三宅支庁), 八丈町 青ヶ島村 (八丈支庁), and
 * 小笠原村 (小笠原支庁). Recent N03 editions no longer name the 支庁.
 */
export const REMOTE_ISLAND_CODES: ReadonlySet<string> = new Set([
  "13361", "13362", "13363", "13364", "13381", "13382", "13401", "13402", "13421",
]);

/** Parse and simplify the given prefecture collections together, so borders between prefectures match too. */
export function importMunicipalities(
  collections: readonly N03FeatureCollection[],
  options: SimplifyOptions,
): MunicipalityImport {
  const byCode = new Map<string, { properties: N03Properties; polygons: Polygon[] }>();
  const skipped = new Map<string, MunicipalityImport["skipped"][number]>();
  const skip = (code: string | null, name: string, reason: string) => {
    const key = `${code}|${name}|${reason}`;
    const entry = skipped.get(key) ?? { code, name, reason, features: 0 };
    entry.features++;
    skipped.set(key, entry);
  };

  for (const collection of collections) {
    for (const feature of collection.features) {
      const properties = feature.properties;
      const code = properties.N03_007 ?? null;
      const name = municipalityName(properties);
      if (!code || !feature.geometry) {
        skip(code, name, "no municipality code or geometry");
        continue;
      }
      if (code.endsWith("000")) {
        // 所属未定地: land (mostly reclaimed, in Tokyo Bay) not yet assigned to a municipality.
        skip(code, name, "not assigned to a municipality");
        continue;
      }
      if (REMOTE_ISLAND_CODES.has(code)) {
        skip(code, name, "remote island");
        continue;
      }
      const entry = byCode.get(code) ?? { properties, polygons: [] };
      if (feature.geometry.type === "Polygon") entry.polygons.push(feature.geometry.coordinates);
      else entry.polygons.push(...feature.geometry.coordinates);
      byCode.set(code, entry);
    }
  }

  const codes = [...byCode.keys()].sort();
  const simplified = simplifyShared(codes.map((code) => ({ key: code, polygons: byCode.get(code)!.polygons })), options);
  const municipalities: Municipality[] = [];
  for (const code of codes) {
    const { properties } = byCode.get(code)!;
    const polygons = simplified.get(code) ?? [];
    if (polygons.length === 0) {
      skip(code, municipalityName(properties), "no polygon left after simplification");
      continue;
    }
    const county = properties.N03_003 && properties.N03_003.endsWith("郡") ? properties.N03_003 : undefined;
    municipalities.push({
      code,
      prefecture: properties.N03_001,
      name: municipalityName(properties),
      ...(county ? { county } : {}),
      geometry: polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons },
    });
  }
  return { municipalities, skipped: [...skipped.values()] };
}

/** さいたま市南区 for a designated-city ward, otherwise the municipality itself. */
export function municipalityName(properties: N03Properties): string {
  return `${properties.N03_004 ?? ""}${properties.N03_005 ?? ""}` || properties.N03_003 || properties.N03_001;
}
