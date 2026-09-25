/**
 * Scoring configuration: the user's judgement criteria expressed as data.
 *
 * Every parameter is normalised to 0–100, then combined as a weighted
 * average. Defaults follow the agreed requirements table:
 *
 *   Parameter        Weight  Logic
 *   rent             7       lower is better; penalised above ¥50,000
 *   size             5       larger is better
 *   yearBuilt        3       newer is better
 *   poi1 / poi2      8 each  closer is better; ~12 min walk = zero score
 *   station          9       heaviest weight; closer is better
 *   busStop          4       moderate weight
 *   kindergarten     6       closer is better
 *   school           6       closer is better
 */
import {
  DEFAULT_MOVE_IN_ASSUMPTIONS,
  type MoveInAssumptions,
} from "../domain/moveInCost";
import type {
  FeaturePreferences,
  FeatureWeights,
  ListingAttributeCategory,
  ListingFeatureKey,
  ParameterWeights,
  ScoreParameterKey,
  ScoringCriterionKey,
} from "../types";

/**
 * How the household actually covers the distance to a place. Soka/Koshigaya
 * families routinely use a bicycle (ママチャリ) for school and mosque runs,
 * which changes which homes are realistically "close" by a large factor.
 */
export type TravelMode = "walk" | "bicycle";

export interface ScoringConfig {
  weights: ParameterWeights;
  /** Optional qualitative criteria; weight 0 means the user chose not to score it. */
  featureWeights: FeatureWeights;
  /** Prefer presence, or prefer absence (useful for fixed-term lease, etc.). */
  featurePreferences: FeaturePreferences;

  /** Travel mode used to turn distances into minutes. */
  travelMode: TravelMode;

  /** Rent at or below this (¥/month) scores 100. */
  rentFullScoreBelow: number;
  /** Rent at or above this (¥/month) scores 0. */
  rentZeroScoreAbove: number;

  /** Rent per exclusive-use floor area at or below this (¥/㎡/month) scores 100. */
  rentPerM2FullScoreBelow: number;
  /** Rent per exclusive-use floor area at or above this scores 0. */
  rentPerM2ZeroScoreAbove: number;

  /**
   * Move-in cost is scored on **sunk** cost (money never returned) measured
   * in months of rent, so cheap and expensive flats compare fairly.
   */
  moveInFullScoreBelowMonths: number;
  moveInZeroScoreAboveMonths: number;

  /** What the move-in estimate assumes when a listing omits a figure. */
  moveIn: MoveInAssumptions;

  /** Floor area at or above this (㎡) scores 100. */
  sizeFullScoreAbove: number;
  /** Floor area at or below this (㎡) scores 0. */
  sizeZeroScoreBelow: number;

  /** A building this old (years) scores 0; brand-new scores 100. */
  buildingAgeZeroAt: number;

  /** Walking minutes at which each proximity parameter scores 0. */
  walkZeroMinutes: {
    poi1: number;
    poi2: number;
    station: number;
    busStop: number;
    kindergarten: number;
    school: number;
  };

  /** When true, 保育園 (daycares) count towards the kindergarten score. */
  includeHoikuen: boolean;

  /**
   * When true, the monthly parking charge is added to rent before scoring —
   * the honest comparison if the household keeps a car, since 駐車場 is billed
   * separately from rent in Saitama.
   */
  includeParking: boolean;

  /** Travel-time estimation knobs (see domain/geo.ts). */
  walkSpeedMPerMin: number;
  /** Cycling speed; ~15 km/h door-to-door including stops. */
  bicycleSpeedMPerMin: number;
  detourFactor: number;
}

/** The speed implied by the configured travel mode. */
export function travelSpeed(config: ScoringConfig): number {
  return config.travelMode === "bicycle" ? config.bicycleSpeedMPerMin : config.walkSpeedMPerMin;
}

export const DEFAULT_FEATURE_WEIGHTS: FeatureWeights = {
  parkingAvailable: 0, parkingFree: 0, petAllowed: 0, bathToiletSeparate: 0,
  indoorWasher: 0, airConditioning: 0, internetFree: 0, cityGas: 0, washlet: 0,
  separateVanity: 0, bathReheating: 0, bathroomDryer: 0, autoLock: 0,
  videoIntercom: 0, securityCamera: 0, deliveryBox: 0, flooring: 0,
  walkInCloset: 0, systemKitchen: 0, twoPlusBurners: 0, bicycleParking: 0,
  motorbikeParking: 0, immediateMoveIn: 0, guarantorNotRequired: 0,
  coupleAllowed: 0, officeAllowed: 0, southFacing: 0, cornerUnit: 0,
  secondFloorOrAbove: 0, elevator: 0, fixedTermLease: 0,
};

