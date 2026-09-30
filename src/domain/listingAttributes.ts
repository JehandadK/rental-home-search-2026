/**
 * Normalize Japanese portal-specific feature strings into bilingual,
 * scoreable attributes while preserving every original value.
 */
import type {
  EnrichedListing,
  ListingAttribute,
  ListingAttributeCategory,
  ListingFeatureKey,
  RawListing,
} from "./types";

interface Definition {
  key: ListingFeatureKey;
  category: ListingAttributeCategory;
  labelEn: string;
  labelJa: string;
  yes: RegExp;
  no?: RegExp;
}

export const FEATURE_DEFINITIONS: readonly Definition[] = [
  { key: "parkingAvailable", category: "parking", labelEn: "Parking available", labelJa: "駐車場あり", yes: /駐車場(?:あり|有|（近隣含む）)|敷地内|近隣\d*m/, no: /駐車場.*(?:なし|無|空無)/ },
  { key: "parkingFree", category: "parking", labelEn: "Free parking", labelJa: "駐車場無料", yes: /駐車場.*無料|敷地内無料/ },
  { key: "petAllowed", category: "tenancy", labelEn: "Pets allowed / negotiable", labelJa: "ペット可・相談", yes: /ペット(?:可|相談)/, no: /ペット不可/ },
  { key: "bathToiletSeparate", category: "bathroom", labelEn: "Separate bath and toilet", labelJa: "バス・トイレ別", yes: /バス.?トイレ別/ },
  { key: "indoorWasher", category: "comfort", labelEn: "Indoor washing-machine space", labelJa: "室内洗濯機置場", yes: /室内洗濯(?:機)?(?:置|物干)/ },
  { key: "airConditioning", category: "comfort", labelEn: "Air conditioning", labelJa: "エアコン", yes: /エアコン/ },
  { key: "internetFree", category: "connectivity", labelEn: "Free internet", labelJa: "インターネット無料", yes: /インターネット(?:使用料)?無料/ },
  { key: "cityGas", category: "kitchen", labelEn: "City gas", labelJa: "都市ガス", yes: /都市ガス/, no: /プロパンガス/ },
  { key: "washlet", category: "bathroom", labelEn: "Heated bidet toilet", labelJa: "温水洗浄便座", yes: /温水洗浄便座/ },
  { key: "separateVanity", category: "bathroom", labelEn: "Separate vanity / washroom", labelJa: "洗面所独立", yes: /洗面所独立|シャワー付洗面(?:台|化粧台)/ },
  { key: "bathReheating", category: "bathroom", labelEn: "Bath reheating", labelJa: "追い焚き", yes: /追焚/ },
  { key: "bathroomDryer", category: "bathroom", labelEn: "Bathroom dryer", labelJa: "浴室乾燥機", yes: /浴室乾燥/ },
  { key: "autoLock", category: "security", labelEn: "Auto-lock entrance", labelJa: "オートロック", yes: /オートロック/ },
  { key: "videoIntercom", category: "security", labelEn: "Video intercom", labelJa: "TVモニタ付インターホン", yes: /TV(?:モニタ付)?インターホン/ },
  { key: "securityCamera", category: "security", labelEn: "Security cameras", labelJa: "防犯カメラ", yes: /防犯カメラ/ },
  { key: "deliveryBox", category: "building", labelEn: "Parcel delivery box", labelJa: "宅配ボックス", yes: /宅配ボックス/ },
  { key: "flooring", category: "comfort", labelEn: "Flooring", labelJa: "フローリング", yes: /フローリング/ },
  { key: "walkInCloset", category: "storage", labelEn: "Walk-in closet", labelJa: "ウォークインクローゼット", yes: /ウォークインクローゼット/ },
  { key: "systemKitchen", category: "kitchen", labelEn: "System kitchen", labelJa: "システムキッチン", yes: /システムキッチン/ },
  { key: "twoPlusBurners", category: "kitchen", labelEn: "Two or more stove burners", labelJa: "コンロ2口以上", yes: /コンロ(?:二口|三口|2口|3口)|3口以上/ },
  { key: "bicycleParking", category: "parking", labelEn: "Bicycle parking", labelJa: "駐輪場", yes: /駐輪場/ },
  { key: "motorbikeParking", category: "parking", labelEn: "Motorbike parking", labelJa: "バイク置き場", yes: /バイク置き場/ },
  { key: "immediateMoveIn", category: "tenancy", labelEn: "Immediate move-in", labelJa: "即入居可", yes: /即入居可|即時|^即$/ },
  { key: "guarantorNotRequired", category: "tenancy", labelEn: "No personal guarantor required", labelJa: "保証人不要", yes: /保証人不要/, no: /保証人要/ },
  { key: "coupleAllowed", category: "tenancy", labelEn: "Two-person occupancy allowed", labelJa: "二人入居可", yes: /二人入居可/, no: /二人入居不可/ },
  { key: "officeAllowed", category: "tenancy", labelEn: "Office / SOHO use allowed", labelJa: "事務所可", yes: /事務所可|SOHO向け/, no: /事務所不可/ },
  { key: "southFacing", category: "building", labelEn: "South-facing", labelJa: "南向き", yes: /南向き|南面バルコニー/ },
  { key: "cornerUnit", category: "building", labelEn: "Corner unit", labelJa: "角部屋", yes: /角部屋/ },
  { key: "secondFloorOrAbove", category: "building", labelEn: "Second floor or above", labelJa: "2階以上", yes: /2階以上/ },
  { key: "elevator", category: "building", labelEn: "Elevator", labelJa: "エレベーター", yes: /エレベーター/ },
  { key: "fixedTermLease", category: "tenancy", labelEn: "Fixed-term lease", labelJa: "定期借家", yes: /定期借家/ },
];

