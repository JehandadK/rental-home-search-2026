/** Nifty station-cell parsing shared by the list crawler and the detail importer. */

/**
 * Nifty's station cell sometimes gives distance instead of 徒歩分
 * ("草加駅 3.6km"). Convert with the Japanese walking convention so the
 * scorer does not discard useful agency data and fall back to coarse geocode.
 */
export function parseStationDistance(text: string): { station?: string; walkMin?: number } {
  const direct = parseStation(text);
  if (direct.station) return direct;
  const match = text.match(/([^\s/／]+駅)\s*([\d.]+)\s*km/i);
  if (!match) return {};
  return {
    station: normaliseStationName(match[1]),
    walkMin: Math.ceil((Number(match[2]) * 1000) / 80),
  };
}

/** "東武伊勢崎線/新田駅 歩7分" or "新田駅 歩6分\n （伊勢崎線）" → { station, walkMin } */
export function parseStation(text: string): { station?: string; walkMin?: number } {
  const m = text.match(/[/／]?\s*(.+?駅)\s*歩(\d+)分/);
  if (!m) return {};
  const station = normaliseStationName(m[1]);
  return { station, walkMin: parseInt(m[2], 10) };
}

/**
 * Reduces a station cell to the bare station name so it matches the naming
 * used by SUUMO entries and the reference catalog's stations:
 *   "東武伊勢崎線/新田駅"                      → "新田駅"
 *   "利用可能駅（ニフティ不動産調べ）谷塚駅"        → "谷塚駅"
 */
export function normaliseStationName(raw: string): string {
  let name = raw.replace(/\s/g, "");
  // Drop the line prefix (東武伊勢崎線/…) and any leading boilerplate.
  name = name.split(/[/／]/).pop() ?? name;
  name = name.replace(/^.*?調べ）/, "").replace(/^利用可能駅/, "");
  return name;
}