export const DEFAULT_FEATURE_PREFERENCES = Object.fromEntries(
  (Object.keys(DEFAULT_FEATURE_WEIGHTS) as ListingFeatureKey[]).map((key) => [
    key,
    key === "fixedTermLease" ? "avoid" : "prefer",
  ]),
) as FeaturePreferences;

export const DEFAULT_CONFIG: ScoringConfig = {
  weights: {
    rent: 7,
    // High by default: highlights spacious homes that are inexpensive for
    // their exclusive-use area, rather than merely cheap small apartments.
    rentPerM2: 10,
    moveInCost: 4,
    size: 5,
    yearBuilt: 3,
    poi1: 8,
    poi2: 8,
    station: 9,
    busStop: 4,
    kindergarten: 6,
    school: 6,
  },
  featureWeights: DEFAULT_FEATURE_WEIGHTS,
  featurePreferences: DEFAULT_FEATURE_PREFERENCES,
  rentFullScoreBelow: 50_000,
  rentZeroScoreAbove: 200_000,
  // Current-market p5≈¥1,200 and p90≈¥2,750 per exclusive m² per month.
  rentPerM2FullScoreBelow: 1_200,
  rentPerM2ZeroScoreAbove: 2_800,
  // ~2 months of rent sunk is a good deal (礼金ゼロ); ~6 months is punishing.
  moveInFullScoreBelowMonths: 2,
  moveInZeroScoreAboveMonths: 6,
  moveIn: DEFAULT_MOVE_IN_ASSUMPTIONS,
  sizeFullScoreAbove: 70,
  sizeZeroScoreBelow: 18,
  buildingAgeZeroAt: 45,
  walkZeroMinutes: {
    poi1: 12,
    poi2: 12,
    station: 20,
    busStop: 10,
    kindergarten: 15,
    school: 15,
  },
  includeHoikuen: false,
  includeParking: false,
  travelMode: "walk",
  walkSpeedMPerMin: 80,
  bicycleSpeedMPerMin: 250,
  detourFactor: 1.3,
};

/** Human-readable metadata per parameter; drives the weights panel and table. */
export interface ParameterMeta<K extends ScoringCriterionKey = ScoringCriterionKey> {
  key: K;
  label: string;
  unit: string;
  description: string;
}

export interface FeatureMeta extends ParameterMeta<ListingFeatureKey> {
  key: ListingFeatureKey;
  category: ListingAttributeCategory;
  labelJa: string;
}

