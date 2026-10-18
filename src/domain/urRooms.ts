/**
 * Every UR room we know of, open now or not.
 *
 * UR advertises only the rooms that are vacant today, so no site can list an
 * occupied room. What can be listed is every room that was ever seen open:
 * a room that was let once is let again, so a closed room is one to wait for.
 *
 * Two kinds of evidence are kept (data/ur-history.json, additive):
 *   - our own UR sweeps: which rooms UR advertised at each sweep (rooms of
 *     two or more rooms only, the collector's scope);
 *   - ラク賃不動産 (www.ur-s.jp) estate pages: the rooms open when read, and
 *     every listing period it has recorded since about 2026-05-29 (every
 *     layout; one row each time a room left UR's list).
 * Each piece of evidence is an "open at t" or "closed at t" event. A room's
 * status is its newest event, so a later read from either source overrides
 * an older one, and a conflict is settled by time, never by source rank.
 */

/** data/ur-history.json */
import type { UrEstateNearby } from "./urEstateNearby";
import { urEstateNameEn } from "./urEstateNames";

export interface UrHistoryFile {
  schemaVersion: 1;
  /** Our own UR sweeps, oldest first. */
  sweeps: UrSweepRecord[];
  /** Every ラク賃 estate page read, oldest first. */
  estatePages: RakuchinEstatePage[];
  /** ラク賃 listing periods by its own row id (one row per disappearance from UR). */
  periods: Record<string, RakuchinPeriod>;
}

/** One sweep of UR's own vacancy lists. */
export interface UrSweepRecord {
  capturedAt: string;
  /** Target-city labels swept (every estate of each city is seen). */
  cities: string[];
  /** Rooms of fewer rooms than this are not collected, so their absence means nothing. */
  minRooms: number;
  /** Rooms UR advertised: `ur-{estate code}-{JKSS}`. */
  roomIds: string[];
}

/** A room as ラク賃 prints it, open at the time of the read. */
export interface RakuchinRoom {
  jkss: string;
  label: string;
  layout: string | null;
  sizeM2: number | null;
  floor: string | null;
  rent: number | null;
  commonFee: number | null;
  /** When ラク賃 first saw it open; null when it does not say. */
  firstSeenAt: string | null;
}

/** One read of a ラク賃 estate page. */
export interface RakuchinEstatePage {
  capturedAt: string;
  estateCode: string;
  url: string;
  name: string | null;
  /** 総戸数, every unit of the estate. */
  totalUnits: number | null;
  currentVacancy: number | null;
  openRooms: RakuchinRoom[];
}

/** One period a room was advertised, as ラク賃 recorded it. */
export interface RakuchinPeriod {
  estateCode: string;
  jkss: string;
  label: string;
  layout: string | null;
  sizeM2: number | null;
  floor: string | null;
  rent: number | null;
  commonFee: number | null;
  listedFrom: string;
  listedUntil: string;
  /** When we first read this row. */
  firstCapturedAt: string;
}

export const emptyUrHistory = (): UrHistoryFile => ({ schemaVersion: 1, sweeps: [], estatePages: [], periods: {} });

/** Sources of evidence, as shown on the page. */
export type UrRoomSource = "ur" | "ur-s";

export interface UrRoomPeriod {
  from: string;
  /** Null while the room is still open. */
  until: string | null;
}

/** One room on the published page. */
export interface UrRoom {
  /** `{estate code}-{JKSS}`, the key a watch mark is saved under. */
  id: string;
  estateCode: string;
  jkss: string;
  /** 棟・号室, e.g. "1号棟701号室". */
  label: string;
  layout: string | null;
  sizeM2: number | null;
  /** "7階". */
  floor: string | null;
  /** Monthly rent without 共益費, as last advertised. */
  rent: number | null;
  commonFee: number | null;
  status: "open" | "closed";
  /** Open: when this listing started. Closed: when it last left UR's list. */
  since: string;
  firstSeenAt: string;
  /** Periods it was advertised, oldest first. */
  periods: UrRoomPeriod[];
  /** Median days a period lasted (open periods count up to now). */
  medianDaysListed: number | null;
  sources: UrRoomSource[];
  /** UR's page for the room. UR sends a closed room's page on to the estate. */
  url: string;
}

