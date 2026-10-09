import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampNewWindowDays,
  isNewListing,
  isSold,
  lifecycleCounts,
  MAX_NEW_WINDOW_DAYS,
  MIN_NEW_WINDOW_DAYS,
  NEW_LISTING_WINDOW_DAYS,
} from "./lifecycle";
import type { EnrichedListing } from "./types";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const make = (over: Partial<EnrichedListing>): EnrichedListing => ({
  name: "L",
  address: "埼玉県草加市金明町１",
  city: "Soka",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 55,
  builtYear: 2010,
  stationWalkMin: 8,
  url: null,
  source: "test",
  geocoded: true,
  ...over,
});

describe("isSold", () => {
  it("treats only an explicit sold status as sold (legacy data is active)", () => {
    expect(isSold(make({ status: "sold" }))).toBe(true);
    expect(isSold(make({ status: "active" }))).toBe(false);
    expect(isSold(make({}))).toBe(false);
  });
});

describe("isNewListing", () => {
  it("is new inside the window, stale after it", () => {
    expect(isNewListing(make({ firstSeenAt: daysAgo(2) }), NOW)).toBe(true);
    expect(
      isNewListing(make({ firstSeenAt: daysAgo(NEW_LISTING_WINDOW_DAYS - 1) }), NOW),
    ).toBe(true);
    expect(
      isNewListing(make({ firstSeenAt: daysAgo(NEW_LISTING_WINDOW_DAYS + 1) }), NOW),
    ).toBe(false);
  });

  it("honours a shorter window", () => {
    expect(isNewListing(make({ firstSeenAt: daysAgo(2) }), NOW, 3)).toBe(true);
    expect(isNewListing(make({ firstSeenAt: daysAgo(4) }), NOW, 3)).toBe(false);
    expect(isNewListing(make({ firstSeenAt: daysAgo(0.5) }), NOW, 1)).toBe(true);
    expect(isNewListing(make({ firstSeenAt: daysAgo(1.5) }), NOW, 1)).toBe(false);
  });

  it("never calls legacy (null firstSeenAt) or sold listings new", () => {
    expect(isNewListing(make({ firstSeenAt: null }), NOW)).toBe(false);
    expect(isNewListing(make({}), NOW)).toBe(false);
    expect(isNewListing(make({ status: "sold", firstSeenAt: daysAgo(1) }), NOW)).toBe(false);
  });
});

describe("lifecycleCounts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("counts new and sold listings for the header", () => {
    const listings = [
      make({ name: "new1", firstSeenAt: daysAgo(3) }),
      make({ name: "new2", firstSeenAt: daysAgo(0) }),
      make({ name: "old", firstSeenAt: daysAgo(60) }),
      make({ name: "legacy", firstSeenAt: null }),
      make({ name: "gone", status: "sold", firstSeenAt: daysAgo(1) }),
    ];
    expect(lifecycleCounts(listings)).toEqual({ newCount: 2, soldCount: 1, rentedOutCount: 0 });
  });
});

describe("clampNewWindowDays", () => {
  it("keeps whole days from 1 to 14, defaulting anything unusable", () => {
    expect(MIN_NEW_WINDOW_DAYS).toBe(1);
    expect(MAX_NEW_WINDOW_DAYS).toBe(14);
    expect(clampNewWindowDays(7)).toBe(7);
    expect(clampNewWindowDays(0)).toBe(1);
    expect(clampNewWindowDays(30)).toBe(14);
    expect(clampNewWindowDays(3.6)).toBe(4);
    expect(clampNewWindowDays("7")).toBe(NEW_LISTING_WINDOW_DAYS);
    expect(clampNewWindowDays(Number.NaN)).toBe(NEW_LISTING_WINDOW_DAYS);
    expect(clampNewWindowDays(undefined)).toBe(NEW_LISTING_WINDOW_DAYS);
  });
});
