import { describe, expect, it } from "vitest";
import type { RawListing } from "../../domain/types";
import { mergeSuumoObserved, suumoKey } from "./suumoIdentity";

const make = (over: Partial<RawListing> = {}): RawListing => ({
  name: "Sample",
  address: "埼玉県草加市金明町",
  city: "Soka",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 55,
  builtYear: 2010,
  stationWalkMin: 8,
  url: "https://suumo.jp/chintai/jnc_000100000001/?bc=100500000001",
  source: "suumo",
  ...over,
});

describe("suumoKey", () => {
  it("uses bc so title, rent and size changes still overlap", () => {
    const a = make({ name: "Before", rent: 100_000, sizeM2: 55 });
    const b = make({ name: "After", rent: 90_000, sizeM2: 54.8 });
    expect(suumoKey(a)).toBe("bc:100500000001");
    expect(suumoKey(a)).toBe(suumoKey(b));
  });

  it("uses jnc and then the lifecycle key as fallbacks", () => {
    expect(suumoKey(make({ url: "https://suumo.jp/chintai/jnc_000100000002/" }))).toBe(
      "jnc:000100000002",
    );
    expect(suumoKey(make({ url: null }))).toMatch(/^property:/);
  });
});

describe("mergeSuumoObserved", () => {
  it("adds discoveries and preserves unseen old inventory", () => {
    const old = make({ name: "Old", address: "埼玉県草加市金明町", url: "https://suumo.jp/?bc=1" });
    const fresh = make({ name: "New", address: "埼玉県越谷市蒲生町", url: "https://suumo.jp/?bc=2" });
    const result = mergeSuumoObserved([old], [fresh]);
    expect(result.listings.map((l) => l.name)).toEqual(["New", "Old"]);
    expect(result).toMatchObject({ added: 1, updated: 0, overlaps: 0 });
  });

  it("overlays summary changes while preserving parking", () => {
    const parking = { monthlyYen: 8_000, available: true, location: "onsite" as const, distanceM: null, raw: "敷地内8000円" };
    const old = make({ rent: 100_000, parking });
    const fresh = make({ rent: 95_000 });
    const result = mergeSuumoObserved([old], [fresh]);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({ rent: 95_000, parking });
    expect(result).toMatchObject({ added: 0, updated: 1, overlaps: 1 });
  });

  it("handles duplicate/overlapping search results once", () => {
    const old = make({ name: "Old name" });
    const first = make({ name: "Current name" });
    const duplicate = make({ name: "Duplicate cassette", url: "https://suumo.jp/?bc=2" });
    const result = mergeSuumoObserved([old], [first, duplicate]);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].name).toBe("Current name");
    expect(result).toMatchObject({ added: 0, updated: 1, overlaps: 2 });
  });
});