export const FEATURE_PARAMETERS: readonly FeatureMeta[] = [
  { key: "parkingAvailable", category: "parking", label: "Parking available", labelJa: "駐車場あり", unit: "yes/no", description: "A car parking space is available" },
  { key: "parkingFree", category: "parking", label: "Free parking", labelJa: "駐車場無料", unit: "yes/no", description: "Parking has no monthly charge" },
  { key: "bicycleParking", category: "parking", label: "Bicycle parking", labelJa: "駐輪場", unit: "yes/no", description: "Bicycle parking is available" },
  { key: "motorbikeParking", category: "parking", label: "Motorbike parking", labelJa: "バイク置き場", unit: "yes/no", description: "Motorbike parking is available" },
  { key: "bathToiletSeparate", category: "bathroom", label: "Separate bath/toilet", labelJa: "バス・トイレ別", unit: "yes/no", description: "Bathroom and toilet are separate" },
  { key: "washlet", category: "bathroom", label: "Heated bidet toilet", labelJa: "温水洗浄便座", unit: "yes/no", description: "Washlet / heated bidet seat" },
  { key: "separateVanity", category: "bathroom", label: "Separate vanity", labelJa: "洗面所独立", unit: "yes/no", description: "Independent washroom or vanity" },
  { key: "bathReheating", category: "bathroom", label: "Bath reheating", labelJa: "追い焚き", unit: "yes/no", description: "Bath water reheating function" },
  { key: "bathroomDryer", category: "bathroom", label: "Bathroom dryer", labelJa: "浴室乾燥機", unit: "yes/no", description: "Bathroom ventilation/drying system" },
  { key: "indoorWasher", category: "comfort", label: "Indoor washer space", labelJa: "室内洗濯機置場", unit: "yes/no", description: "Washing machine can be installed indoors" },
  { key: "airConditioning", category: "comfort", label: "Air conditioning", labelJa: "エアコン", unit: "yes/no", description: "Air conditioner installed" },
  { key: "flooring", category: "comfort", label: "Flooring", labelJa: "フローリング", unit: "yes/no", description: "Hard flooring" },
  { key: "cityGas", category: "kitchen", label: "City gas", labelJa: "都市ガス", unit: "yes/no", description: "Cheaper piped city gas rather than propane" },
  { key: "systemKitchen", category: "kitchen", label: "System kitchen", labelJa: "システムキッチン", unit: "yes/no", description: "Integrated system kitchen" },
  { key: "twoPlusBurners", category: "kitchen", label: "2+ stove burners", labelJa: "コンロ2口以上", unit: "yes/no", description: "Two or more cooking burners" },
  { key: "internetFree", category: "connectivity", label: "Free internet", labelJa: "インターネット無料", unit: "yes/no", description: "Internet service included without a monthly charge" },
  { key: "autoLock", category: "security", label: "Auto-lock entrance", labelJa: "オートロック", unit: "yes/no", description: "Controlled auto-lock building entrance" },
  { key: "videoIntercom", category: "security", label: "Video intercom", labelJa: "TVモニタ付インターホン", unit: "yes/no", description: "Video door-entry intercom" },
  { key: "securityCamera", category: "security", label: "Security cameras", labelJa: "防犯カメラ", unit: "yes/no", description: "Building security cameras" },
  { key: "walkInCloset", category: "storage", label: "Walk-in closet", labelJa: "ウォークインクローゼット", unit: "yes/no", description: "Walk-in wardrobe/storage" },
  { key: "deliveryBox", category: "building", label: "Parcel box", labelJa: "宅配ボックス", unit: "yes/no", description: "Unattended parcel delivery locker" },
  { key: "southFacing", category: "building", label: "South-facing", labelJa: "南向き", unit: "yes/no", description: "South-facing unit or balcony" },
  { key: "cornerUnit", category: "building", label: "Corner unit", labelJa: "角部屋", unit: "yes/no", description: "Corner apartment" },
  { key: "secondFloorOrAbove", category: "building", label: "2nd floor or above", labelJa: "2階以上", unit: "yes/no", description: "Unit is above ground floor" },
  { key: "elevator", category: "building", label: "Elevator", labelJa: "エレベーター", unit: "yes/no", description: "Elevator in the building" },
  { key: "petAllowed", category: "tenancy", label: "Pets allowed", labelJa: "ペット可・相談", unit: "yes/no", description: "Pets allowed or negotiable" },
  { key: "immediateMoveIn", category: "tenancy", label: "Immediate move-in", labelJa: "即入居可", unit: "yes/no", description: "Available for immediate occupancy" },
  { key: "guarantorNotRequired", category: "tenancy", label: "No guarantor needed", labelJa: "保証人不要", unit: "yes/no", description: "No personal guarantor required" },
  { key: "coupleAllowed", category: "tenancy", label: "Two-person occupancy", labelJa: "二人入居可", unit: "yes/no", description: "Two-person occupancy permitted" },
  { key: "officeAllowed", category: "tenancy", label: "Office/SOHO allowed", labelJa: "事務所可", unit: "yes/no", description: "Office or SOHO use permitted" },
  { key: "fixedTermLease", category: "tenancy", label: "Fixed-term lease", labelJa: "定期借家", unit: "yes/no", description: "Fixed-term lease without automatic renewal" },
];

export const SCORE_PARAMETERS: readonly ParameterMeta<ScoreParameterKey>[] = [
  {
    key: "rent",
    label: "Rent",
    unit: "¥/mo",
    description: "Lower is better; optionally includes monthly parking",
  },
  {
    key: "rentPerM2",
    label: "Value · Rent/㎡",
    unit: "¥/㎡/mo",
    description: "Monthly rent including management fee divided by exclusive-use floor area; lower is better",
  },
  {
    key: "moveInCost",
    label: "Move-in",
    unit: "mo",
    description:
      "Sunk move-in cost in months of rent — 礼金, fees and cleaning never come " +
      "back, and part of the 敷金 is lost to 原状回復",
  },
  { key: "size", label: "Size", unit: "㎡", description: "Larger is better" },
  { key: "yearBuilt", label: "Age", unit: "yrs", description: "Newer is better" },
  { key: "poi1", label: "POI · Al Sanad", unit: "min", description: "Al Sanad School walk time" },
  { key: "poi2", label: "Nearest mosque", unit: "min", description: "Travel time to the nearest selected mosque, masjid or musalla" },
  { key: "station", label: "Station", unit: "min", description: "Nearest station walk time" },
  { key: "busStop", label: "Bus stop", unit: "min", description: "Nearest bus stop walk time" },
  { key: "kindergarten", label: "Kindergarten", unit: "min", description: "Nearest kindergarten walk time" },
  { key: "school", label: "Elem. school", unit: "min", description: "Nearest shogakko walk time" },
];
