import { describe, expect, it } from "vitest";
import {
  effectiveMonthlyCost,
  parkingMonthlyYen,
  computeMoveInCosts,
  DEFAULT_MOVE_IN_ASSUMPTIONS,
  monthlyOutlay,
  stayCost,
  sunkCostInMonths,
} from "./moveInCost";
import type { EnrichedListing } from "./types";

const listing = (over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  name: "L",
  address: "埼玉県草加市",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2010,
  stationWalkMin: 8,
  url: null,
  source: "test",
  geocoded: true,
  ...over,
});

describe("computeMoveInCosts", () => {
  it("uses the figures printed on the listing", () => {
    const c = computeMoveInCosts(
      listing({ depositYen: 200_000, keyMoneyYen: 100_000, cleaningFeeYen: 55_000 }),
    );
    expect(c.deposit).toBe(200_000);
    expect(c.keyMoney).toBe(100_000);
    expect(c.cleaningFee).toBe(55_000);
    expect(c.estimated).toEqual({ deposit: false, keyMoney: false, cleaningFee: false });
  });

  it("falls back to assumptions and flags them as estimated", () => {
    const c = computeMoveInCosts(listing());
    expect(c.deposit).toBe(100_000); // 1 month
    expect(c.keyMoney).toBe(100_000); // 1 month
    expect(c.cleaningFee).toBe(60_000); // 50㎡ × ¥1,200
    expect(c.estimated.deposit).toBe(true);
    expect(c.estimated.keyMoney).toBe(true);
    expect(c.estimated.cleaningFee).toBe(true);
  });

  it("treats a stated zero as real (礼金ゼロ is a genuine saving)", () => {
    const c = computeMoveInCosts(listing({ keyMoneyYen: 0, depositYen: 0 }));
    expect(c.keyMoney).toBe(0);
    expect(c.estimated.keyMoney).toBe(false);
  });

  it("counts key money, fees and cleaning as fully sunk", () => {
    const c = computeMoveInCosts(
      listing({ depositYen: 0, keyMoneyYen: 100_000, cleaningFeeYen: 50_000 }),
    );
    // 礼金 100k + agency 110k + guarantor 50k + insurance 20k + cleaning 50k
    expect(c.sunkCost).toBe(330_000);
    expect(c.refundable).toBe(0);
  });

  it("treats the deposit as mostly refundable", () => {
    const c = computeMoveInCosts(
      listing({ depositYen: 200_000, keyMoneyYen: 0, cleaningFeeYen: 0 }),
    );
    // 30% of the deposit is lost to 原状回復, 70% comes back.
    expect(c.refundable).toBe(140_000);
    // Sunk = 60k lost deposit + agency 110k + guarantor 50k + insurance 20k.
    expect(c.sunkCost).toBe(240_000);
  });

  it("penalises key money far more than an equal deposit", () => {
    const withKeyMoney = computeMoveInCosts(
      listing({ depositYen: 0, keyMoneyYen: 200_000, cleaningFeeYen: 0 }),
    );
    const withDeposit = computeMoveInCosts(
      listing({ depositYen: 200_000, keyMoneyYen: 0, cleaningFeeYen: 0 }),
    );
    expect(withKeyMoney.totalUpfront).toBe(withDeposit.totalUpfront); // same cash
    expect(withKeyMoney.sunkCost).toBeGreaterThan(withDeposit.sunkCost); // not the same cost
    expect(withKeyMoney.sunkCost - withDeposit.sunkCost).toBe(140_000);
  });

  it("adds up the upfront total", () => {
    const c = computeMoveInCosts(
      listing({ depositYen: 100_000, keyMoneyYen: 100_000, cleaningFeeYen: 50_000 }),
    );
    // 100k + 100k + 110k agency + 50k guarantor + 20k insurance + 50k cleaning
    // + 100k first month
    expect(c.totalUpfront).toBe(530_000);
    expect(c.firstMonthRent).toBe(100_000);
  });

  it("excludes the first month's rent from sunk cost", () => {
    const c = computeMoveInCosts(listing({ depositYen: 0, keyMoneyYen: 0, cleaningFeeYen: 0 }));
    expect(c.sunkCost).not.toContain(c.firstMonthRent);
    expect(c.sunkCost).toBe(180_000); // agency + guarantor + insurance only
  });

  it("estimates cleaning from floor area with a floor value", () => {
    expect(computeMoveInCosts(listing({ sizeM2: 80 })).cleaningFee).toBe(96_000);
    expect(computeMoveInCosts(listing({ sizeM2: 10 })).cleaningFee).toBe(30_000); // minimum
    expect(computeMoveInCosts(listing({ sizeM2: null })).cleaningFee).toBe(30_000);
  });

  it("honours a fully refundable deposit assumption", () => {
    const c = computeMoveInCosts(listing({ depositYen: 200_000, keyMoneyYen: 0 }), {
      ...DEFAULT_MOVE_IN_ASSUMPTIONS,
      depositLossRate: 0,
    });
    expect(c.refundable).toBe(200_000);
  });
});

