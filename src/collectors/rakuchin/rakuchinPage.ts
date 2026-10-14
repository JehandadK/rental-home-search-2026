/**
 * ラク賃不動産 (www.ur-s.jp) estate pages: the rooms open now and every
 * listing period the site has recorded per room (research/ur-sites/ur-s-rakuchin.md).
 *
 * The page is Next.js; its data is in the React flight stream, the
 * `self.__next_f.push([1,"…"])` scripts. Each string is JSON-decoded and the
 * pieces joined, then the `rooms` and `pastListings` arrays are cut out by
 * bracket matching. Rows are read field by field: anything malformed is
 * dropped, never guessed.
 */
import type { RakuchinEstatePage, RakuchinPeriod, RakuchinRoom } from "../../domain/urRooms";

export const RAKUCHIN_ORIGIN = "https://www.ur-s.jp";

/**
 * An estate's page from UR's own estate URL: …/chintai/kanto/saitama/50_4090.html
 * → https://www.ur-s.jp/kanto/saitama/50_4090/. Null for any other URL.
 */
export function rakuchinEstateUrl(urEstateUrl: string): string | null {
  const match = /\/chintai\/([a-z]+)\/([a-z]+)\/(\d{2}_\d{3}[0-9a-z])\.html$/.exec(urEstateUrl);
  return match ? `${RAKUCHIN_ORIGIN}/${match[1]}/${match[2]}/${match[3]}/` : null;
}

/** The flight stream's text: every pushed string, decoded and joined. */
export function flightText(html: string): string {
  const parts: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { parts.push(JSON.parse(match[1]) as string); } catch { /* a piece that is not a JSON string */ }
  }
  return parts.join("");
}

/** The JSON value after `"key":` that starts with `[` or `{`, cut by bracket matching; null when absent. */
export function jsonValueAfter(text: string, key: string): unknown {
  const marker = `"${key}":`;
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;
  if (text[start] !== "[" && text[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === "\"") {
      for (i++; i < text.length && text[i] !== "\""; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const numberAfter = (text: string, key: string): number | null => {
  const match = new RegExp(`"${key}":(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
};
const stringAfter = (text: string, key: string): string | null => {
  const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return match ? (JSON.parse(`"${match[1]}"`) as string) : null;
};

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const iso = (value: unknown): string | null => {
  const text = str(value);
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
};
const JKSS = /^\d{9}$/;

function openRoom(row: Row): RakuchinRoom | null {
  const jkss = str(row.id);
  if (!jkss || !JKSS.test(jkss)) return null;
  const building = num(row.building_num);
  const roomNumber = str(row.room_num);
  const floor = num(row.floor_num);
  return {
    jkss,
    label: `${building ? `${building}号棟` : ""}${roomNumber ? `${roomNumber}号室` : jkss}`,
    layout: str(row.madori),
    sizeM2: num(row.area_sqm),
    floor: floor ? `${floor}階` : null,
    rent: num(row.rent),
    commonFee: num(row.common_fee),
    firstSeenAt: iso(row.first_seen_at),
  };
}

function period(row: Row, estateCode: string, capturedAt: string): [string, RakuchinPeriod] | null {
  const id = str(row.id);
  const jkss = str(row.jkss);
  const listedFrom = iso(row.listed_from);
  const listedUntil = iso(row.listed_until);
  if (!id || !jkss || !JKSS.test(jkss) || !listedFrom || !listedUntil) return null;
  if ((str(row.danchi_ur_code) ?? estateCode) !== estateCode) return null;
  return [id, {
    estateCode, jkss,
    label: str(row.room_name) ?? jkss,
    layout: str(row.floor_plan),
    sizeM2: num(row.floor_space),
    floor: str(row.floor),
    rent: num(row.rent),
    commonFee: num(row.common_fee),
    listedFrom, listedUntil,
    firstCapturedAt: capturedAt,
  }];
}

export interface ParsedRakuchinPage {
  page: RakuchinEstatePage;
  periods: [string, RakuchinPeriod][];
}

/**
 * One estate page. Throws when the page carries no history block at all
 * (not an estate page, or the site changed), so a bad read is never taken
 * for "every room is closed".
 */
export function parseRakuchinPage(html: string, input: { estateCode: string; url: string; capturedAt: string }): ParsedRakuchinPage {
  const text = flightText(html);
  const past = jsonValueAfter(text, "pastListings");
  if (!Array.isArray(past)) throw new Error(`${input.url}: no pastListings in the page data`);
  const rooms = jsonValueAfter(text, "rooms");
  const openRooms = (Array.isArray(rooms) ? rooms : []).flatMap((row) => {
    const room = row && typeof row === "object" ? openRoom(row as Row) : null;
    return room ? [room] : [];
  });
  // Every room missing from a read counts as closed, so a read must account for every vacancy it states.
  const currentVacancy = numberAfter(text, "currentVacancy");
  if (currentVacancy !== null && currentVacancy !== openRooms.length) {
    throw new Error(`${input.url}: the page states ${currentVacancy} vacant rooms but ${openRooms.length} were read`);
  }
  return {
    page: {
      capturedAt: input.capturedAt,
      estateCode: input.estateCode,
      url: input.url,
      name: stringAfter(text, "danchiName"),
      totalUnits: numberAfter(text, "totalUnits"),
      currentVacancy,
      openRooms,
    },
    periods: past.flatMap((row) => {
      const entry = row && typeof row === "object" ? period(row as Row, input.estateCode, input.capturedAt) : null;
      return entry ? [entry] : [];
    }),
  };
}
