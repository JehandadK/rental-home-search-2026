import { describe, expect, it } from "vitest";
import { flightText, jsonValueAfter, parseRakuchinPage, rakuchinEstateUrl } from "./rakuchinPage";

/** A page as Next.js streams it: the flight text split across push() scripts, each a JSON string. */
const page = (flight: string, pieces = 3) => {
  const size = Math.ceil(flight.length / pieces);
  const scripts = Array.from({ length: pieces }, (_, i) => flight.slice(i * size, (i + 1) * size))
    .map((piece) => `<script>self.__next_f.push([1,${JSON.stringify(piece)}])</script>`);
  return `<html><body><script>self.__next_f.push([0])</script>${scripts.join("")}</body></html>`;
};

const PAST = {
  id: "eb651234-312d-4311-b071-1e8da91f22b9", danchi_ur_code: "50_4090", jkss: "000010701", room_name: "1号棟701号室",
  rent: 108400, common_fee: 3500, floor_plan: "2DK", floor_space: 50, floor: "7階", building_floors: "14階", is_renovation: false,
  listed_from: "2026-10-08T10:45:29.770235+00:00", listed_until: "2026-10-10T04:45:06.66+00:00", listing_days: 2, systems: null,
};
const ROOM = {
  id: "000070106", madori: "1DK", rent: 92900, common_fee: 3500, area_sqm: 43, floor_num: 1, building_num: 7, room_num: "106",
  first_seen_at: "", systems: ["近居割"],
};
const flight = (rooms: unknown[] | null, past: unknown[]) =>
  `1e:["$","$L2c",null,{"note":"空室は[毎日]更新 \\"quoted\\"","danchiName":"コンフォール松原","currentVacancy":${rooms?.length ?? 0},"totalUnits":3050,`
  + `${rooms ? `"rooms":${JSON.stringify(rooms)},` : ""}"pastListings":${JSON.stringify(past)}}]\n`;
const input = { estateCode: "50_4090", url: "https://www.ur-s.jp/kanto/saitama/50_4090/", capturedAt: "2026-10-14T00:00:00.000Z" };

describe("ラク賃 estate page", () => {
  it("reads the open rooms and every past listing period", () => {
    const { page: read, periods } = parseRakuchinPage(page(flight([ROOM], [PAST, { ...PAST, id: "x", listed_until: "" }])), input);
    expect(read).toMatchObject({ estateCode: "50_4090", name: "コンフォール松原", totalUnits: 3050, currentVacancy: 1 });
    expect(read.openRooms).toEqual([{ jkss: "000070106", label: "7号棟106号室", layout: "1DK", sizeM2: 43, floor: "1階", rent: 92900, commonFee: 3500, firstSeenAt: null }]);
    // The row without an end is dropped, not guessed.
    expect(periods).toEqual([[PAST.id, {
      estateCode: "50_4090", jkss: "000010701", label: "1号棟701号室", layout: "2DK", sizeM2: 50, floor: "7階", rent: 108400, commonFee: 3500,
      listedFrom: "2026-10-08T10:45:29.770Z", listedUntil: "2026-10-10T04:45:06.660Z", firstCapturedAt: input.capturedAt,
    }]]);
  });

  it("reads a page with no vacancy as no open rooms", () => {
    expect(parseRakuchinPage(page(flight(null, [PAST])), input).page.openRooms).toEqual([]);
  });

  it("refuses a page without the history block, so a bad read never closes every room", () => {
    expect(() => parseRakuchinPage("<html>メンテナンス中</html>", input)).toThrow(/no pastListings/);
  });

  it("refuses a read that does not account for every vacancy the page states", () => {
    const unread = `1e:{"currentVacancy":2,"rooms":"$L3","pastListings":[]}`;
    expect(() => parseRakuchinPage(page(unread), input)).toThrow(/states 2 vacant rooms but 0 were read/);
    // A row without a room code is dropped, so the read falls one short.
    expect(() => parseRakuchinPage(page(flight([ROOM, { ...ROOM, id: "bad" }], [])), input)).toThrow(/states 2 vacant rooms but 1 were read/);
  });

  it("drops another estate's rows", () => {
    expect(parseRakuchinPage(page(flight(null, [{ ...PAST, danchi_ur_code: "50_3880" }])), input).periods).toEqual([]);
  });

  it("cuts a JSON value out of the flight text, past brackets inside strings", () => {
    const text = flightText(page(`{"a":1,"list":[{"t":"]}["},2],"b":3}`, 4));
    expect(jsonValueAfter(text, "list")).toEqual([{ t: "]}[" }, 2]);
    expect(jsonValueAfter(text, "missing")).toBeNull();
  });

  it("maps UR's estate page to ラク賃's", () => {
    expect(rakuchinEstateUrl("https://www.ur-net.go.jp/chintai/kanto/tokyo/20_3420.html")).toBe("https://www.ur-s.jp/kanto/tokyo/20_3420/");
    expect(rakuchinEstateUrl("https://example.com/")).toBeNull();
  });
});
