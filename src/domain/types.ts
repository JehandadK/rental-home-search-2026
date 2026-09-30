/**
 * Domain model for the Soka rental scoring tool.
 *
 * Data flows through three shapes:
 *   RawListing       — a property as scraped from a listing site
 *   EnrichedListing  — a RawListing plus coordinates and nearest-place distances
 *   ListingScore     — the 0–100 per-parameter scores and weighted total
 */

/** A geographic coordinate in WGS84 degrees. */
export interface GeoPoint {
  lat: number;
  lon: number;
}

/** A named location that listings can be measured against. */
export interface NamedPlace extends GeoPoint {
  name: string;
}

/**
 * Up-front and recurring costs beyond monthly rent, as printed by the
 * listing site. All amounts are yen. `null` means "the source did not say";
 * `0` means the source explicitly said none (なし / －).
 */
export interface ListingCosts {
  /** 敷金 — refundable deposit. */
  depositYen?: number | null;
  /** 礼金 — non-refundable key money. */
  keyMoneyYen?: number | null;
  /** 清掃費・定額クリーニング費 — non-refundable cleaning charge. */
  cleaningFeeYen?: number | null;
  /** 管理費・共益費 — monthly, already included in `rent`. */
  adminFeeYen?: number | null;
  /** 駐車場 — monthly parking, when the ad gives a price. */
  parkingYen?: number | null;
  /** Structured 駐車場 detail scraped from the listing's detail page. */
  parking?: ParkingInfo | null;
  /** 更新料 — renewal fee. */
  renewalFeeYen?: number | null;
  /** One-off charges at signing (クリーニング費、鍵交換代 …). */
  oneOffFeesYen?: number | null;
  /** Recurring monthly extras that sit outside rent (サポート費 …). */
  monthlyExtrasYen?: number | null;
  /** 保証会社 — whether a guarantor company is mandatory. */
  guarantorRequired?: boolean | null;
  /** Verbatim fee text, kept so nothing captured is ever lost. */
  feeNotes?: string | null;
}

/** Lease shape and availability, as printed by the listing site. */
export interface ListingTenancy {
  /** 普通借家 (regular) vs 定期借家 (fixed-term, no renewal right). */
  leaseType?: "regular" | "fixed-term" | null;
  /** Lease length in months, when stated. */
  leaseMonths?: number | null;
  /** 入居可能時期, verbatim ("即", "'26年10月上旬" …). */
  availableFrom?: string | null;
  /** True when the ad says 即入居可. */
  immediateMoveIn?: boolean | null;
}

/** Categories used to present qualitative listing information in English. */
export type ListingAttributeCategory =
  | "parking"
  | "comfort"
  | "kitchen"
  | "bathroom"
  | "security"
  | "connectivity"
  | "storage"
  | "building"
  | "tenancy"
  | "other";

/** A source feature normalized to a bilingual, scoreable attribute. */
export interface ListingAttribute {
  /** Stable English key used by scoring preferences. */
  key: string;
  category: ListingAttributeCategory;
  labelEn: string;
  labelJa: string;
  /** true/false when explicitly stated; null for descriptive/raw information. */
  state: boolean | null;
  /** Verbatim source text: no scraped qualitative information is discarded. */
  raw: string;
}

/** Physical attributes of the unit and building. */
export interface ListingBuilding {
  /** 階数 — the unit's floor, verbatim ("4階", "1-2階"). */
  floor?: string | null;
  /** 階建 — total storeys in the building. */
  totalFloors?: number | null;
  /** 建物構造 — 木造 / 鉄筋コンクリート …, verbatim. */
  structure?: string | null;
  /** 設備 — individual amenity tags. */
  features?: string[] | null;
  /** 条件等 — tenancy conditions (ペット相談、二人入居可 …). */
  conditions?: string[] | null;
}

/**
 * Lifecycle state of a listing across data refreshes:
 *   active — currently advertised on a source site
 *   sold   — no longer advertised (contracted / delisted); kept for reference
 */
export type ListingStatus = "active" | "sold";

/**
 * What a check of one portal ad found. `gone` needs positive evidence (the
 * portal's own "no longer available" page); absence from a crawl is not enough.
 */
export interface AdAvailability {
  state: "gone" | "listed";
  /** When the ad page was looked at (ISO). */
  checkedAt: string;
  /** Short human-readable reason, e.g. "HTTP 404 · お探しのページが見つかりません". */
  evidence: string;
  /** `probe` = the headed-browser checker; `manual` = marked by hand in the dashboard. */
  method: "probe" | "manual";
}

/** One portal advertisement retained when equivalent listings are merged. */
export interface SourceListingReference {
  source: string;
  id?: string | null;
  url: string | null;
  /** Latest availability check for this ad; absent when never checked. */
  availability?: AdAvailability;
}

