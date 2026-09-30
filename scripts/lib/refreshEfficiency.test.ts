import { describe, expect, it } from "vitest";
import { DEFAULT_INCREMENTAL_PAGE_CEILING, planRefresh, completeMarket, positiveInteger } from "./refreshPlan";
import { addressKey, cachedGeocode, seedGeocodes } from "./geocodeCache";
import { parseDetail, applyDetail } from "./detailEnrichment";
import { restoreObservedLifecycle } from "../../src/storage/json/observations";
import { validateCapture } from "./captureStore";
import { packListings, unpackListings } from "../../src/domain/webPayload";
import type { RawListing, EnrichedListing } from "../../src/domain/types";
import { trackingKey } from "../../src/data-layer/lifecycle";
import { newerRows, assertParsedFamilies } from "./captureValidation";
const base: RawListing = { name: "Home", address: "埼玉県草加市１", source: "suumo", id: "s1", url: "https://suumo.jp/a", rent: 80000, layout: "2LDK", sizeM2: 50, builtYear: 2010, stationWalkMin: 5 };

describe("efficient refresh", () => {
  it("retries failed collectors, not successful independent ones", () => {
    const stages = ["suumo", "athome", "roomspot", "nifty-soka", "nifty-import", "data-build", "enrich", "web-data"].map((id) => ({ id, label: id, status: id === "athome" ? "failed" as const : "success" as const, attempts: [] }));
    expect([...planRefresh(stages, true)]).toEqual(["athome", "data-build", "enrich", "web-data"]);
  });
  it("caps never establish absence", () => {
    expect(completeMarket(true, [{ exhausted: false }, { exhausted: true }])).toBe(false);
    expect(completeMarket(true, [])).toBe(false);
    expect(completeMarket(true, [{ exhausted: true }])).toBe(true);
    expect(completeMarket(false, [{ exhausted: true }])).toBe(false);
  });
  it("uses a generous safety ceiling so incremental scans reach prior observations", () => {
    expect(DEFAULT_INCREMENTAL_PAGE_CEILING).toBeGreaterThanOrEqual(100);
  });
  it("validates budgets", () => {
    expect(positiveInteger("0", 10, 0)).toBe(0);
    expect(() => positiveInteger("NaN", 10)).toThrow();
    expect(() => positiveInteger("-1", 10)).toThrow();
  });
  it("reuses exact normalized addresses, not nearby-but-different blocks", () => {
    const cache = seedGeocodes([{ ...base, geocoded: true, lat: 35.8, lon: 139.8 }], {});
    expect(cachedGeocode(cache, "埼玉県 草加市1")?.value?.lat).toBe(35.8);
    expect(cachedGeocode(cache, "埼玉県草加市2")).toBeUndefined();
    expect(addressKey("Ａ　１")).toBe("A1");
    cache.bad = { value: null, checkedAt: "2020-01-01" };
    expect(cachedGeocode(cache, "bad")).toBeUndefined();
  });
  it("gets all detail fields in one parse and preserves unknowns", () => {
    const d = parseDetail('<table><tr><th>駐車場</th><td>敷地内6600円</td></tr><tr><th>契約期間</th><td>定期借家2年</td></tr><tr><th>保証会社</th><td>必加入</td></tr></table><ul class="inline_list"><li>都市ガス</li></ul>');
    expect(d.parking?.monthlyYen).toBe(6600);
    expect(d.tenancy?.leaseMonths).toBe(24);
    expect(d.building?.features).toEqual(["都市ガス"]);
    expect(d.costs?.guarantorRequired).toBe(true);
    expect(applyDetail({ ...base, costs: { cleaningFeeYen: 40000 } }, d).costs?.cleaningFeeYen).toBe(40000);
    expect(() => parseDetail('<h1>Human Verification</h1>')).toThrow();
  });
  it("uses observation time from a secondary portal, never build time", () => {
    const prior = { ...base, status: "sold" as const, soldAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-08-01T00:00:00Z" };
    const secondary = { ...base, id: "a1", source: "athome", url: "https://www.athome.co.jp/chintai/1/" };
    const rows = [{ ...base, sourceListings: [{ source: "athome", id: "a1", url: secondary.url }] }];
    restoreObservedLifecycle(rows, [prior], [{ source: "athome", scrapedAt: "2026-09-07T00:00:00Z", count: 1, completeSnapshot: false, listings: [secondary], provenance: { observedTrackingKeys: [trackingKey(secondary)], observedAtByKey: { [trackingKey(secondary)]: "2026-09-06T00:00:00Z" } } }]);
    expect((rows[0] as RawListing).lastSeenAt).toBe("2026-09-06T00:00:00Z");
    expect((rows[0] as RawListing).status).toBe("active");
  });
  it("does not reactivate sold listings using older capture evidence", () => {
    const prior = { ...base, status: "sold" as const, soldAt: "2026-09-05T00:00:00Z" };
    const rows: RawListing[] = [{ ...base }];
    restoreObservedLifecycle(rows, [prior], [{ source: "suumo", scrapedAt: "2026-09-01T00:00:00Z", completeSnapshot: false, count: 1, listings: [base], provenance: { observedTrackingKeys: [trackingKey(base)] } }]);
    expect(rows[0].status).toBe("sold");
  });
  it("rejects failed/unrecognized captures instead of empty-market claims", () => {
    const c = { schemaVersion: 1 as const, source: "athome" as const, city: "Soka", url: "https://www.athome.co.jp/list/", page: 1, capturedAt: "2026-09-07", httpStatus: 200, html: "Human verification" };
    expect(() => validateCapture(c)).toThrow();
    expect(() => validateCapture({ ...c, html: '<div class="p-property"/>', httpStatus: 403 })).toThrow();
    expect(() => validateCapture({ ...c, html: '<div class="p-property"/>' })).not.toThrow();
  });
  it("rejects silent family parser failures and stale price replays", () => {
    const capture = { schemaVersion: 1 as const, source: "athome" as const, city: "Soka", url: "https://www.athome.co.jp/list/", page: 1, capturedAt: "2026-09-07", httpStatus: 200, html: '<div class="p-property"><span class="p-property__floor">2LDK</span></div>' };
    expect(() => assertParsedFamilies(capture, [])).toThrow();
    expect(() => assertParsedFamilies({ ...capture, html: '<span class="p-property__floor">1K</span>' }, [])).not.toThrow();
    const source = { source: "suumo", scrapedAt: "2026-09-07", count: 1, listings: [base] };
    expect(newerRows(source, [{ ...base, rent: 70000 }], "2026-09-06", (l) => [l.id!])).toEqual([]);
    expect(newerRows(source, [{ ...base, rent: 70000 }], "2026-09-08", (l) => [l.id!])).toHaveLength(1);
  });
  it("dictionary payload is lossless and smaller for repeated features", () => {
    const listings: EnrichedListing[] = Array.from({ length: 10 }, () => ({ ...base, geocoded: false, attributes: [{ key: "cityGas", category: "kitchen", labelEn: "City gas", labelJa: "都市ガス", state: true, raw: "都市ガス" }] }));
    const packed = packListings(listings);
    expect(unpackListings(packed)).toEqual(listings);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(listings).length);
  });
});