export const ATTRIBUTE_CATEGORY_LABELS: Record<ListingAttributeCategory, { en: string; ja: string }> = {
  parking: { en: "Parking & transport", ja: "駐車・駐輪" },
  comfort: { en: "Comfort", ja: "快適設備" },
  kitchen: { en: "Kitchen & utilities", ja: "キッチン・光熱" },
  bathroom: { en: "Bathroom", ja: "浴室・洗面" },
  security: { en: "Security", ja: "防犯" },
  connectivity: { en: "Connectivity", ja: "通信" },
  storage: { en: "Storage", ja: "収納" },
  building: { en: "Building & unit", ja: "建物・住戸" },
  tenancy: { en: "Lease & eligibility", ja: "契約・入居条件" },
  other: { en: "Other source details", ja: "その他" },
};

const clean = (value: string): string => value.replace(/\s*質問\s*この物件の詳しい情報を送ってもらう.*$/s, "").trim();

/** Create bilingual attributes and retain unmapped source strings as Other. */
export function normalizeListingAttributes(listing: RawListing): ListingAttribute[] {
  const rawValues = [
    ...(listing.building?.features ?? []),
    ...(listing.building?.conditions ?? []),
    listing.tenancy?.immediateMoveIn ? "即入居可" : null,
    listing.tenancy?.leaseType === "fixed-term" ? "定期借家" : null,
    listing.costs?.guarantorRequired === false ? "保証人不要" : null,
    listing.parking?.raw ?? listing.costs?.parking?.raw ?? null,
  ].filter((value): value is string => Boolean(value)).map(clean).filter(Boolean);

  const attributes = new Map<string, ListingAttribute>();
  for (const raw of [...new Set(rawValues)]) {
    let matched = false;
    for (const definition of FEATURE_DEFINITIONS) {
      const state = definition.no?.test(raw) ? false : definition.yes.test(raw) ? true : null;
      if (state == null) continue;
      matched = true;
      // Explicit negative beats an earlier positive portal phrase.
      const previous = attributes.get(definition.key);
      if (!previous || state === false) {
        attributes.set(definition.key, {
          key: definition.key,
          category: definition.category,
          labelEn: definition.labelEn,
          labelJa: definition.labelJa,
          state,
          raw,
        });
      }
    }
    if (!matched) {
      const key = `raw:${raw.normalize("NFKC").replace(/\s+/g, "").toLowerCase()}`;
      attributes.set(key, { key, category: "other", labelEn: "Source detail", labelJa: raw, state: null, raw });
    }
  }
  return [...attributes.values()];
}

export function featureState(listing: Pick<EnrichedListing, "attributes">, key: ListingFeatureKey): boolean | null {
  return listing.attributes?.find((attribute) => attribute.key === key)?.state ?? null;
}
