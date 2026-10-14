import { describe, expect, it } from "vitest";
import type { FormField } from "./urApi";
import { UrApiError, type UrApi } from "./urBrowser";
import { sweepUr } from "./urCollector";
import { ESTATES, MARKERS, ROOMS, ROOM_DETAIL, SOKA } from "./urFixtures.contract";

const field = (params: readonly FormField[], name: string) => params.find((param) => param.name === name)?.value;

/** UR's API for one city, answering from the fixtures; records every call. */
function fakeApi(answers: { gone?: string[]; stillListed?: string[] } = {}): UrApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async call(endpoint, params) {
      calls.push(`${endpoint}${field(params, "id") ? `#${field(params, "id")}` : ""}`);
      if (endpoint === "bukken/search/map_marker/") return MARKERS;
      if (endpoint === "bukken/result/bukken_result/") return field(params, "pageIndex") === 0 ? ESTATES : null;
      if (endpoint === "bukken/detail/detail_bukken_room/") return field(params, "danchi") === "409" ? ROOMS : null;
      if (endpoint === "bukken/detail/detail_room/") {
        const id = field(params, "id");
        if (id === "000010701" || answers.stillListed?.includes(String(id))) return [{ ...ROOM_DETAIL[0], id }];
        return null;
      }
      throw new Error(`unexpected ${endpoint}`);
    },
  };
}

const options = (knownRoomIds: string[] = []) => ({
  cities: [SOKA], box: { south: 35.7, west: 139.6, north: 36, east: 140 }, knownRoomIds,
  now: () => "2026-10-09T05:00:00.000Z", pause: async () => undefined,
});

describe("UR sweep", () => {
  it("sees every estate of the city, vacant or not, and every vacant room", async () => {
    const api = fakeApi();
    const sweep = await sweepUr(api, options());
    expect(sweep.estates.map((estate) => [estate.code, estate.vacantRooms])).toEqual([["50_4090", 1], ["50_3880", 0]]);
    expect(sweep.rooms.map((room) => room.id)).toEqual(["ur-50_4090-000010701"]);
    expect(sweep.gone).toEqual([]);
    // No room list is asked for an estate without vacancies.
    expect(api.calls).toEqual(["bukken/search/map_marker/", "bukken/result/bukken_result/", "bukken/detail/detail_bukken_room/", "bukken/detail/detail_room/#000010701"]);
    expect(sweep.calls).toBe(4);
  });

  it("asks UR about held rooms it stopped listing, in swept estates only", async () => {
    const api = fakeApi({ stillListed: ["000020304"] });
    const sweep = await sweepUr(api, options(["ur-50_4090-000010701", "ur-50_4090-000030101", "ur-50_3880-000020304", "ur-50_1820-000010101"]));
    expect(sweep.gone).toEqual([{ id: "ur-50_4090-000030101", checkedAt: "2026-10-09T05:00:00.000Z", evidence: expect.stringContaining("no longer advertised") }]);
    expect(sweep.stillAnswering).toEqual(["ur-50_3880-000020304"]);
    // 50_1820 (川口芝園) was not swept, so it is not asked about.
    expect(api.calls.filter((call) => call.includes("detail_room"))).toHaveLength(3);
  });

  it("does not place an estate UR gives no coordinates for", async () => {
    const api = fakeApi();
    const original = api.call.bind(api);
    api.call = async (endpoint, params) => (endpoint === "bukken/search/map_marker/" ? MARKERS.slice(0, 1) : original(endpoint, params));
    const sweep = await sweepUr(api, options());
    expect(sweep.estates.map((estate) => estate.code)).toEqual(["50_4090"]);
    expect(sweep.unplaced).toEqual([{ code: "50_3880", name: "ハーモネスタワー松原" }]);
  });

  describe("a municipality UR answers HTTP 500 for", () => {
    const failing = (api: ReturnType<typeof fakeApi>, code: string) => {
      const original = api.call.bind(api);
      api.call = async (endpoint, params) => {
        if (endpoint === "bukken/result/bukken_result/" && field(params, "skcs") === code) throw new UrApiError("UR API bukken/result/bukken_result/ failed: HTTP 500 error", 500);
        return original(endpoint, params);
      };
      return api;
    };
    const UNLISTED = { ...SOKA, label: "Kawajima-machi", code: "11346" };

    it("is retried once, then skipped and reported when it is optional; the other cities are still swept", async () => {
      const sweep = await sweepUr(failing(fakeApi(), "346"), { ...options(), cities: [{ ...UNLISTED, optional: true }, SOKA] });
      expect(sweep.skippedCities).toEqual(["11346"]);
      expect(sweep.estates.map((estate) => estate.code)).toEqual(["50_4090", "50_3880"]);
    });

    it("is read normally when UR's 500 does not repeat", async () => {
      const api = fakeApi();
      const original = api.call.bind(api);
      let failures = 0;
      api.call = async (endpoint, params) => {
        if (endpoint === "bukken/result/bukken_result/" && !failures++) throw new UrApiError("UR API failed: HTTP 500 error", 500);
        return original(endpoint, params);
      };
      const sweep = await sweepUr(api, { ...options(), cities: [{ ...SOKA, optional: true }] });
      expect(sweep.skippedCities).toEqual([]);
      expect(sweep.estates).toHaveLength(2);
    });

    it("fails the sweep when it is not optional, or the failure is not UR's 500", async () => {
      await expect(sweepUr(failing(fakeApi(), "346"), { ...options(), cities: [UNLISTED, SOKA] })).rejects.toThrow("HTTP 500");
      const api = fakeApi();
      const original = api.call.bind(api);
      api.call = async (endpoint, params) => {
        if (endpoint === "bukken/result/bukken_result/") throw new UrApiError("UR API failed: HTTP 403 error", 403);
        return original(endpoint, params);
      };
      await expect(sweepUr(api, { ...options(), cities: [{ ...UNLISTED, optional: true }] })).rejects.toThrow("HTTP 403");
    });
  });
});
