import { describe, expect, it, vi } from "vitest";
import { checkProperty, type CheckDependencies } from "./checkProperty";
import { selectCandidates } from "./selectCandidates";
import { adKey, type AvailabilityMap } from "../../domain/availability";
import type { AdVisit } from "./classify";
import type { RawListing } from "../../domain/types";

const NIFTY = "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_aa11/";
const SUUMO = "https://suumo.jp/chintai/jnc_000000000001/?bc=1";
const ATHOME = "https://www.athome.co.jp/chintai/1143327034/";

const home = (over: Partial<RawListing> = {}): RawListing => ({
  name: "Home", address: "埼玉県草加市1", rent: 80000, layout: "2LDK", sizeM2: 50, builtYear: 2010, stationWalkMin: 5,
  url: ATHOME, source: "athome",
  sourceListings: [{ source: "athome", url: ATHOME }, { source: "suumo", url: SUUMO }, { source: "nifty", url: NIFTY }],
  ...over,
});

const gonePage = (url: string): AdVisit => ({ requestedUrl: url, finalUrl: url, httpStatus: 404, title: "お探しのページが見つかりません", text: "" });
const livePage = (url: string): AdVisit => ({ requestedUrl: url, finalUrl: url, httpStatus: 200, title: "物件 詳細", text: "" });

function deps(pages: Record<string, AdVisit | Error>) {
  const visited: string[] = [];
  const value: CheckDependencies = {
    visit: async ({ url }) => {
      visited.push(url);
      const page = pages[url];
      if (page instanceof Error) throw page;
      return page ?? livePage(url);
    },
    now: () => "2026-09-30T12:00:00.000Z", sleep: vi.fn(async () => undefined), delayMs: 0,
  };
  return { value, visited };
}

describe("checkProperty", () => {
  it("stops at the first live portal, so an available property costs one visit", async () => {
    const { value, visited } = deps({});
    const result = await checkProperty(home(), {}, value);
    expect(visited).toEqual([NIFTY]);
    expect(result.rentedOut).toBe(false);
    expect(result.records).toEqual([expect.objectContaining({ source: "nifty", state: "listed", method: "probe" })]);
  });

  it("is rented out only when every portal is gone, checking cheapest first", async () => {
    const { value, visited } = deps({ [NIFTY]: gonePage(NIFTY), [SUUMO]: gonePage(SUUMO), [ATHOME]: gonePage(ATHOME) });
    const result = await checkProperty(home(), {}, value);
    expect(visited).toEqual([NIFTY, SUUMO, ATHOME]);
    expect(result.rentedOut).toBe(true);
    expect(result.records.map((r) => r.state)).toEqual(["gone", "gone", "gone"]);
  });

  it("gone on one portal but live on another stays available", async () => {
    const { value } = deps({ [NIFTY]: gonePage(NIFTY), [SUUMO]: livePage(SUUMO) });
    const result = await checkProperty(home(), {}, value);
    expect(result.rentedOut).toBe(false);
    expect(result.records.map((r) => [r.source, r.state])).toEqual([["nifty", "gone"], ["suumo", "listed"]]);
  });

  it("does not revisit ads already recorded gone", async () => {
    const known: AvailabilityMap = {
      [adKey("nifty", NIFTY)]: { source: "nifty", url: NIFTY, state: "gone", checkedAt: "2026-09-29T00:00:00.000Z", evidence: "x", method: "probe" },
      [adKey("suumo", SUUMO)]: { source: "suumo", url: SUUMO, state: "gone", checkedAt: "2026-09-29T00:00:00.000Z", evidence: "x", method: "manual" },
    };
    const { value, visited } = deps({ [ATHOME]: gonePage(ATHOME) });
    const result = await checkProperty(home(), known, value);
    expect(visited).toEqual([ATHOME]);
    expect(result.rentedOut).toBe(true);
    expect(result.ads.map((ad) => ad.verdict)).toEqual(["known-gone", "known-gone", "gone"]);
  });

  it("never records a failed or blocked visit as gone", async () => {
    const { value } = deps({ [NIFTY]: new Error("Navigation timeout"), [SUUMO]: { ...livePage(SUUMO), title: "認証にご協力ください。" }, [ATHOME]: gonePage(ATHOME) });
    const result = await checkProperty(home(), {}, value);
    expect(result.rentedOut).toBe(false);
    expect(result.ads.map((ad) => ad.verdict)).toEqual(["unknown", "unknown", "gone"]);
    expect(result.records.map((r) => r.state)).toEqual(["gone"]);
  });

  it("pauses between page loads but not before the first", async () => {
    const { value } = deps({ [NIFTY]: gonePage(NIFTY), [SUUMO]: gonePage(SUUMO), [ATHOME]: gonePage(ATHOME) });
    await checkProperty(home(), {}, value);
    expect(value.sleep).toHaveBeenCalledTimes(2);
  });
});

describe("selectCandidates", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const rows = [
    home({ name: "recent", lastSeenAt: "2026-09-29T00:00:00.000Z" }),
    home({ name: "oldest", lastSeenAt: "2026-09-01T00:00:00.000Z" }),
    home({ name: "sold", status: "sold", lastSeenAt: "2026-08-01T00:00:00.000Z" }),
    home({ name: "never", lastSeenAt: null }),
    home({ name: "middle", lastSeenAt: "2026-09-15T00:00:00.000Z", city: "Soka" }),
  ];

  it("puts the longest-unseen first, skips sold, and honours the limit", () => {
    const names = selectCandidates(rows, {}, { limit: 3, staleDays: 3, now }).map((r) => r.name);
    expect(names).toEqual(["oldest", "middle", "recent"]);
  });

  it("skips properties confirmed live recently and ones already rented out", () => {
    const known: AvailabilityMap = {
      [adKey("nifty", NIFTY)]: { source: "nifty", url: NIFTY, state: "listed", checkedAt: "2026-09-29T00:00:00.000Z", evidence: "", method: "probe" },
    };
    expect(selectCandidates([rows[0]], known, { limit: 5, staleDays: 3, now })).toEqual([]);
    expect(selectCandidates([rows[0]], known, { limit: 5, staleDays: 0.5, now })).toHaveLength(1);
    const allGone: AvailabilityMap = Object.fromEntries([["athome", ATHOME], ["suumo", SUUMO], ["nifty", NIFTY]].map(([s, u]) =>
      [adKey(s, u), { source: s, url: u, state: "gone" as const, checkedAt: "2026-09-29T00:00:00.000Z", evidence: "", method: "probe" as const }]));
    expect(selectCandidates([rows[0]], allGone, { limit: 5, staleDays: 3, now })).toEqual([]);
    expect(selectCandidates([rows[0]], allGone, { limit: 5, staleDays: 3, now, recheckGone: true })).toHaveLength(1);
  });

  it("filters by city, size and rent", () => {
    expect(selectCandidates(rows, {}, { limit: 9, staleDays: 3, now, city: "Soka" }).map((r) => r.name)).toEqual(["middle"]);
    expect(selectCandidates(rows, {}, { limit: 9, staleDays: 3, now, minSizeM2: 60 })).toEqual([]);
    expect(selectCandidates(rows, {}, { limit: 9, staleDays: 3, now, maxRent: 70000 })).toEqual([]);
  });
});
