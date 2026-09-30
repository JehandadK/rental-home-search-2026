import { describe, expect, it } from "vitest";
import { adKey, adAvailability, describeAvailability, isRentedOut, withAvailability, type AvailabilityMap } from "./availability";
import { EMPTY_FILTERS, matchesListing } from "./filters";
import { lifecycleCounts } from "./lifecycle";
import type { AdAvailability, EnrichedListing } from "./types";

const gone = (checkedAt = "2026-09-30T00:00:00.000Z"): AdAvailability => ({ state: "gone", checkedAt, evidence: "HTTP 404", method: "probe" });
const listed = (checkedAt = "2026-09-30T00:00:00.000Z"): AdAvailability => ({ state: "listed", checkedAt, evidence: "HTTP 200", method: "probe" });

const SUUMO = "https://suumo.jp/chintai/jnc_000109828511/?bc=100526940814";
const ATHOME = "https://www.athome.co.jp/chintai/1132839134/?DOWN=1&BKLISTID=001LPC";

function listing(over: Partial<EnrichedListing> = {}): EnrichedListing {
  return {
    name: "Home", address: "埼玉県草加市金明町1", rent: 80000, layout: "2LDK", sizeM2: 50, builtYear: 2010,
    stationWalkMin: 5, url: SUUMO, source: "suumo", geocoded: false,
    sourceListings: [{ source: "suumo", url: SUUMO }, { source: "athome", url: ATHOME }],
    ...over,
  } as EnrichedListing;
}

describe("adKey", () => {
  it("ignores tracking query strings and hashes", () => {
    expect(adKey("suumo", SUUMO)).toBe("suumo|jnc_000109828511");
    expect(adKey("suumo", "https://suumo.jp/chintai/jnc_000109828511/")).toBe("suumo|jnc_000109828511");
    expect(adKey("athome", ATHOME)).toBe("athome|1132839134");
    expect(adKey("nifty", "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_63aeb294ac273e7a9de8fb8879eba592/")).toBe("nifty|detail_63aeb294ac273e7a9de8fb8879eba592");
    expect(adKey("roomspot", "https://www.roomspot.net/rent/1139288674810000004421")).toBe("roomspot|1139288674810000004421");
  });
  it("falls back to the URL without its query, then to the id", () => {
    expect(adKey("other", "https://x.example/a?b=1#c")).toBe("other|https://x.example/a");
    expect(adKey("other", null, "77")).toBe("other|77");
  });
});

describe("isRentedOut", () => {
  it("needs every ad gone: one live portal keeps the property available", () => {
    const one = listing({ sourceListings: [{ source: "suumo", url: SUUMO, availability: gone() }, { source: "athome", url: ATHOME }] });
    expect(isRentedOut(one)).toBe(false);
    const live = listing({ sourceListings: [{ source: "suumo", url: SUUMO, availability: gone() }, { source: "athome", url: ATHOME, availability: listed() }] });
    expect(isRentedOut(live)).toBe(false);
    const all = listing({ sourceListings: [{ source: "suumo", url: SUUMO, availability: gone() }, { source: "athome", url: ATHOME, availability: gone() }] });
    expect(isRentedOut(all)).toBe(true);
  });
  it("works for a single-portal listing that was never merged", () => {
    const solo = listing({ sourceListings: undefined });
    expect(isRentedOut(solo)).toBe(false);
    expect(isRentedOut(withAvailability(solo, { [adKey("suumo", SUUMO)]: { ...gone(), source: "suumo", url: SUUMO } }))).toBe(true);
  });
});

describe("withAvailability", () => {
  const records: AvailabilityMap = { [adKey("athome", ATHOME)]: { ...gone(), source: "athome", url: ATHOME } };

  it("overlays only the matching ad and keeps identity when nothing changes", () => {
    const base = listing();
    const out = withAvailability(base, records);
    expect(out.sourceListings!.find((ad) => ad.source === "athome")!.availability?.state).toBe("gone");
    expect(out.sourceListings!.find((ad) => ad.source === "suumo")!.availability).toBeUndefined();
    expect(withAvailability(base, {})).toBe(base);
    const again = withAvailability(out, records);
    expect(again).toBe(out);
  });

  it("the newer check wins, so a later 'listed' undoes an earlier 'gone'", () => {
    const ref = { source: "athome", url: ATHOME, availability: gone("2026-09-01T00:00:00.000Z") };
    const later: AvailabilityMap = { [adKey("athome", ATHOME)]: { ...listed("2026-09-30T00:00:00.000Z"), method: "manual", source: "athome", url: ATHOME } };
    expect(adAvailability(ref, later)?.state).toBe("listed");
    const earlier: AvailabilityMap = { [adKey("athome", ATHOME)]: { ...listed("2026-08-01T00:00:00.000Z"), source: "athome", url: ATHOME } };
    expect(adAvailability(ref, earlier)?.state).toBe("gone");
  });
});

describe("filters and counts", () => {
  const rented = listing({ sourceListings: [{ source: "suumo", url: SUUMO, availability: gone() }, { source: "athome", url: ATHOME, availability: gone() }] });
  it("hides rented-out properties by default, and can show or isolate them", () => {
    expect(matchesListing(rented, EMPTY_FILTERS)).toBe(false);
    expect(matchesListing(rented, { ...EMPTY_FILTERS, rentedOut: "show" })).toBe(true);
    expect(matchesListing(rented, { ...EMPTY_FILTERS, rentedOut: "only" })).toBe(true);
    expect(matchesListing(listing(), { ...EMPTY_FILTERS, rentedOut: "only" })).toBe(false);
    expect(matchesListing(listing(), EMPTY_FILTERS)).toBe(true);
  });
  it("counts them for the header", () => {
    expect(lifecycleCounts([rented, listing()]).rentedOutCount).toBe(1);
  });
});

describe("describeAvailability", () => {
  it("explains the state in plain language", () => {
    expect(describeAvailability(undefined)).toBe("not checked");
    expect(describeAvailability(gone())).toBe("gone · checked 2026-09-30 · HTTP 404");
    expect(describeAvailability({ ...listed(), method: "manual" })).toContain("marked by hand");
  });
});
