import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RakuchinPeriod } from "../../domain/urRooms";
import { readUrHistory, recordUrHistory } from "./urHistoryStore";

const period = (firstCapturedAt: string): RakuchinPeriod => ({
  estateCode: "50_4090", jkss: "000010701", label: "1号棟701号室", layout: "2DK", sizeM2: 50, floor: "7階", rent: 108_400, commonFee: 3_500,
  listedFrom: "2026-10-08T00:00:00.000Z", listedUntil: "2026-10-10T00:00:00.000Z", firstCapturedAt,
});
const sweep = (capturedAt: string) => ({ capturedAt, cities: ["Soka"], minRooms: 2, roomIds: [] });
const page = (capturedAt: string) => ({ capturedAt, estateCode: "50_4090", url: "u", name: null, totalUnits: 1, currentVacancy: 0, openRooms: [] });

describe("UR history store", () => {
  let root: string, path: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ur-history-")); path = join(root, "ur-history.json"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("only adds: a repeated sweep, page read or period is kept once, and the first read of a period wins", async () => {
    expect(await recordUrHistory({ sweeps: [sweep("2026-10-10T00:00:00.000Z")], estatePages: [page("2026-10-11T00:00:00.000Z")], periods: [["a", period("2026-10-11T00:00:00.000Z")]] }, path))
      .toEqual({ sweeps: 1, estatePages: 1, periods: 1 });
    expect(await recordUrHistory({ sweeps: [sweep("2026-10-10T00:00:00.000Z"), sweep("2026-10-09T00:00:00.000Z")], estatePages: [page("2026-10-11T00:00:00.000Z")], periods: [["a", period("2026-10-12T00:00:00.000Z")]] }, path))
      .toEqual({ sweeps: 1, estatePages: 0, periods: 0 });
    const history = await readUrHistory(path);
    expect(history.sweeps.map((s) => s.capturedAt)).toEqual(["2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z"]);
    expect(history.periods.a.firstCapturedAt).toBe("2026-10-11T00:00:00.000Z");
  });

  it("reads a missing file as an empty history", async () => {
    expect(await readUrHistory(path)).toEqual({ schemaVersion: 1, sweeps: [], estatePages: [], periods: {} });
  });
});
