import { describe, expect, it } from "vitest";
import { deriveUrRooms, emptyUrHistory, layoutRooms, urRoomUrl, type RakuchinPeriod, type UrHeldRoom, type UrHistoryFile } from "./urRooms";

const ESTATE = { code: "50_4090", name: "コンフォール松原", city: "Soka", url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090.html" };
const OTHER = { code: "50_2220", name: "アーバンハイツ南前川", city: "Kawaguchi", url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_2220.html" };
const NOW = "2026-10-14T00:00:00.000Z";

const period = (over: Partial<RakuchinPeriod> = {}): RakuchinPeriod => ({
  estateCode: "50_4090", jkss: "000010701", label: "1号棟701号室", layout: "2DK", sizeM2: 50, floor: "7階",
  rent: 108_400, commonFee: 3_500, listedFrom: "2026-10-08T10:45:29.770Z", listedUntil: "2026-10-10T04:45:06.660Z",
  firstCapturedAt: NOW, ...over,
});

const history = (over: Partial<UrHistoryFile> = {}): UrHistoryFile => ({ ...emptyUrHistory(), ...over });
const derive = (h: UrHistoryFile, heldRooms: UrHeldRoom[] = []) => deriveUrRooms({ history: h, estates: [ESTATE, OTHER], heldRooms, now: NOW });

describe("UR rooms page data", () => {
  it("lists a room that was let as closed, with when it left UR's list", () => {
    const [room] = derive(history({ periods: { a: period() } })).rooms;
    expect(room).toMatchObject({
      id: "50_4090-000010701", status: "closed", since: "2026-10-10T04:45:06.660Z", firstSeenAt: "2026-10-08T10:45:29.770Z",
      label: "1号棟701号室", layout: "2DK", rent: 108_400, commonFee: 3_500, sources: ["ur-s"],
      url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000010701",
    });
    expect(room.periods).toEqual([{ from: "2026-10-08T10:45:29.770Z", until: "2026-10-10T04:45:06.660Z" }]);
    expect(room.medianDaysListed).toBe(1.7);
  });

  it("counts every time a room came up, and keeps the latest rent", () => {
    const [room] = derive(history({ periods: {
      a: period({ listedFrom: "2026-06-01T00:00:00.000Z", listedUntil: "2026-06-03T00:00:00.000Z", rent: 100_000 }),
      b: period({ listedFrom: "2026-09-01T00:00:00.000Z", listedUntil: "2026-09-05T00:00:00.000Z", rent: 104_000 }),
    } })).rooms;
    expect(room.periods).toHaveLength(2);
    expect(room.rent).toBe(104_000);
    expect(room.medianDaysListed).toBe(3);
    expect(room.firstSeenAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("counts ラク賃 rows with one start as one period, ending at the last end", () => {
    const [room] = derive(history({ periods: {
      a: period({ listedUntil: "2026-10-09T00:00:00.000Z" }),
      b: period({ listedUntil: "2026-10-11T00:00:00.000Z" }),
    } })).rooms;
    expect(room.periods).toEqual([{ from: "2026-10-08T10:45:29.770Z", until: "2026-10-11T00:00:00.000Z" }]);
  });

  it("keeps a reopening between two of our reads: a listing that ended after a closed read adds a period", () => {
    const rows = { periods: {
      a: period({ listedFrom: "2026-10-01T00:00:00.000Z", listedUntil: "2026-10-05T00:00:00.000Z" }),
      b: period({ listedFrom: "2026-10-01T00:00:00.000Z", listedUntil: "2026-10-12T00:00:00.000Z" }),
    } };
    const page = (capturedAt: string) => ({ capturedAt, estateCode: "50_4090", url: "u", name: null, totalUnits: 1, currentVacancy: 0, openRooms: [] });
    const sweep = { capturedAt: "2026-10-10T00:00:00.000Z", cities: ["Soka"], minRooms: 2, roomIds: [] };
    const expected = { status: "closed", since: "2026-10-12T00:00:00.000Z",
      periods: [{ from: "2026-10-01T00:00:00.000Z", until: "2026-10-10T00:00:00.000Z" }, { from: "2026-10-10T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" }] };
    expect(derive(history({ ...rows, estatePages: [page("2026-10-10T00:00:00.000Z"), page("2026-10-13T00:00:00.000Z")] })).rooms[0]).toMatchObject(expected);
    expect(derive(history({ periods: { b: rows.periods.b }, sweeps: [sweep] })).rooms[0]).toMatchObject(expected);
  });

  it("opens a closed room when a newer UR sweep advertises it again", () => {
    const sweep = { capturedAt: "2026-10-13T13:22:28.176Z", cities: ["Soka"], minRooms: 2, roomIds: ["ur-50_4090-000010701"] };
    const [room] = derive(history({ periods: { a: period() }, sweeps: [sweep] })).rooms;
    expect(room.status).toBe("open");
    expect(room.since).toBe(sweep.capturedAt);
    expect(room.periods).toHaveLength(2);
    expect(room.sources).toEqual(["ur", "ur-s"]);
  });

  it("closes a family room missing from a later sweep of its city, but not a smaller room, which is never collected", () => {
    const seen = { capturedAt: "2026-10-09T00:00:00.000Z", cities: ["Soka"], minRooms: 2, roomIds: ["ur-50_4090-000010701"] };
    const empty = { capturedAt: "2026-10-12T00:00:00.000Z", cities: ["Soka"], minRooms: 2, roomIds: [] };
    const page = { capturedAt: "2026-10-11T00:00:00.000Z", estateCode: "50_4090", url: "u", name: null, totalUnits: 3050, currentVacancy: 2,
      openRooms: [{ jkss: "000070106", label: "7号棟106号室", layout: "1DK", sizeM2: 43, floor: "1階", rent: 92_900, commonFee: 3_500, firstSeenAt: null },
        { jkss: "000010701", label: "1号棟701号室", layout: "2DK", sizeM2: 50, floor: "7階", rent: 108_400, commonFee: 3_500, firstSeenAt: null }] };
    const payload = derive(history({ sweeps: [seen, empty], estatePages: [page] }));
    const byId = new Map(payload.rooms.map((room) => [room.id, room]));
    expect(byId.get("50_4090-000010701")).toMatchObject({ status: "closed", since: empty.capturedAt });
    expect(byId.get("50_4090-000070106")).toMatchObject({ status: "open", since: page.capturedAt });
    expect(payload.estates.find((estate) => estate.code === "50_4090")).toMatchObject({ totalUnits: 3050, roomCount: 2, openCount: 1 });
  });

  it("does not close a room in a sweep of another city", () => {
    const seen = { capturedAt: "2026-10-09T00:00:00.000Z", cities: ["Soka"], minRooms: 2, roomIds: ["ur-50_4090-000010701"] };
    const elsewhere = { capturedAt: "2026-10-12T00:00:00.000Z", cities: ["Kawaguchi"], minRooms: 2, roomIds: [] };
    expect(derive(history({ sweeps: [seen, elsewhere] })).rooms[0].status).toBe("open");
  });

  it("closes a room missing from a later ラク賃 read of its estate", () => {
    const page = (capturedAt: string, open: boolean) => ({ capturedAt, estateCode: "50_2220", url: "u", name: null, totalUnits: 43, currentVacancy: open ? 1 : 0,
      openRooms: open ? [{ jkss: "000000409", label: "409号室", layout: "3DK", sizeM2: 68, floor: "4階", rent: 107_500, commonFee: 3_800, firstSeenAt: "2026-10-01T00:00:00.000Z" }] : [] });
    const [room] = derive(history({ estatePages: [page("2026-10-10T00:00:00.000Z", true), page("2026-10-12T00:00:00.000Z", false)] })).rooms;
    expect(room).toMatchObject({ status: "closed", since: "2026-10-12T00:00:00.000Z", firstSeenAt: "2026-10-01T00:00:00.000Z" });
  });

  it("takes room facts from our own UR read when it is newer, and leaves out rooms of estates not listed", () => {
    const held: UrHeldRoom = { id: "ur-50_4090-000010701", label: "1号棟701号室", layout: "2DK", sizeM2: 50, floor: "7階",
      rentWithFee: 113_900, commonFee: 3_500, observedAt: "2026-10-13T00:00:00.000Z", url: null };
    const payload = derive(history({ periods: { a: period(), b: period({ estateCode: "99_9990", jkss: "000000101" }) } }), [held]);
    expect(payload.rooms).toHaveLength(1);
    expect(payload.rooms[0].rent).toBe(110_400);
    expect(payload.historyFrom).toBe("2026-10-08T10:45:29.770Z");
  });

  it("lists every estate, rooms or not", () => {
    expect(derive(emptyUrHistory()).estates.map((estate) => [estate.code, estate.roomCount])).toEqual([["50_4090", 0], ["50_2220", 0]]);
  });
});

describe("UR room helpers", () => {
  it("reads the number of rooms of a layout", () => {
    expect(layoutRooms("2LDK")).toBe(2);
    expect(layoutRooms("１ＤＫ")).toBe(1);
    expect(layoutRooms(null)).toBeNull();
    expect(layoutRooms("ワンルーム")).toBeNull();
  });

  it("builds UR's room page from its estate page", () => {
    expect(urRoomUrl(ESTATE.url, "000010701")).toBe("https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000010701");
  });
});