export interface UrRoomsEstate {
  code: string;
  /** UR's (Japanese) name. */
  name: string;
  /** Transliterated name; absent when none is known. */
  nameEn?: string;
  address?: string | null;
  lat?: number;
  lon?: number;
  /** What is near the estate; the estate is not scored, as its rooms differ. */
  nearby?: UrEstateNearby;
  /** Target-city label, e.g. "Soka". */
  city: string | null;
  url: string;
  totalUnits: number | null;
  /** Rooms known: open and closed. */
  roomCount: number;
  openCount: number;
}

/** public/data/ur-rooms.json */
export interface UrRoomsPayload {
  schemaVersion: 1;
  generatedAt: string;
  /** Oldest evidence held; nothing earlier can be known. */
  historyFrom: string | null;
  estates: UrRoomsEstate[];
  rooms: UrRoom[];
}

/** An estate the page lists: the reference catalog's `urDanchi` places. */
export interface UrEstateInput {
  code: string;
  name: string;
  address?: string | null;
  lat?: number;
  lon?: number;
  nearby?: UrEstateNearby;
  city: string | null;
  /** UR's estate page, e.g. https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090.html */
  url: string;
}

/** A room our own collector holds (data/sources/ur.json), at its last sighting. */
export interface UrHeldRoom {
  id: string;
  label: string | null;
  layout: string | null;
  sizeM2: number | null;
  floor: string | null;
  /** Rent including 共益費, as the listing stores it. */
  rentWithFee: number;
  commonFee: number | null;
  observedAt: string | null;
  url: string | null;
}

const ROOM_ID = /^ur-(\d{2}_\d{3}[0-9a-z])-(\d{9})$/;
const DAY_MS = 86_400_000;