/** A rental listing exactly as collected from a listing site. */
export interface RawListing {
  /** Stable identifier, when the source provides enough data to build one. */
  id?: string | null;
  name: string;
  address: string;
  /** Which city's search this listing came from, e.g. "Soka" or "Koshigaya". */
  city?: string;
  /** Monthly rent in yen, including management fee (管理費・共益費). */
  rent: number;
  /** Floor plan, e.g. "2LDK". */
  layout: string | null;
  sizeM2: number | null;
  builtYear: number | null;
  /**
   * Move-in money, in yen, as printed on the listing site.
   *
   * 敷金 (deposit) is security — refundable at move-out minus 原状回復
   * (restoration) deductions, so only part of it is truly spent.
   * 礼金 (key money) is a gift to the landlord and never comes back.
   */
  depositYen?: number | null;
  keyMoneyYen?: number | null;
  /**
   * Cleaning fee (清掃費 / 定額クリーニング費). Never refunded — either
   * charged upfront or deducted from the deposit on the way out. Listings
   * rarely print it, so it is usually estimated from the floor area.
   */
  cleaningFeeYen?: number | null;
  /** Structured 駐車場 detail, as written by the parking backfill. */
  parking?: ParkingInfo | null;
  /** The station the ad is keyed to (as printed on the listing site). */
  advertisedStation?: string | null;
  /** Agent-listed walking minutes to the advertised station (徒歩分), if given. */
  stationWalkMin: number | null;
  url: string | null;
  source: string;
  /** All portal ads for this room; populated when cross-listed records merge. */
  sourceListings?: SourceListingReference[];
  /**
   * Lifecycle across refreshes, assigned by `npm run data:build`:
   * listings absent from every source are kept and marked "sold" rather
   * than dropped. Absent/`undefined` means active (legacy data).
   */
  status?: ListingStatus | null;
  /** When the listing first appeared in any scrape (ISO). null = predates tracking. */
  firstSeenAt?: string | null;
  /** When the listing was last seen in a scrape (ISO). */
  lastSeenAt?: string | null;
  /** When the listing was first noticed gone (ISO). Cleared if it reappears. */
  soldAt?: string | null;
  /** Free-form source details (age text, floor, fee notes…). */
  notes?: string | null;
  /** Public detail-table capture, retained for offline parser replay/audit. */
  sourceDetails?: Record<string, string>;
  /** Structured costs beyond rent. Absent when the source does not publish them. */
  costs?: ListingCosts;
  /** Structured lease terms. */
  tenancy?: ListingTenancy;
  /** Structured building/unit attributes. */
  building?: ListingBuilding;
  /** The listing agency (仲介業者), when the source names one. */
  agency?: string | null;
  /**
   * Bilingual normalized attributes derived from every captured feature,
   * condition, lease, parking and availability field. Unknown raw features
   * remain in category `other`, so normalization never loses source data.
   */
  attributes?: ListingAttribute[];
}

/** Distance from a listing to one reference place. */
export interface Proximity {
  name: string;
  /** Straight-line distance in metres. */
  distM: number;
  /** Estimated walking minutes: distM × detour factor ÷ walk speed. */
  walkMin: number;
}

/** A listing enriched with coordinates and nearest-place proximities. */
export interface EnrichedListing extends RawListing {
  geocoded: boolean;
  lat?: number;
  lon?: number;
  /** The address string the geocoder actually matched (for spot-checking). */
  geocodeMatched?: string;
  poi1?: Proximity;
  poi2?: Proximity;
  station?: Proximity;
  busStop?: Proximity;
  school?: Proximity;
  /** Nearest 幼稚園/認定こども園 (daycare excluded). */
  kindergarten?: Proximity;
  /** Nearest childcare facility of any type, including 保育園. */
  childcareAny?: Proximity;
}

/**
 * Parking (駐車場) as advertised. In Saitama a space is usually a separate
 * monthly charge on top of rent — often ¥6,000–11,000 — and sometimes only
 * available in a nearby lot rather than on site.
 */
export interface ParkingInfo {
  /** Monthly cost in yen; 0 when free, null when unknown. */
  monthlyYen: number | null;
  available: boolean;
  location: "onsite" | "nearby" | null;
  /** Walking distance in metres for an off-site lot. */
  distanceM: number | null;
  /** Raw cell text, kept for auditing. */
  raw: string;
}

/** Move-in cost breakdown, all in yen. */
export interface MoveInCosts {
  deposit: number;
  keyMoney: number;
  agencyFee: number;
  guarantorFee: number;
  fireInsurance: number;
  cleaningFee: number;
  firstMonthRent: number;
  /** Everything you must hand over before you get the keys. */
  totalUpfront: number;
  /** The part you never get back (key money, fees, cleaning, restoration). */
  sunkCost: number;
  /** The part expected back at move-out (deposit minus restoration). */
  refundable: number;
  /** Whether each figure came from the listing or from an assumption. */
  estimated: { deposit: boolean; keyMoney: boolean; cleaningFee: boolean };
}

/** The scored parameters, keyed for config and display. */
export type ScoreParameterKey =
  | "rent"
  | "rentPerM2"
  | "moveInCost"
  | "size"
  | "yearBuilt"
  | "poi1"
  | "poi2"
  | "station"
  | "busStop"
  | "kindergarten"
  | "school";

export type ListingFeatureKey =
  | "parkingAvailable"
  | "parkingFree"
  | "petAllowed"
  | "bathToiletSeparate"
  | "indoorWasher"
  | "airConditioning"
  | "internetFree"
  | "cityGas"
  | "washlet"
  | "separateVanity"
  | "bathReheating"
  | "bathroomDryer"
  | "autoLock"
  | "videoIntercom"
  | "securityCamera"
  | "deliveryBox"
  | "flooring"
  | "walkInCloset"
  | "systemKitchen"
  | "twoPlusBurners"
  | "bicycleParking"
  | "motorbikeParking"
  | "immediateMoveIn"
  | "guarantorNotRequired"
  | "coupleAllowed"
  | "officeAllowed"
  | "southFacing"
  | "cornerUnit"
  | "secondFloorOrAbove"
  | "elevator"
  | "fixedTermLease";

export type ScoringCriterionKey = ScoreParameterKey | ListingFeatureKey;
export type ParameterWeights = Record<ScoreParameterKey, number>;
export type FeatureWeights = Record<ListingFeatureKey, number>;
export type FeaturePreferences = Record<ListingFeatureKey, "prefer" | "avoid">;
