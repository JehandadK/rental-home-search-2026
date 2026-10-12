import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectorSettings, describeSettings, keepsArea, portalAreaStep, readCollectorConfig, withMinArea } from "./searchFilters";

describe("collector search filters", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "collector-config-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("reads each source's minimum area, treating a missing file or bad value as no filter", async () => {
    const path = join(root, "collectors.config.json");
    expect(readCollectorConfig(path)).toEqual({});
    await writeFile(path, JSON.stringify({ sources: { suumo: { minAreaM2: 60 }, nifty: { minAreaM2: "big" }, ur: { minAreaM2: null } } }));
    expect(readCollectorConfig(path)).toEqual({ suumo: { minAreaM2: 60 }, nifty: { minAreaM2: null }, ur: { minAreaM2: null } });
  });

  it("lets --min-area override the file for one run, with 0 meaning any area", () => {
    const config = { suumo: { minAreaM2: 60 } };
    expect(collectorSettings("suumo", [], config)).toEqual({ minAreaM2: 60 });
    expect(collectorSettings("suumo", ["--min-area", "70"], config)).toEqual({ minAreaM2: 70 });
    expect(collectorSettings("suumo", ["--min-area", "0"], config)).toEqual({ minAreaM2: null });
    expect(collectorSettings("athome", [], config)).toEqual({ minAreaM2: null });
    expect(() => collectorSettings("suumo", ["--min-area", "lots"], config)).toThrow("--min-area needs a number");
  });

  it("never filters UR, whose sweep would record skipped rooms as gone", () => {
    expect(collectorSettings("ur", ["--min-area", "60"], { ur: { minAreaM2: 60 } })).toEqual({ minAreaM2: null });
    expect(describeSettings("ur", { minAreaM2: null })).toMatch(/none/);
  });

  it("rounds a minimum down to a step the portal's search form offers", () => {
    expect(portalAreaStep("suumo", 60)).toBe(60);
    expect(portalAreaStep("suumo", 75)).toBe(70);
    expect(portalAreaStep("nifty", 75)).toBe(75);
    expect(portalAreaStep("roomspot", 15)).toBeNull();
    expect(portalAreaStep("athome", 60)).toBeNull();
    expect(portalAreaStep("suumo", null)).toBeNull();
  });

  it("adds each portal's own area parameter to its search URL", () => {
    expect(withMinArea("suumo", "https://suumo.jp/chintai/saitama/sc_soka/?md=05&po1=09", 60))
      .toBe("https://suumo.jp/chintai/saitama/sc_soka/?md=05&po1=09&mb=60&mt=9999999");
    expect(withMinArea("nifty", "https://myhome.nifty.com/rent/saitama/sokashi_ct/2/?sort=regDate-desc", 60))
      .toBe("https://myhome.nifty.com/rent/saitama/sokashi_ct/2/?sort=regDate-desc&r10=60");
    expect(withMinArea("roomspot", "https://www.roomspot.net/rent/search/area/pref_11/city_221/?ftlsflg=1", 62))
      .toBe("https://www.roomspot.net/rent/search/area/pref_11/city_221/?ftlsflg=1&occupied_area_from=60.0");
    const athome = "https://www.athome.co.jp/chintai/saitama/soka-city/list/";
    expect(withMinArea("athome", athome, 60)).toBe(athome);
    expect(withMinArea("suumo", athome, null)).toBe(athome);
  });

  it("keeps rooms at or above the minimum and rooms that state no area", () => {
    expect(keepsArea(60, 60)).toBe(true);
    expect(keepsArea(59.9, 60)).toBe(false);
    expect(keepsArea(null, 60)).toBe(true);
    expect(keepsArea(20, null)).toBe(true);
  });

  it("says in the log what a run collects", () => {
    expect(describeSettings("suumo", { minAreaM2: 60 })).toBe("Area filter: ≥60㎡ (portal search ≥60㎡)");
    expect(describeSettings("roomspot", { minAreaM2: 62 })).toBe("Area filter: ≥62㎡ (portal search ≥60㎡, then each page's rooms)");
    expect(describeSettings("athome", { minAreaM2: 60 })).toBe("Area filter: ≥60㎡ (applied to each page's rooms)");
    expect(describeSettings("nifty", { minAreaM2: null })).toBe("Area filter: none");
  });
});