/** Number of rooms of a layout: "2LDK" → 2, "1K" → 1; null when it does not say. */
export function layoutRooms(layout: string | null): number | null {
  const match = layout?.normalize("NFKC").match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

/** UR's room page, from its estate page: …/50_4090.html → …/50_4090_room.html?JKSS=000010701 */
export const urRoomUrl = (estateUrl: string, jkss: string): string => estateUrl.replace(/\.html$/, `_room.html?JKSS=${jkss}`);

interface RoomEvent {
  at: string;
  state: "open" | "closed";
  source: UrRoomSource;
  /** The recorded end of a listing period: the room was open until this moment. */
  listingEnd?: boolean;
}

interface Facts {
  label?: string | null;
  layout?: string | null;
  sizeM2?: number | null;
  floor?: string | null;
  rent?: number | null;
  commonFee?: number | null;
}

interface RoomDraft {
  estateCode: string;
  jkss: string;
  events: RoomEvent[];
  /** Room facts with the time they were read; the newest non-null value wins per fact. */
  facts: { at: string; facts: Facts }[];
  sources: Set<UrRoomSource>;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const time = (iso: string) => Date.parse(iso);

/**
 * The published rooms: every room seen in either source, for the estates
 * given. A room of an estate not given (outside the target cities) is left out.
 */
export function deriveUrRooms(input: {
  history: UrHistoryFile;
  estates: readonly UrEstateInput[];
  heldRooms: readonly UrHeldRoom[];
  now: string;
}): UrRoomsPayload {
  const { history, estates, heldRooms, now } = input;
  const estateByCode = new Map(estates.map((estate) => [estate.code, estate]));
  const drafts = new Map<string, RoomDraft>();
  const draft = (estateCode: string, jkss: string): RoomDraft | undefined => {
    if (!estateByCode.has(estateCode)) return undefined;
    const id = `${estateCode}-${jkss}`;
    let room = drafts.get(id);
    if (!room) drafts.set(id, (room = { estateCode, jkss, events: [], facts: [], sources: new Set() }));
    return room;
  };

  // ラク賃 listing periods: open at its start, closed at its end. A room that
  // left and came back (a cancelled application) keeps its start and gets a
  // second row, so rows with one start are one period, ending at the last end.
  const collapsed = new Map<string, RakuchinPeriod>();
  for (const period of Object.values(history.periods)) {
    const key = `${period.estateCode}-${period.jkss}@${time(period.listedFrom)}`;
    const kept = collapsed.get(key);
    if (!kept || time(period.listedUntil) > time(kept.listedUntil)) collapsed.set(key, period);
  }
  for (const period of collapsed.values()) {
    const room = draft(period.estateCode, period.jkss);
    if (!room) continue;
    room.sources.add("ur-s");
    room.events.push({ at: period.listedFrom, state: "open", source: "ur-s" }, { at: period.listedUntil, state: "closed", source: "ur-s", listingEnd: true });
    room.facts.push({ at: period.listedFrom, facts: period });
  }
  // Our own held rooms: their facts, at their last sighting.
  for (const held of heldRooms) {
    const match = ROOM_ID.exec(held.id);
    const room = match && draft(match[1], match[2]);
    if (!room) continue;
    room.sources.add("ur");
    room.facts.push({
      at: held.observedAt ?? "",
      facts: { label: held.label, layout: held.layout, sizeM2: held.sizeM2, floor: held.floor,
        rent: held.rentWithFee - (held.commonFee ?? 0), commonFee: held.commonFee },
    });
  }
  // ラク賃 page reads: the rooms open then, after the estate's known rooms are in.
  for (const page of history.estatePages) {
    for (const open of page.openRooms) {
      const room = draft(page.estateCode, open.jkss);
      if (!room) continue;
      room.sources.add("ur-s");
      if (open.firstSeenAt) room.events.push({ at: open.firstSeenAt, state: "open", source: "ur-s" });
      room.events.push({ at: page.capturedAt, state: "open", source: "ur-s" });
      room.facts.push({ at: page.capturedAt, facts: open });
    }
  }
  // Our own sweeps: open when advertised. The closed events need the full room set, below.
  for (const sweep of history.sweeps) {
    for (const id of sweep.roomIds) {
      const match = ROOM_ID.exec(id);
      const room = match && draft(match[1], match[2]);
      if (!room) continue;
      room.sources.add("ur");
      room.events.push({ at: sweep.capturedAt, state: "open", source: "ur" });
    }
  }

  // Closed evidence: a known room missing from a read that would have shown it.
  const roomsByEstate = new Map<string, RoomDraft[]>();
  for (const room of drafts.values()) roomsByEstate.set(room.estateCode, [...(roomsByEstate.get(room.estateCode) ?? []), room]);
  const layoutOf = (room: RoomDraft) => latestFacts(room).layout ?? null;
  for (const page of history.estatePages) {
    const open = new Set(page.openRooms.map((room) => room.jkss));
    for (const room of roomsByEstate.get(page.estateCode) ?? []) {
      if (!open.has(room.jkss)) room.events.push({ at: page.capturedAt, state: "closed", source: "ur-s" });
    }
  }
  for (const sweep of history.sweeps) {
    const seen = new Set(sweep.roomIds);
    const cities = new Set(sweep.cities);
    for (const room of drafts.values()) {
      const estate = estateByCode.get(room.estateCode)!;
      if (!estate.city || !cities.has(estate.city) || seen.has(`ur-${room.estateCode}-${room.jkss}`)) continue;
      // A smaller room is not collected, so its absence says nothing; an unknown layout neither.
      const rooms = layoutRooms(layoutOf(room));
      if (rooms === null || rooms < sweep.minRooms) continue;
      room.events.push({ at: sweep.capturedAt, state: "closed", source: "ur" });
    }
  }

  const rooms: UrRoom[] = [];
  for (const room of drafts.values()) {
    const events = room.events.filter((event) => !Number.isNaN(time(event.at)))
      // At the same moment, our own read of UR wins over a mirror's.
      .sort((a, b) => time(a.at) - time(b.at) || (a.source === b.source ? 0 : a.source === "ur" ? 1 : -1));
    if (!events.length) continue;
    const periods: UrRoomPeriod[] = [];
    for (const event of events) {
      const current = periods.at(-1);
      if (event.state === "open" && (!current || current.until !== null)) periods.push({ from: event.at, until: null });
      else if (event.state === "closed" && current && current.until === null) current.until = event.at;
      // A listing that ended after the room was already seen closed means it came
      // back in between (ラク賃 keeps the first start): a period up to that end,
      // starting no earlier than the closed read.
      else if (event.listingEnd && current && current.until !== null && time(event.at) > time(current.until)) {
        periods.push({ from: current.until, until: event.at });
      }
    }
    if (!periods.length) continue;
    const last = events.at(-1)!;
    const lastPeriod = periods.at(-1)!;
    const status = last.state === "open" ? "open" : "closed";
    const facts = latestFacts(room);
    const estate = estateByCode.get(room.estateCode)!;
    const days = median(periods.map((period) => Math.max(0, (time(period.until ?? now) - time(period.from)) / DAY_MS)));
    rooms.push({
      id: `${room.estateCode}-${room.jkss}`,
      estateCode: room.estateCode,
      jkss: room.jkss,
      label: facts.label ?? room.jkss,
      layout: facts.layout ?? null,
      sizeM2: facts.sizeM2 ?? null,
      floor: facts.floor ?? null,
      rent: facts.rent ?? null,
      commonFee: facts.commonFee ?? null,
      status,
      since: status === "open" ? lastPeriod.from : (lastPeriod.until ?? last.at),
      firstSeenAt: periods[0].from,
      periods,
      medianDaysListed: days === null ? null : Math.round(days * 10) / 10,
      sources: [...room.sources].sort(),
      url: urRoomUrl(estate.url, room.jkss),
    });
  }
  rooms.sort((a, b) => a.estateCode.localeCompare(b.estateCode) || a.label.localeCompare(b.label, "ja"));

  const latestPage = new Map<string, RakuchinEstatePage>();
  for (const page of history.estatePages) latestPage.set(page.estateCode, page);
  const allTimes = [
    ...history.sweeps.map((sweep) => sweep.capturedAt),
    ...Object.values(history.periods).map((period) => period.listedFrom),
  ].filter((at) => !Number.isNaN(time(at))).sort((a, b) => time(a) - time(b));

  return {
    schemaVersion: 1,
    generatedAt: now,
    historyFrom: allTimes[0] ?? null,
    estates: estates.map((estate) => {
      const own = rooms.filter((room) => room.estateCode === estate.code);
      return {
        code: estate.code, name: estate.name, ...(urEstateNameEn(estate.code) ? { nameEn: urEstateNameEn(estate.code)! } : {}),
        ...(estate.address !== undefined ? { address: estate.address } : {}),
        ...(estate.lat !== undefined && estate.lon !== undefined ? { lat: estate.lat, lon: estate.lon } : {}),
        ...(estate.nearby ? { nearby: estate.nearby } : {}),
        city: estate.city, url: estate.url,
        totalUnits: latestPage.get(estate.code)?.totalUnits ?? null,
        roomCount: own.length,
        openCount: own.filter((room) => room.status === "open").length,
      };
    }),
    rooms,
  };
}

/** The newest non-null value of each fact. */
function latestFacts(room: RoomDraft): Facts {
  const result: Facts = {};
  const sorted = [...room.facts].sort((a, b) => (time(a.at) || 0) - (time(b.at) || 0));
  for (const { facts } of sorted) {
    for (const key of ["label", "layout", "sizeM2", "floor", "rent", "commonFee"] as const) {
      const value = facts[key];
      if (value !== null && value !== undefined && value !== "") (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
