/**
 * Japanese move-in costs (初期費用) and, more importantly, how much of that
 * money you never see again.
 *
 * What comes back, and what does not:
 *
 *   敷金 shikikin (deposit)   — security. Refunded at move-out MINUS 原状回復
 *                               (restoration) deductions. Normal wear usually
 *                               returns 60–80%; the rest is effectively spent.
 *   礼金 reikin (key money)   — a gift to the landlord. Never returned.
 *   清掃費 cleaning fee       — never returned. Either charged upfront as a
 *                               定額クリーニング費 or taken out of the deposit.
 *   仲介手数料 agency fee     — never returned (≈1 month + tax).
 *   保証会社 guarantor fee    — never returned (≈50–100% of a month).
 *   火災保険 fire insurance   — never returned (≈¥15–20k per 2 years).
 *
 * Scoring therefore penalises **sunk cost**, not headline cash: a ¥200k
 * deposit that mostly comes back is far cheaper than ¥100k of key money.
 */
import type { EnrichedListing, MoveInCosts, ParkingInfo } from "./types";

export interface MoveInAssumptions {
  /** Deposit when the listing does not state one, in months of rent. */
  defaultDepositMonths: number;
  /** Key money when the listing does not state one, in months of rent. */
  defaultKeyMoneyMonths: number;
  /** Agency commission, in months of rent (1 month + 10% tax ≈ 1.1). */
  agencyFeeMonths: number;
  /** Guarantor company's initial fee, in months of rent. */
  guarantorFeeMonths: number;
  /** Fire insurance premium for the contract term, in yen. */
  fireInsuranceYen: number;
  /**
   * Cleaning fee when not stated, in yen per ㎡ (定額クリーニング費 is
   * commonly ¥1,000–1,500/㎡ for a family flat).
   */
  cleaningFeePerM2: number;
  /** Minimum cleaning fee in yen, for very small units. */
  cleaningFeeMinimum: number;
  /**
   * Share of the deposit typically lost to 原状回復 at move-out (0–1).
   * 0.3 means you expect ~70% of the deposit back.
   */
  depositLossRate: number;
  /** Include the first month's rent in the upfront total. */
  includeFirstMonthRent: boolean;
}

export const DEFAULT_MOVE_IN_ASSUMPTIONS: MoveInAssumptions = {
  defaultDepositMonths: 1,
  defaultKeyMoneyMonths: 1,
  agencyFeeMonths: 1.1,
  guarantorFeeMonths: 0.5,
  fireInsuranceYen: 20_000,
  cleaningFeePerM2: 1_200,
  cleaningFeeMinimum: 30_000,
  depositLossRate: 0.3,
  includeFirstMonthRent: true,
};

const round = (n: number) => Math.round(n);

/**
 * Work out the full move-in picture for a listing.
 *
 * Figures printed on the listing are used as-is; anything missing falls back
 * to the assumptions above and is flagged as estimated so the UI can say so.
 */
export function computeMoveInCosts(
  listing: EnrichedListing,
  assumptions: MoveInAssumptions = DEFAULT_MOVE_IN_ASSUMPTIONS,
): MoveInCosts {
  const rent = listing.rent;

  // Sources differ in shape: the SUUMO scraper writes the figures at the top
  // level, while richer detail-page imports nest them under `costs`. Prefer
  // whichever actually states a value so real data always beats an estimate.
  const statedDeposit = firstStated(listing.depositYen, listing.costs?.depositYen);
  const statedKeyMoney = firstStated(listing.keyMoneyYen, listing.costs?.keyMoneyYen);
  const statedCleaning = firstStated(listing.cleaningFeeYen, listing.costs?.cleaningFeeYen);

  const depositStated = statedDeposit != null;
  const keyMoneyStated = statedKeyMoney != null;
  const cleaningStated = statedCleaning != null;

  const deposit = depositStated
    ? statedDeposit
    : round(rent * assumptions.defaultDepositMonths);
  const keyMoney = keyMoneyStated
    ? statedKeyMoney
    : round(rent * assumptions.defaultKeyMoneyMonths);
  const cleaningFee = cleaningStated
    ? statedCleaning
    : estimateCleaningFee(listing.sizeM2, assumptions);

  const agencyFee = round(rent * assumptions.agencyFeeMonths);
  const guarantorFee = round(rent * assumptions.guarantorFeeMonths);
  const fireInsurance = assumptions.fireInsuranceYen;
  const firstMonthRent = assumptions.includeFirstMonthRent ? rent : 0;

  const totalUpfront =
    deposit + keyMoney + agencyFee + guarantorFee + fireInsurance + cleaningFee + firstMonthRent;

  // The deposit is the only refundable component, and only partly so:
  // restoration costs are deducted from it on the way out.
  const depositLost = round(deposit * assumptions.depositLossRate);
  const refundable = deposit - depositLost;

  // Money that never comes back. First month's rent buys you a month of
  // housing, so it is excluded — it is not a premium for taking the place.
  const sunkCost =
    keyMoney + agencyFee + guarantorFee + fireInsurance + cleaningFee + depositLost;

  return {
    deposit,
    keyMoney,
    agencyFee,
    guarantorFee,
    fireInsurance,
    cleaningFee,
    firstMonthRent,
    totalUpfront,
    sunkCost,
    refundable,
    estimated: {
      deposit: !depositStated,
      keyMoney: !keyMoneyStated,
      cleaningFee: !cleaningStated,
    },
  };
}