describe("sunkCostInMonths", () => {
  it("normalises by rent so cheap and expensive flats compare fairly", () => {
    const cheap = listing({ rent: 50_000, depositYen: 0, keyMoneyYen: 50_000 });
    const dear = listing({ rent: 150_000, depositYen: 0, keyMoneyYen: 150_000 });
    const a = sunkCostInMonths(computeMoveInCosts(cheap), cheap.rent);
    const b = sunkCostInMonths(computeMoveInCosts(dear), dear.rent);
    // Both are "1 month key money" deals, so both land in the same ballpark
    // rather than differing by the 3× factor of their raw yen amounts.
    expect(a).toBeGreaterThan(2);
    expect(b).toBeGreaterThan(2);
    expect(a / b).toBeLessThan(1.6);
  });

  it("shows flat fees biting harder on cheap flats", () => {
    // ¥20k insurance and the ¥30k minimum clean are fixed, so as a share of
    // rent they hurt a ¥50k flat far more than a ¥150k one — worth surfacing
    // rather than hiding, since it is a real cost of moving cheap.
    const cheap = listing({ rent: 50_000, sizeM2: 25, depositYen: 0, keyMoneyYen: 0 });
    const dear = listing({ rent: 150_000, sizeM2: 75, depositYen: 0, keyMoneyYen: 0 });
    const a = sunkCostInMonths(computeMoveInCosts(cheap), cheap.rent);
    const b = sunkCostInMonths(computeMoveInCosts(dear), dear.rent);
    expect(a).toBeGreaterThan(b);
  });

  it("returns 0 for a zero rent rather than dividing by zero", () => {
    const c = computeMoveInCosts(listing({ rent: 0 }));
    expect(sunkCostInMonths(c, 0)).toBe(0);
  });
});

describe("nested cost blocks from detail-page imports", () => {
  it("reads figures nested under costs when top-level fields are absent", () => {
    const c = computeMoveInCosts(
      listing({ depositYen: null, keyMoneyYen: null, costs: { depositYen: 85_000, keyMoneyYen: 85_000 } }),
    );
    expect(c.deposit).toBe(85_000);
    expect(c.keyMoney).toBe(85_000);
    expect(c.estimated.deposit).toBe(false);
    expect(c.estimated.keyMoney).toBe(false);
  });

  it("prefers the top-level figure when both are present", () => {
    const c = computeMoveInCosts(
      listing({ depositYen: 100_000, costs: { depositYen: 999_000 } }),
    );
    expect(c.deposit).toBe(100_000);
  });

  it("treats a nested zero as stated, not missing", () => {
    const c = computeMoveInCosts(listing({ costs: { keyMoneyYen: 0 } }));
    expect(c.keyMoney).toBe(0);
    expect(c.estimated.keyMoney).toBe(false);
  });
});

