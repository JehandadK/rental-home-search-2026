import { describe, expect, it } from "vitest";
import type { UrRoom } from "./urRooms";
import { DEFAULT_UR_ROOMS_FILTERS, filterUrRooms, totalRent } from "./urRoomsView";

const room = (id: string, over: Partial<UrRoom> = {}): UrRoom => ({
  id, estateCode: "50_4090", jkss: "000000101", label: id, layout: "2DK", sizeM2: 50, floor: "1階", rent: 100_000, commonFee: 3_000,
  status: "closed", since: "2026-10-01T00:00:00.000Z", firstSeenAt: "2026-06-01T00:00:00.000Z",
  periods: [{ from: "2026-06-01T00:00:00.000Z", until: "2026-06-03T00:00:00.000Z" }], medianDaysListed: 2, sources: ["ur-s"], url: "u", ...over,
});
const cityOf = (code: string) => (code === "50_4090" ? "Soka" : "Kawaguchi");
const run = (rooms: UrRoom[], filters = {}, watched: string[] = []) =>
  filterUrRooms(rooms, { ...DEFAULT_UR_ROOMS_FILTERS, ...filters }, { cityOf, watched: new Set(watched) }).map((r) => r.id);

describe("UR rooms page filters", () => {
  const twice = { periods: [{ from: "2026-06-01T00:00:00.000Z", until: "2026-06-02T00:00:00.000Z" }, { from: "2026-08-01T00:00:00.000Z", until: "2026-08-02T00:00:00.000Z" }] };
  const rooms = [
    room("closed-often", twice),
    room("open", { status: "open" }),
    room("watched-closed"),
    room("watched-open", { status: "open" }),
    room("small", { layout: "1DK", sizeM2: 40, rent: 80_000, estateCode: "50_2220" }),
  ];

  it("puts watched open rooms first, then open, then watched, then the rest by how often they came up", () => {
    expect(run(rooms, {}, ["watched-closed", "watched-open"])).toEqual(["watched-open", "open", "watched-closed", "closed-often", "small"]);
  });

  it("filters by status, layout, size, rent, city and the watch list", () => {
    expect(run(rooms, { status: "open" })).toEqual(["open", "watched-open"]);
    expect(run(rooms, { minRooms: 2 })).not.toContain("small");
    expect(run(rooms, { minSizeM2: 45 })).not.toContain("small");
    expect(run(rooms, { maxRent: 90_000 })).toEqual(["small"]);
    expect(run(rooms, { city: "Kawaguchi" })).toEqual(["small"]);
    expect(run(rooms, { watchedOnly: true }, ["watched-closed"])).toEqual(["watched-closed"]);
  });

  it("compares rent including 共益費", () => {
    expect(totalRent({ rent: 100_000, commonFee: 3_000 })).toBe(103_000);
    expect(totalRent({ rent: null, commonFee: 3_000 })).toBeNull();
    expect(run(rooms, { sort: "rent" })[0]).toBe("small");
  });
});
