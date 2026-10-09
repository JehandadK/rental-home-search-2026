import { describe, expect, it } from "vitest";
import {
  CHINTAI_CITIES, CHINTAI_PREFECTURES, CHINTAI_SITEMAPS, chintaiArchiveUrl, chintaiBuildingUrl, chintaiDetailUrl,
  chintaiKeyFromUrl, chintaiLineUrl, chintaiListUrl, chintaiRentUrl, parseChintaiKey,
} from "./chintaiSite";
import { CHINTAI_TOWNS } from "./chintaiTowns";

const soka = { kind: "area", code: CHINTAI_CITIES.Soka } as const;

describe("CHINTAI URL builders", () => {
  it("builds list pages with one filter and a page segment only after page 1", () => {
    expect(chintaiListUrl("saitama", soka)).toBe("https://www.chintai.net/saitama/area/11221/list/");
    expect(chintaiListUrl("saitama", soka, { page: 2 })).toBe("https://www.chintai.net/saitama/area/11221/list/page2/");
    expect(chintaiListUrl("saitama", soka, { filter: "2ldk", page: 2 })).toBe("https://www.chintai.net/saitama/area/11221/list/2ldk/page2/");
    expect(chintaiListUrl("saitama", { kind: "ensen", code: "000004645" })).toBe("https://www.chintai.net/saitama/ensen/000004645/list/");
    expect(() => chintaiListUrl("saitama", soka, { page: 0 })).toThrow();
  });

  it("builds rent, archive, line, building and detail pages", () => {
    expect(chintaiRentUrl("saitama", soka, "2ldk")).toBe("https://www.chintai.net/saitama/area/11221/rent/2ldk/");
    expect(chintaiRentUrl("saitama", { kind: "ensen", code: "102082" })).toBe("https://www.chintai.net/saitama/ensen/102082/rent/");
    expect(chintaiArchiveUrl("saitama", soka, 3)).toBe("https://www.chintai.net/archive/saitama/area/11221/page3/");
    expect(chintaiLineUrl("saitama", "102082")).toBe("https://www.chintai.net/saitama/en-102082/");
    expect(chintaiBuildingUrl("saitama", "1282673")).toBe("https://www.chintai.net/saitama/bld-1282673/");
    expect(chintaiDetailUrl("C010095320944430006919700001")).toBe("https://www.chintai.net/detail/bk-C010095320944430006919700001/");
  });

  it("lists every prefecture once and the robots.txt sitemaps", () => {
    expect(new Set(CHINTAI_PREFECTURES).size).toBe(47);
    expect(CHINTAI_SITEMAPS).toContain("https://www.chintai.net/xml/sitemap_detail.xml");
  });

  it("keeps town codes under their city code", () => {
    for (const [city, towns] of Object.entries(CHINTAI_TOWNS)) {
      for (const code of Object.keys(towns)) expect(code).toMatch(new RegExp(`^${city}\\d{3}$`));
    }
    expect(CHINTAI_TOWNS[CHINTAI_CITIES.Soka]["11221027"]).toBe("氷川町");
  });
});

describe("CHINTAI ad keys", () => {
  it("splits Able keys and shares the unit across Able stores", () => {
    const keys = ["0000004160000000005365590005", "0000004260000000005365590005", "0000004310000000005365590005"].map(parseChintaiKey);
    expect(keys[0]).toMatchObject({ shopCode: "000000416", propertyCode: "000000000536559", roomCode: "0005" });
    expect(new Set(keys.map((key) => key.ableUnitKey))).toEqual(new Set(["000000000536559-0005"]));
  });

  it("gives other agents' keys no shared unit key", () => {
    expect(parseChintaiKey("C010095320944430006919700001")).toMatchObject({ shopCode: "C01009532", propertyCode: "094443000691970", roomCode: "0001", ableUnitKey: null });
    expect(() => parseChintaiKey("12345")).toThrow();
  });

  it("reads keys from detail URLs, ignoring list tracking queries", () => {
    expect(chintaiKeyFromUrl("/detail/bk-0000004310000000002058000002/?&prefkey=saitama&listingCnt=0000004310000000002058000002&vm=0")).toBe("0000004310000000002058000002");
    expect(chintaiKeyFromUrl("https://www.chintai.net/detail/tn-0000005120000000008132640002/")).toBe("0000005120000000008132640002");
    expect(chintaiKeyFromUrl("https://www.chintai.net/saitama/bld-1282673/")).toBeNull();
  });
});
