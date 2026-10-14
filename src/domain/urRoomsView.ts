/** Filtering and ordering of the UR rooms page (src/domain/urRooms.ts). */
import { layoutRooms, type UrRoom } from "./urRooms";

export type UrRoomsSort = "watched" | "often" | "recent" | "rent" | "size";

export interface UrRoomsFilters {
  /** Target-city label, or "" for every city. */
  city: string;
  /** Estate code, or "" for every estate. */
  estate: string;
  status: "all" | "open" | "closed";
  /** Fewest rooms in the layout (2 = 2DK and up); 0 for any. */
  minRooms: number;
  minSizeM2: number | null;
  /** Highest rent including 共益費. */
  maxRent: number | null;
  watchedOnly: boolean;
  sort: UrRoomsSort;
}

export const DEFAULT_UR_ROOMS_FILTERS: UrRoomsFilters = {
  city: "", estate: "", status: "all", minRooms: 0, minSizeM2: null, maxRent: null, watchedOnly: false, sort: "watched",
};

/** Rent including 共益費, the figure to compare; null when unknown. */
export const totalRent = (room: Pick<UrRoom, "rent" | "commonFee">): number | null =>
  room.rent === null ? null : room.rent + (room.commonFee ?? 0);

const time = (iso: string) => Date.parse(iso) || 0;

export function filterUrRooms(
  rooms: readonly UrRoom[],
  filters: UrRoomsFilters,
  context: { cityOf: (estateCode: string) => string | null; watched: ReadonlySet<string> },
): UrRoom[] {
  const matches = rooms.filter((room) => {
    if (filters.city && context.cityOf(room.estateCode) !== filters.city) return false;
    if (filters.estate && room.estateCode !== filters.estate) return false;
    if (filters.status !== "all" && room.status !== filters.status) return false;
    if (filters.minRooms > 0 && (layoutRooms(room.layout) ?? 0) < filters.minRooms) return false;
    if (filters.minSizeM2 !== null && (room.sizeM2 ?? 0) < filters.minSizeM2) return false;
    const rent = totalRent(room);
    if (filters.maxRent !== null && (rent === null || rent > filters.maxRent)) return false;
    if (filters.watchedOnly && !context.watched.has(room.id)) return false;
    return true;
  });
  return sortUrRooms(matches, filters.sort, context.watched);
}

/**
 * "watched": watched rooms that are open first (the reason to watch), then
 * other open rooms, then watched closed rooms, then the rest; each group by
 * how often the room has come up. The other orders are plain.
 */
export function sortUrRooms(rooms: readonly UrRoom[], sort: UrRoomsSort, watched: ReadonlySet<string>): UrRoom[] {
  const often = (a: UrRoom, b: UrRoom) => b.periods.length - a.periods.length || time(b.since) - time(a.since);
  const group = (room: UrRoom) => (room.status === "open" ? (watched.has(room.id) ? 0 : 1) : (watched.has(room.id) ? 2 : 3));
  const byNumber = (value: (room: UrRoom) => number | null, direction: 1 | -1) => (a: UrRoom, b: UrRoom) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (x - y) * direction;
  };
  const compare: Record<UrRoomsSort, (a: UrRoom, b: UrRoom) => number> = {
    watched: (a, b) => group(a) - group(b) || often(a, b),
    often,
    recent: (a, b) => time(b.periods.at(-1)?.from ?? b.since) - time(a.periods.at(-1)?.from ?? a.since),
    rent: byNumber(totalRent, 1),
    size: byNumber((room) => room.sizeM2, -1),
  };
  return [...rooms].sort((a, b) => compare[sort](a, b) || a.id.localeCompare(b.id));
}