describe("parking costs", () => {
  const withParking = (p: Partial<import("./types").ParkingInfo> | null) =>
    listing({ costs: { parking: p as import("./types").ParkingInfo | null } });

  it("reads the monthly charge from structured parking data", () => {
    expect(parkingMonthlyYen(withParking({ monthlyYen: 7700, available: true }))).toBe(7700);
  });

  it("returns 0 when no space is available (nothing to pay)", () => {
    expect(parkingMonthlyYen(withParking({ monthlyYen: null, available: false }))).toBe(0);
  });

  it("treats free on-site parking as 0, not unknown", () => {
    expect(parkingMonthlyYen(withParking({ monthlyYen: 0, available: true }))).toBe(0);
  });

  it("returns null when the listing says nothing about parking", () => {
    expect(parkingMonthlyYen(listing())).toBeNull();
  });

  it("falls back to a flat parkingYen figure", () => {
    expect(parkingMonthlyYen(listing({ costs: { parkingYen: 9000 } }))).toBe(9000);
  });

  it("adds parking to rent only when asked", () => {
    const l = listing({ rent: 80_000, costs: { parking: { monthlyYen: 8_000, available: true, location: "onsite", distanceM: null, raw: "敷地内8000円" } } });
    expect(effectiveMonthlyCost(l, false)).toBe(80_000);
    expect(effectiveMonthlyCost(l, true)).toBe(88_000);
  });

  it("leaves rent untouched when parking is unknown", () => {
    expect(effectiveMonthlyCost(listing({ rent: 80_000 }), true)).toBe(80_000);
  });
});

describe("monthlyOutlay", () => {
  const parked = { monthlyYen: 8_000, available: true, location: "onsite" as const, distanceM: null, raw: "敷地内8000円" };

  it("adds recurring extras listed outside rent, and parking only when asked", () => {
    const l = listing({ rent: 80_000, costs: { parking: parked, monthlyExtrasYen: 1_100 } });
    expect(monthlyOutlay(l, false)).toBe(81_100);
    expect(monthlyOutlay(l, true)).toBe(89_100);
  });

  it("is plain rent when the ad lists nothing else", () => {
    expect(monthlyOutlay(listing({ rent: 80_000 }), true)).toBe(80_000);
  });
});

describe("stayCost", () => {
  it("adds two years of monthly payments to the sunk move-in money", () => {
    // Defaults on ¥100k rent, 50㎡: key money 100k + agency 110k + guarantor 50k
    // + insurance 20k + cleaning 60k + 30% of the 100k deposit = ¥370k sunk.
    const cost = stayCost(listing(), DEFAULT_MOVE_IN_ASSUMPTIONS, false);
    expect(cost).toEqual({ months: 24, monthly: 100_000, sunk: 370_000, total: 2_770_000, parkingUnknown: false });
  });

  it("follows the move-in assumptions and the stay length", () => {
    const cost = stayCost(listing({ depositYen: 0, keyMoneyYen: 0, cleaningFeeYen: 0 }),
      { ...DEFAULT_MOVE_IN_ASSUMPTIONS, agencyFeeMonths: 0.55 }, false, 12);
    expect(cost.sunk).toBe(55_000 + 50_000 + 20_000);
    expect(cost.total).toBe(cost.sunk + 12 * 100_000);
  });

  it("flags parking that should count but has no stated price", () => {
    expect(stayCost(listing(), DEFAULT_MOVE_IN_ASSUMPTIONS, true).parkingUnknown).toBe(true);
    expect(stayCost(listing(), DEFAULT_MOVE_IN_ASSUMPTIONS, false).parkingUnknown).toBe(false);
    expect(stayCost(listing({ costs: { parkingYen: 0 } }), DEFAULT_MOVE_IN_ASSUMPTIONS, true).parkingUnknown).toBe(false);
  });
});
