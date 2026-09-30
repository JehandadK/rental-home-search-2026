import { describe, expect, it } from "vitest";
import { reconcileLifecycle, trackingKey } from "./lifecycle";
import type { RawListing } from "../domain/types";

const NOW = "2026-08-30T12:00:00.000Z";
const BEFORE = "2026-08-01T12:00:00.000Z";

const make = (over: Partial<RawListing>): RawListing => ({
  name: "サンプルハイツ",
  address: "埼玉県草加市金明町１",
  city: "Soka",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 55,
  builtYear: 2010,
  stationWalkMin: 8,
  url: null,
  source: "suumo",
  ...over,
});

describe("trackingKey", () => {
  it("ignores rent so a price change is not a new listing", () => {
    expect(trackingKey(make({ rent: 100_000 }))).toBe(trackingKey(make({ rent: 120_000 })));
  });

  it("ignores whitespace and char-width noise in name/address", () => {
    expect(trackingKey(make({ name: "サンプル ハイツ" }))).toBe(trackingKey(make({})));
    expect(trackingKey(make({ address: "埼玉県草加市金明町1" }))).toBe(trackingKey(make({})));
  });

  it("ignores a newly discovered lot number", () => {
    const coarse = make({ name: "フェリーチェ", address: "埼玉県草加市西町" });
    const exact = make({ name: "フェリーチェ", address: "埼玉県草加市西町544" });
    expect(trackingKey(exact)).toBe(trackingKey(coarse));
  });

  it("distinguishes different sizes and buildings", () => {
    expect(trackingKey(make({ sizeM2: 55 }))).not.toBe(trackingKey(make({ sizeM2: 60 })));
    expect(trackingKey(make({ name: "別のハイツ" }))).not.toBe(trackingKey(make({})));
  });
});

describe("reconcileLifecycle", () => {
  it("stamps firstSeenAt on never-before-seen listings", () => {
    const { listings, stats } = reconcileLifecycle([], [make({})], NOW);
    expect(listings[0]).toMatchObject({ status: "active", firstSeenAt: NOW, lastSeenAt: NOW });
    expect(stats).toMatchObject({ added: 1, continued: 0, sold: 0, reactivated: 0 });
  });

  it("carries firstSeenAt forward for still-listed properties", () => {
    const previous = [make({ firstSeenAt: BEFORE, lastSeenAt: BEFORE, status: "active" })];
    const { listings, stats } = reconcileLifecycle(previous, [make({ rent: 110_000 })], NOW);
    expect(listings[0]).toMatchObject({
      status: "active",
      firstSeenAt: BEFORE,
      lastSeenAt: NOW,
      rent: 110_000,
    });
    expect(stats).toMatchObject({ added: 0, continued: 1, sold: 0 });
  });

  it("marks vanished listings sold and keeps them", () => {
    const previous = [
      make({ name: "残るマンション", firstSeenAt: BEFORE, status: "active" }),
      make({ name: "消えるマンション", firstSeenAt: BEFORE, status: "active" }),
    ];
    const current = [make({ name: "残るマンション" })];
    const { listings, stats } = reconcileLifecycle(previous, current, NOW);

    expect(listings).toHaveLength(2);
    const gone = listings.find((l) => l.name === "消えるマンション")!;
    expect(gone).toMatchObject({ status: "sold", soldAt: NOW, firstSeenAt: BEFORE });
    expect(stats).toMatchObject({ continued: 1, sold: 1, added: 0 });
  });

  it("keeps the original soldAt when a listing stays sold across builds", () => {
    const SOLD_AT = "2026-08-15T12:00:00.000Z";
    const previous = [make({ status: "sold", firstSeenAt: BEFORE, soldAt: SOLD_AT })];
    const { listings, stats } = reconcileLifecycle(previous, [], NOW);
    expect(listings[0]).toMatchObject({ status: "sold", soldAt: SOLD_AT });
    expect(stats).toMatchObject({ sold: 1 });
  });

  it("reactivates a sold listing that reappears, keeping its firstSeenAt", () => {
    const previous = [make({ status: "sold", firstSeenAt: BEFORE, soldAt: BEFORE })];
    const { listings, stats } = reconcileLifecycle(previous, [make({})], NOW);
    expect(listings[0]).toMatchObject({ status: "active", firstSeenAt: BEFORE, soldAt: null });
    expect(stats).toMatchObject({ reactivated: 1, added: 0, continued: 0 });
  });

  it("does not treat a rent change as sold + new", () => {
    const previous = [make({ rent: 100_000, firstSeenAt: BEFORE, status: "active" })];
    const current = [make({ rent: 95_000 })];
    const { listings, stats } = reconcileLifecycle(previous, current, NOW);
    expect(listings).toHaveLength(1);
    expect(stats).toMatchObject({ continued: 1, sold: 0, added: 0 });
  });

  it("handles a mixed refresh in one pass", () => {
    const previous = [
      make({ name: "継続A", firstSeenAt: BEFORE, status: "active" }),
      make({ name: "消えるB", firstSeenAt: BEFORE, status: "active" }),
    ];
    const current = [make({ name: "継続A" }), make({ name: "新規C", address: "埼玉県越谷市大間野町２" })];
    const { listings, stats } = reconcileLifecycle(previous, current, NOW);
    expect(listings.map((l) => l.name)).toEqual(["継続A", "新規C", "消えるB"]);
    expect(stats).toEqual({ continued: 1, added: 1, sold: 1, reactivated: 0 });
  });
});
