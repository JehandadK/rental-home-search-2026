import * as cheerio from "cheerio";
export interface ParkingInfo {
  /** Monthly cost in yen; 0 when free, null when unknown. */
  monthlyYen: number | null;
  /** Whether a space is available at all. */
  available: boolean;
  /** "onsite" | "nearby" | null */
  location: "onsite" | "nearby" | null;
  /** Distance in metres for off-site parking. */
  distanceM: number | null;
  /** The raw cell text, for auditing. */
  raw: string;
}

/** Parse SUUMO's 駐車場 cell into structured parking data. */
export function parseParking(raw: string): ParkingInfo {
  const text = raw.replace(/\s/g, "");
  const none: ParkingInfo = {
    monthlyYen: null,
    available: false,
    location: null,
    distanceM: null,
    raw,
  };
  if (text === "" || text === "-" || text === "−" || text === "ー") return none;
  // 空無 = no vacancy; treat as unavailable but keep the raw text.
  if (/空無|無し|なし/.test(text) && !/無料/.test(text)) return none;

  const location = text.includes("敷地内")
    ? ("onsite" as const)
    : text.includes("近隣")
      ? ("nearby" as const)
      : null;

  const distance = text.match(/(\d+)m/);
  // Free parking is a real, valuable answer — not a missing value.
  if (/無料/.test(text)) {
    return {
      monthlyYen: 0,
      available: true,
      location,
      distanceM: distance ? Number(distance[1]) : null,
      raw,
    };
  }

  // Take the yen figure, ignoring any distance that precedes it.
  const yen = text.match(/([\d,]+)円/);
  if (!yen) return { ...none, location, available: location != null };

  return {
    monthlyYen: Number(yen[1].replace(/,/g, "")),
    available: true,
    location,
    distanceM: distance ? Number(distance[1]) : null,
    raw,
  };
}

/** Pull the 駐車場 cell out of a SUUMO detail page. */
export function extractParkingCell(html: string): string | null {
  const $ = cheerio.load(html);
  let found: string | null = null;
  $("th").each((_, th) => {
    if (found != null) return;
    if ($(th).text().trim() === "駐車場") {
      found = $(th).next("td").text().replace(/\s+/g, " ").trim();
    }
  });
  return found;
}