/** First value that the source actually stated (0 is a real value, null is not). */
function firstStated(...values: (number | null | undefined)[]): number | null {
  for (const v of values) if (v != null) return v;
  return null;
}

/** 定額クリーニング費 scales with floor area; fall back to the minimum. */
function estimateCleaningFee(sizeM2: number | null, assumptions: MoveInAssumptions): number {
  if (sizeM2 == null) return assumptions.cleaningFeeMinimum;
  return Math.max(assumptions.cleaningFeeMinimum, round(sizeM2 * assumptions.cleaningFeePerM2));
}

/**
 * Sunk cost expressed in months of rent — the fairest way to compare a
 * ¥60k flat against a ¥150k one, and what the scorer normalises.
 */
export function sunkCostInMonths(costs: MoveInCosts, rent: number): number {
  return rent > 0 ? costs.sunkCost / rent : 0;
}

/**
 * Monthly parking charge, in yen.
 *
 * In Saitama a car space is almost always billed separately from rent, so a
 * ¥80,000 flat with ¥8,000 parking really costs ¥88,000 a month if you own a
 * car. Returns 0 when parking is free or not needed, and null when the
 * listing simply does not say.
 */
export function parkingMonthlyYen(listing: EnrichedListing): number | null {
  const structured = parkingInfo(listing);
  if (structured) {
    if (!structured.available) return 0; // no space to pay for
    return structured.monthlyYen;
  }
  return listing.costs?.parkingYen ?? null;
}

/**
 * The structured parking record, wherever the pipeline put it. The backfill
 * writes it at the top level; richer detail imports nest it under `costs`.
 */
export function parkingInfo(listing: EnrichedListing): ParkingInfo | null {
  return listing.parking ?? listing.costs?.parking ?? null;
}

/**
 * Rent plus parking — the true monthly outlay for a car-owning household.
 * Falls back to plain rent when the listing gives no parking information.
 */
export function effectiveMonthlyCost(
  listing: EnrichedListing,
  includeParking: boolean,
): number {
  if (!includeParking) return listing.rent;
  return listing.rent + (parkingMonthlyYen(listing) ?? 0);
}

/**
 * Money that leaves the account every month: rent (already including
 * 管理費・共益費), recurring extras the ad lists outside rent (サポート費 …),
 * and parking when the household keeps a car.
 */
export function monthlyOutlay(listing: EnrichedListing, includeParking: boolean): number {
  return effectiveMonthlyCost(listing, includeParking) + (listing.costs?.monthlyExtrasYen ?? 0);
}

/** A standard Japanese lease runs two years before 更新. */
export const STAY_MONTHS = 24;

/** What a stay of `months` really costs, as one comparable number. */
export interface StayCost {
  months: number;
  /** Monthly outlay (see `monthlyOutlay`). */
  monthly: number;
  /** Move-in money that never comes back (see `computeMoveInCosts`). */
  sunk: number;
  /** sunk + monthly × months. */
  total: number;
  /** Parking was meant to count but the listing does not say what it costs. */
  parkingUnknown: boolean;
}

/**
 * Total cost of living somewhere for `months`: the sunk move-in money plus
 * every monthly payment. The refundable part of the deposit is excluded, and
 * so is 更新料 — it falls due when a two-year lease is renewed, not within it.
 */
export function stayCost(
  listing: EnrichedListing,
  assumptions: MoveInAssumptions,
  includeParking: boolean,
  months: number = STAY_MONTHS,
): StayCost {
  const monthly = monthlyOutlay(listing, includeParking);
  const sunk = computeMoveInCosts(listing, assumptions).sunkCost;
  return {
    months,
    monthly,
    sunk,
    total: sunk + monthly * months,
    parkingUnknown: includeParking && parkingMonthlyYen(listing) == null,
  };
}
