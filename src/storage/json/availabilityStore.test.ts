import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adKey } from "../../domain/availability";
import { readAvailability, readAvailabilityFile, recordAvailability } from "./availabilityStore";

const URL_A = "https://www.athome.co.jp/chintai/1143327034/?tracking=1";
const entry = (checkedAt: string, state: "gone" | "listed") => ({ source: "athome", url: URL_A, state, checkedAt, evidence: state, method: "probe" as const });

describe("availability store", () => {
  let dir: string, path: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "availability-")); path = join(dir, "availability.json"); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("reads as empty before the first check", async () => {
    expect(await readAvailability(path)).toEqual({});
  });

  it("keys records per ad, ignoring tracking query strings, and keeps the newest check", async () => {
    await recordAvailability([entry("2026-09-30T00:00:00.000Z", "gone")], path);
    await recordAvailability([entry("2026-09-01T00:00:00.000Z", "listed")], path); // older: not current
    const records = await readAvailability(path);
    expect(Object.keys(records)).toEqual([adKey("athome", "https://www.athome.co.jp/chintai/1143327034/")]);
    expect(Object.values(records)[0].state).toBe("gone");
    await recordAvailability([entry("2026-10-02T00:00:00.000Z", "listed")], path); // newer: a re-listing wins
    expect(Object.values(await readAvailability(path))[0].state).toBe("listed");
  });

  it("keeps every check in the ad's history, so the first gone check survives re-checks", async () => {
    await recordAvailability([entry("2026-09-20T00:00:00.000Z", "listed")], path);
    await recordAvailability([entry("2026-09-30T00:00:00.000Z", "gone")], path);
    await recordAvailability([entry("2026-10-02T00:00:00.000Z", "gone")], path);
    await recordAvailability([entry("2026-09-25T00:00:00.000Z", "listed")], path); // late-arriving older check
    await recordAvailability([entry("2026-10-02T00:00:00.000Z", "gone")], path); // replay: no duplicate
    const [record] = Object.values(await readAvailabilityFile(path).then((file) => file.records));
    expect(record).toMatchObject({ state: "gone", checkedAt: "2026-10-02T00:00:00.000Z", source: "athome", url: URL_A });
    expect(record.history?.map((check) => `${check.checkedAt.slice(0, 10)} ${check.state}`)).toEqual([
      "2026-09-20 listed", "2026-09-25 listed", "2026-09-30 gone",
    ]);
  });

  it("remembers which URL each earlier check looked at when one record covers several ads", async () => {
    const jnc = "https://suumo.jp/chintai/jnc_000107662512/";
    await recordAvailability([{ source: "suumo", url: `${jnc}?bc=100508329517`, state: "gone", checkedAt: "2026-09-30T00:00:00.000Z", evidence: "redirected", method: "probe" }], path);
    await recordAvailability([{ source: "suumo", url: `${jnc}?bc=100518201426`, state: "listed", checkedAt: "2026-10-03T00:00:00.000Z", evidence: "ad page", method: "probe" }], path);
    const [record] = Object.values((await readAvailabilityFile(path)).records);
    expect(record.url).toBe(`${jnc}?bc=100518201426`);
    expect(record.history).toEqual([expect.objectContaining({ state: "gone", url: `${jnc}?bc=100508329517` })]);
  });

  it("rejects an unsupported file instead of guessing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ schemaVersion: 9, records: {} }));
    await expect(readAvailability(path)).rejects.toThrow("Unsupported availability file");
  });
});
