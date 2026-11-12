import type {
  ListingBuilding,
  ListingCosts,
  ListingPhoto,
  ParkingInfo,
  RawListing,
  SourceListingReference,
} from "./types";
import { UR_SOURCE } from "./ur";

/**
 * Portal preference for the merged record's presentation and link ordering:
 * UR's own ad first (the landlord's terms beat a portal's copy of them), then
 * athome, suumo and nifty. Every portal ad is still retained in
 * `sourceListings` — this only decides which one leads.
 */
const SOURCE_PRIORITY = [UR_SOURCE, "athome", "suumo", "nifty", "roomspot"];

const norm = (value: string | null | undefined): string =>
  (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・･,，.。()（）「」『』]/g, "");

/** Every hyphen-like glyph portals use becomes ASCII "-". */
const HYPHENS = /[‐‑‒–—―ー−]/g;

/**
 * Building numbers travel as roman numerals on some portals and digits on
 * others (リーブルファイン草加稲荷Ⅲ２号棟 vs …稲荷3－2号棟). After NFKC the
 * numerals are plain ASCII runs like "iii"; fold them to digits only when
 * glued to Japanese text or digits, so Latin names keep their letters.
 */
const ROMAN_NUMERAL: Record<string, string> = { iii: "3", ii: "2", iv: "4", i: "1" };
const foldRomanNumerals = (value: string): string =>
  value.replace(/[ivx]+/g, (run, offset: number, text: string) => {
    const before = text[offset - 1] ?? "";
    const after = text[offset + run.length] ?? "";
    const gluedToJapanese =
      /[\u3040-\u30ff\u4e00-\u9fff]/.test(before) || /[\u3040-\u30ff\u4e00-\u9fff0-9]/.test(after);
    return gluedToJapanese ? (ROMAN_NUMERAL[run] ?? run) : run;
  });

/**
 * Name used for cross-portal comparison. Portals decorate the same unit
 * differently: roomspot appends the floor ("エスタディオ草加 1階"), nifty the
 * room number ("シティハイム柏 103", "グレースゴンゲン 00301"), and suumo may
 * use － or roman numerals inside the building designator. Strip those
 * trailing unit designators (repeatedly, e.g. "…Ａ棟 2階") and fold hyphens
 * and roman numerals so equivalent building names compare equal.
 */
/**
 * A designator set off by a space ("ピカソ４５ 1階"). Stripped before spaces are
 * dropped, or "ピカソ451階" would lose the building's own number with the floor.
 */
const SPACED_DESIGNATOR = /\s+(?:\d+号室|\d+(?:[-‐‑‒–—―ー−]\d+)?階|\d{3,5})$/;

const normName = (value: string): string => {
  let spaced = value.normalize("NFKC").trim();
  while (SPACED_DESIGNATOR.test(spaced)) spaced = spaced.replace(SPACED_DESIGNATOR, "").trim();
  let name = foldRomanNumerals(norm(spaced)).replace(HYPHENS, "-").replace(/-/g, "");
  let previous = "";
  while (previous !== name) {
    previous = name;
    name = name.replace(/(?:\d+号室|\d+(?:-\d+)?階|\d{3,4}|棟)$/, "");
  }
  return name;
};

/** Normalize the harmless address differences portals commonly introduce. */
const normAddress = (value: string): string =>
  norm(value)
    .replace(/([0-9]+)丁目/g, "$1")
    .replace(HYPHENS, "-");

/**
 * The area (町名 + 丁目) portion of an address, without the 番地/号. athome
 * and suumo usually stop at the chome (草加市松江１丁目 / 草加市松江１) while
 * roomspot and nifty print the full lot number (草加市 西町291-6, 草加市稲荷
 * 6丁目16-1). Comparing areas lets those spellings meet.
 */
const normArea = (value: string): string => {
  const area = norm(value)
    .replace(HYPHENS, "-")
    // 稲荷6丁目16-1 / 青柳7丁目49 → 稲荷6丁目 / 青柳7丁目 (lot after chome)
    .replace(/(\d+丁目)\d+(?:-\d+)*$/, "$1")
    // 西町291-6 / 大道842-1 → 西町 / 大道 (lot with no chome at all)
    .replace(/([^\d])\d+(?:-\d+)+$/, "$1")
    // 西町544 → 西町. A single trailing digit can be an omitted 丁目
    // (松江1), so only unhyphenated multi-digit lot numbers are removed.
    .replace(/([^\d])\d{2,}$/, "$1");
  return area.replace(/([0-9]+)丁目/g, "$1");
};

/** The building name as cross-portal matching compares it. */
export const comparableName = normName;
/** The 町名 + 丁目 part of an address, as cross-portal matching compares it. */
export const comparableArea = normArea;

/** Prefer an exact lot address over a portal's town/chome-only spelling. */
function chooseAddress(primary: string, secondary: string): string {
  if (normArea(primary) !== normArea(secondary)) return primary;
  return normAddress(secondary).length > normAddress(primary).length ? secondary : primary;
}

const close = (a: number | null | undefined, b: number | null | undefined, tolerance: number): boolean =>
  a != null && b != null && Math.abs(a - b) <= tolerance;

/**
 * Floor areas agree within 0.2 m². UR prints whole square metres, cut down
 * (79.23 m² is "79㎡"), so its own ad may sit up to 1 m² below a portal's.
 */
function sameSize(a: RawListing, b: RawListing): boolean {
  if (a.source !== UR_SOURCE && b.source !== UR_SOURCE) return close(a.sizeM2, b.sizeM2, 0.2);
  const [ur, other] = a.source === UR_SOURCE ? [a, b] : [b, a];
  return ur.sizeM2 != null && other.sizeM2 != null && other.sizeM2 - ur.sizeM2 > -0.2 && other.sizeM2 - ur.sizeM2 < 1;
}

/**
 * Portals print 階数 as "-" when it does not apply (terraced houses) or is
 * unstated; that is absence of information, not a floor to conflict with.
 */
const UNKNOWN_FLOORS = new Set(["", "-"]);
const normFloor = (value: string | null | undefined): string => norm(value).replace(HYPHENS, "-").replace(/[~～]/g, "-");

/** "2階" → [2, 2]; "1-2階", a house or maisonette over several floors, → [1, 2]. */
function floorRange(floor: string): [number, number] | undefined {
  const match = floor.match(/^(\d+)(?:-(\d+))?階$/);
  if (!match) return undefined;
  const low = Number(match[1]);
  return [low, match[2] ? Number(match[2]) : low];
}

/**
 * Different floors mean different rooms. A house is the exception that portals
 * print two ways: SUUMO gives its floors ("1-2階"), AtHome and others the floor
 * of the entrance ("1階"). A floor within the other side's range is no conflict.
 */
function hasFloorConflict(a: RawListing, b: RawListing): boolean {
  const floorA = normFloor(a.building?.floor);
  const floorB = normFloor(b.building?.floor);
  if (UNKNOWN_FLOORS.has(floorA) || UNKNOWN_FLOORS.has(floorB) || floorA === floorB) return false;
  const rangeA = floorRange(floorA);
  const rangeB = floorRange(floorB);
  if (!rangeA || !rangeB) return true;
  return rangeA[1] < rangeB[0] || rangeB[1] < rangeA[0];
}

/**
 * Conservative cross-portal room matching. Core unit facts (rent, area,
 * layout, build year, floor) must agree, plus a location identity: the
 * building name, the exact address, or the chome-level area. When only one
 * location label agrees, one more corroborating fact (station, walk time,
 * build year) is required. A floor conflict — both stated, different —
 * prevents two genuinely different units in one building from collapsing.
 */
export function isSameProperty(a: RawListing, b: RawListing): boolean {
  if (a.source === b.source) return false;
  return isSameUnit(a, b);
}

/**
 * The unit-fact comparison, without the portal check. Also used for
 * within-source collapsing, where the whole point is that the source IS the
 * same (one portal carrying two agency ads for one room), and by the build
 * pipeline to retire superseded historical rows.
 *
 * Rent is normally strict (±1%): it distinguishes units. But when the name
 * and the full address match exactly, a larger gap (±5%) is a price update
 * on a re-listed room, not a different room — mirroring the lifecycle rule
 * that identity is name + address + size, rent excluded. The relaxed path
 * additionally requires the agent walk time to agree when both sides state it,
 * and is closed to new buildings.
 *
 * Floor area is normally strict too, except for a room two agencies measured
 * differently (`isRemeasuredUnit`).
 */
export function isSameUnit(a: RawListing, b: RawListing): boolean {
  return agreesOnUnitFacts(a, b) || isRemeasuredUnit(a, b);
}

function agreesOnUnitFacts(a: RawListing, b: RawListing): boolean {
  if (!sameSize(a, b)) return false;
  if (a.builtYear != null && b.builtYear != null && Math.abs(a.builtYear - b.builtYear) > 1) return false;

  if (hasFloorConflict(a, b)) return false;

  const nameA = normName(a.name);
  const nameB = normName(b.name);
  const sameName = nameA.length > 0 && nameA === nameB;
  const addressA = normAddress(a.address);
  const addressB = normAddress(b.address);
  const sameAddress = addressA.length > 0 && addressA === addressB;
  const areaA = normArea(a.address);
  const areaB = normArea(b.address);
  const sameArea = areaA.length > 0 && areaA === areaB;

  const layoutA = norm(a.layout);
  const layoutB = norm(b.layout);
  if (layoutA && layoutB && layoutA !== layoutB) {
    // Portals sometimes classify a convertible room differently (2LDK/3K or
    // 3DK/3LDK). Accept only those observed taxonomy pairs when the remaining
    // unit identity is unusually exact. The advertised station may differ
    // because portals choose different nearby stations, but an identical walk
    // time is acceptable corroboration.
    const pair = [layoutA, layoutB].sort().join("|");
    const knownConvertiblePair = pair === "2ldk|3k" || pair === "3dk|3ldk";
    const exactUnitFacts =
      sameName && (sameAddress || sameArea) &&
      close(a.sizeM2, b.sizeM2, 0.05) && close(a.rent, b.rent, 100) &&
      a.builtYear != null && b.builtYear != null && Math.abs(a.builtYear - b.builtYear) <= 1 &&
      close(a.stationWalkMin, b.stationWalkMin, 0);
    if (!(knownConvertiblePair && exactUnitFacts)) return false;
  }

  // Not in a new building: its alike rooms are let together at rents a few
  // thousand yen apart, and one portal's ads for five of them are five rooms.
  const strongIdentity = sameName && sameAddress && !isNewBuild(a) && !isNewBuild(b);
  const tolerance = strongIdentity
    ? Math.max(1_000, Math.min(a.rent, b.rent) * 0.05)
    : Math.max(1_000, Math.min(a.rent, b.rent) * 0.01);
  if (!close(a.rent, b.rent, tolerance)) return false;
  const rentRelaxed = Math.abs(a.rent - b.rent) > Math.max(1_000, Math.min(a.rent, b.rent) * 0.01);
  if (rentRelaxed && a.stationWalkMin != null && b.stationWalkMin != null && a.stationWalkMin !== b.stationWalkMin) {
    return false;
  }

  // Strong identity: the same building name at the same place.
  if (sameName && (sameAddress || sameArea)) return true;
  // Same exact address with overlapping names (one side adds a designator).
  if (sameAddress && (nameA.includes(nameB) || nameB.includes(nameA))) return true;
  if (!sameName && !sameAddress && !sameArea) return false;

  // Weaker paths (name without address, area without name — e.g. an agent
  // rebranded building or a portal that withholds the name) need one more
  // corroborating fact on top of the core unit facts above.
  const sameStation = Boolean(
    a.advertisedStation && b.advertisedStation && norm(a.advertisedStation) === norm(b.advertisedStation),
  );
  const sameBuildYear = a.builtYear != null && b.builtYear != null && Math.abs(a.builtYear - b.builtYear) <= 1;
  const sameWalk = close(a.stationWalkMin, b.stationWalkMin, 2);
  return sameStation || sameBuildYear || sameWalk;
}

/** Rooms a layout counts: 2DK → 2, and a service room is a room, so 2SLDK → 3. */
function roomCount(layout: string): number | undefined {
  const match = layout.match(/^(\d+)(s?)/);
  return match ? Number(match[1]) + (match[2] ? 1 : 0) : undefined;
}

/** 2K / 2DK / 2LDK, or 2SLDK / 3LDK / 3SLDK: one room that agencies label differently. */
function layoutsCompatible(a: string, b: string): boolean {
  if (!a || !b || a === b) return true;
  const [roomsA, roomsB] = [roomCount(a), roomCount(b)];
  if (roomsA == null || roomsB == null) return false;
  return roomsA === roomsB || a.replace(/^(\d+)s/, "$1") === b.replace(/^(\d+)s/, "$1");
}

/** A building finished this year or last is still filling up: many alike rooms are on offer at once. */
const NEW_BUILD_FROM = new Date().getFullYear() - 1;
export const isNewBuild = (listing: RawListing): boolean => listing.builtYear != null && listing.builtYear >= NEW_BUILD_FROM;

/**
 * One room as two agencies describe it. Each agency measures and labels a
 * room itself, and its figures travel with its ad to every portal: SUUMO ads
 * that SUUMO gives one room code differ in floor area in most pairs (often by
 * 1–3 m², 60 vs 62), in layout in a fifth (3DK vs 3LDK) and in build year by
 * one, yet never in rent. So where the building, the floor and the rent agree
 * exactly, a different floor area or layout label is the other agency's
 * figure, not another room.
 *
 * Both floors must be stated: an ad without one could be the alike room a
 * floor up (measured on SUUMO room codes with `npm run dedup:eval`). New
 * buildings are left out, since alike rooms on one floor are let together.
 */
function isRemeasuredUnit(a: RawListing, b: RawListing): boolean {
  if (a.sizeM2 == null || b.sizeM2 == null || a.rent !== b.rent) return false;
  if (Math.abs(a.sizeM2 - b.sizeM2) > Math.max(3, Math.min(a.sizeM2, b.sizeM2) * 0.05)) return false;
  if (a.builtYear == null || b.builtYear == null || Math.abs(a.builtYear - b.builtYear) > 1) return false;
  if (isNewBuild(a) || isNewBuild(b)) return false;
  const [floorA, floorB] = [normFloor(a.building?.floor), normFloor(b.building?.floor)];
  if (UNKNOWN_FLOORS.has(floorA) || UNKNOWN_FLOORS.has(floorB) || hasFloorConflict(a, b)) return false;
  if (!layoutsCompatible(norm(a.layout), norm(b.layout))) return false;
  const name = normName(a.name);
  const area = normArea(a.address);
  return name.length > 0 && name === normName(b.name) && area.length > 0 && area === normArea(b.address);
}

function sourceRank(listing: RawListing): number {
  const index = SOURCE_PRIORITY.indexOf(listing.source);
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

const referenceRank = (reference: SourceListingReference): number => {
  const index = SOURCE_PRIORITY.indexOf(reference.source);
  return index === -1 ? SOURCE_PRIORITY.length : index;
};

function filledCount(value: unknown): number {
  if (value == null || value === "") return 0;
  if (Array.isArray(value)) return value.length + value.reduce((sum, item) => sum + filledCount(item), 0);
  if (typeof value === "object") return Object.values(value).reduce((sum, item) => sum + filledCount(item), 0);
  return 1;
}

/** Completeness of what the ad says about the room; the agency's store details are not room facts. */
const roomFactCount = ({ agencyInfo: _agencyInfo, ...listing }: RawListing) => filledCount(listing);

/** Preferred portal wins ties; completeness decides within one tier. */
export function isBetterListing(candidate: RawListing, incumbent: RawListing): boolean {
  if (sourceRank(candidate) !== sourceRank(incumbent)) return sourceRank(candidate) < sourceRank(incumbent);
  return roomFactCount(candidate) > roomFactCount(incumbent);
}

/**
 * Every portal ad for this listing, deduplicated and ordered by portal
 * preference (athome → suumo → nifty). Falls back to the listing's own
 * source/url when it was never merged.
 */
export function sourceListings(listing: RawListing): SourceListingReference[] {
  const references = listing.sourceListings?.length
    ? listing.sourceListings
    : [{ source: listing.source, id: listing.id, url: listing.url }];
  const unique = new Map<string, SourceListingReference>();
  for (const reference of references) unique.set(referenceKey(reference), reference);
  return [...unique.values()].sort((x, y) => referenceRank(x) - referenceRank(y));
}

/**
 * One key per portal ad. SUUMO row ids are built from name, layout and rent,
 * so two agencies' ads for a room (or two rooms) can share one; SUUMO's own
 * ad code in the URL (`bc`) tells them apart, so neither link is lost.
 */
function referenceKey(reference: SourceListingReference): string {
  const bc = reference.source === "suumo" ? reference.url?.match(/[?&]bc=(\d+)/)?.[1] : undefined;
  if (bc) return `${reference.source}|bc:${bc}`;
  return reference.id ? `${reference.source}|id:${reference.id}` : `${reference.source}|url:${reference.url ?? ""}`;
}

const chooseParking = (primary?: ParkingInfo | null, secondary?: ParkingInfo | null): ParkingInfo | null | undefined => {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return filledCount(secondary) > filledCount(primary) ? secondary : primary;
};

function mergeObject<T extends object>(primary: T | undefined, secondary: T | undefined): T | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const result = { ...secondary, ...primary } as Record<string, unknown>;
  for (const [key, value] of Object.entries(primary)) {
    if (value == null || value === "") result[key] = (secondary as Record<string, unknown>)[key];
  }
  return result as T;
}

function mergeBuilding(primary?: ListingBuilding, secondary?: ListingBuilding): ListingBuilding | undefined {
  const merged = mergeObject(primary, secondary);
  if (!merged) return undefined;
  const union = (a?: string[] | null, b?: string[] | null) => [...new Set([...(a ?? []), ...(b ?? [])])];
  return {
    ...merged,
    features: union(primary?.features, secondary?.features),
    conditions: union(primary?.conditions, secondary?.conditions),
  };
}

function mergeCosts(primary?: ListingCosts, secondary?: ListingCosts): ListingCosts | undefined {
  const merged = mergeObject(primary, secondary);
  if (!merged) return undefined;
  return { ...merged, parking: chooseParking(primary?.parking, secondary?.parking) };
}

/** Keep the preferred portal's presentation while filling its missing details. */
export function mergeDuplicateListings(a: RawListing, b: RawListing): RawListing {
  const [primary, secondary] = isBetterListing(a, b) ? [a, b] : [b, a];
  const { agency: _agency, agencyInfo: _agencyInfo, ...merged } = mergeObject(primary, secondary)!;
  const references = [...sourceListings(primary), ...sourceListings(secondary)];
  const uniqueReferences = new Map(references.map((reference) => [referenceKey(reference), reference]));

  return {
    ...merged,
    address: chooseAddress(primary.address, secondary.address),
    parking: chooseParking(primary.parking, secondary.parking),
    costs: mergeCosts(primary.costs, secondary.costs),
    tenancy: mergeObject(primary.tenancy, secondary.tenancy),
    building: mergeBuilding(primary.building, secondary.building),
    ...chooseAgency(primary, secondary),
    attributes: [...new Map([...(primary.attributes ?? []), ...(secondary.attributes ?? [])].map((item) => [
      `${item.key}|${item.state ?? ""}|${item.raw}`,
      item,
    ])).values()],
    sourceListings: [...uniqueReferences.values()].sort((x, y) => referenceRank(x) - referenceRank(y)),
    ...mergePhotos(primary.photos, secondary.photos),
  };
}

/** One ad's store, never one portal's name with another portal's address. */
function chooseAgency(primary: RawListing, secondary: RawListing): Pick<RawListing, "agency" | "agencyInfo"> {
  const named = (listing: RawListing) => listing.agency != null || listing.agencyInfo != null;
  const [chosen, other] = named(primary) ? [primary, secondary] : [secondary, primary];
  const sameStore = chosen.agency != null && chosen.agency === other.agency;
  const agencyInfo = chosen.agencyInfo ?? (sameStore ? other.agencyInfo : undefined);
  return { ...(chosen.agency !== undefined ? { agency: chosen.agency } : {}),
    ...(agencyInfo !== undefined ? { agencyInfo } : {}) };
}

/** Every portal's pictures of the room, preferred portal first; omitted when neither has any. */
function mergePhotos(primary?: ListingPhoto[], secondary?: ListingPhoto[]): { photos?: ListingPhoto[] } {
  const photos = [...new Map([...(primary ?? []), ...(secondary ?? [])].map((photo) => [photo.url, photo])).values()];
  return photos.length ? { photos } : {};
}

/**
 * Collapse one portal's own duplicate ads for the same unit (several agencies
 * post the same room on SUUMO). Distinct units in one building disagree on
 * floor — or rent, or area — and stay separate. Both ads' links are kept.
 */
/** SUUMO's code for a room, shared by every agency's ad for it (the ad's own code is `bc`). */
const suumoRoomCode = (reference: SourceListingReference): string | undefined =>
  reference.source === "suumo" ? reference.url?.match(/\/jnc_(\d+)/)?.[1] : undefined;

/**
 * Two references to one portal ad, or to one room as the portal itself
 * identifies it. SUUMO row ids are built from name, layout and rent, so two
 * rooms of one building can share an id; where a URL carries SUUMO's room
 * code, the code decides and the id is ignored. Two codes are not proof of
 * two rooms, though (SUUMO misses some copies), so ads with different codes
 * can still merge on their facts like any other pair.
 */
function isSameAd(x: SourceListingReference, y: SourceListingReference): boolean {
  if (x.source !== y.source) return false;
  const [roomX, roomY] = [suumoRoomCode(x), suumoRoomCode(y)];
  if (roomX || roomY) return roomX === roomY;
  return Boolean(x.id) && x.id === y.id;
}

/**
 * The portal's own identity is authoritative: the listings merge even when
 * their facts disagree (a later scrape corrected them, or two agencies
 * measured the room differently).
 */
export function sharesAdIdentity(a: RawListing, b: RawListing): boolean {
  const references = sourceListings(b);
  return sourceListings(a).some((x) => references.some((y) => isSameAd(x, y)));
}

/** Rows after merging, and for each row the ads as they were before it. */
interface MergedRows {
  merged: RawListing[];
  members: RawListing[][];
}

function deduplicateWithinSource(listings: readonly RawListing[]): MergedRows {
  const merged: RawListing[] = [];
  const members: RawListing[][] = [];
  const byName = new Map<string, Set<number>>();
  const byArea = new Map<string, Set<number>>();

  const addTo = (map: Map<string, Set<number>>, key: string, index: number) => {
    if (!key) return;
    const bucket = map.get(key) ?? new Set<number>();
    bucket.add(index);
    map.set(key, bucket);
  };

  for (const listing of listings) {
    const candidateIndices = new Set([
      ...(byName.get(normName(listing.name)) ?? []),
      ...(byArea.get(normArea(listing.address)) ?? []),
    ]);
    const duplicateIndex = [...candidateIndices].find((index) =>
      merged[index].source === listing.source &&
      (members[index].some((member) => sharesAdIdentity(member, listing)) ||
        (!members[index].some((member) => hasFloorConflict(member, listing)) &&
          members[index].some((member) => isSameUnit(member, listing)))),
    );

    const index = duplicateIndex ?? merged.length;
    if (duplicateIndex == null) {
      merged.push(listing);
      members.push([listing]);
    } else {
      merged[index] = mergeDuplicateListings(merged[index], listing);
      members[index].push(listing);
    }
    addTo(byName, normName(listing.name), index);
    addTo(byArea, normArea(listing.address), index);
  }
  return { merged, members };
}

/**
 * Collapse duplicate ads into one row per room. Phase 1 folds each portal's
 * own repeat ads; phase 2 merges across portals, never combining two ads
 * from the same portal into a cross-source group (they may be distinct
 * units) — phase 1 has already removed the true same-unit repeats.
 *
 * A row is matched through every ad in it, not through the facts the merged
 * row happens to show. Two agencies' SUUMO ads for one room (64 m² and 68 m²)
 * make one row, and another portal's 64 m² copy must still find it whichever
 * of the two leads.
 */
export function deduplicateListings(listings: readonly RawListing[]): RawListing[] {
  const input = deduplicateWithinSource(listings);
  // A row absorbed into an earlier one leaves a hole, so indices stay valid.
  const merged: (RawListing | undefined)[] = [];
  const members: RawListing[][] = [];
  // Matching keys off normalized name, address and chome-area, so index all
  // three instead of scanning every prior row (O(n²)). Keep all aliases from
  // a merged group so a third portal can still match either original spelling.
  const byName = new Map<string, Set<number>>();
  const byAddress = new Map<string, Set<number>>();
  const byArea = new Map<string, Set<number>>();

  const addTo = (map: Map<string, Set<number>>, key: string, index: number) => {
    if (!key) return;
    const bucket = map.get(key) ?? new Set<number>();
    bucket.add(index);
    map.set(key, bucket);
  };
  const indexAds = (ads: readonly RawListing[], index: number) => {
    for (const ad of ads) {
      addTo(byName, normName(ad.name), index);
      addTo(byAddress, normAddress(ad.address), index);
      addTo(byArea, normArea(ad.address), index);
    }
  };

  /** Whether `ads`, one row's worth, are the room row `index` already holds. */
  const joins = (index: number, ads: readonly RawListing[]): boolean => {
    const anyPair = (test: (member: RawListing, ad: RawListing) => boolean) =>
      members[index].some((member) => ads.some((ad) => test(member, ad)));
    // An unknown-floor ad may match either unit in isolation, but cannot
    // bridge two groups whose observed floors explicitly disagree.
    if (!anyPair(sharesAdIdentity) && anyPair(hasFloorConflict)) return false;
    const sources = new Set(ads.flatMap((ad) => sourceListings(ad).map(({ source }) => source)));
    const onSharedPortal = (member: RawListing) => sourceListings(member).some((ref) => sources.has(ref.source));
    if (!members[index].some(onSharedPortal)) return anyPair(isSameProperty);
    // The group already carries a portal these ads also carry: fold in only
    // when this is the same unit as that portal's existing entry (a repeat
    // agency ad, or a historical group whose name/address drifted from the
    // surviving ad). A merely similar ad stays out — it may be a different
    // unit. Members may themselves be pre-merged groups, so compare against
    // their whole source set.
    if (anyPair((member, ad) => sharesAdIdentity(member, ad) || (onSharedPortal(member) && isSameUnit(member, ad)))) {
      return true;
    }
    // Two agencies' ads on one portal show the room at one rent while their
    // other figures differ, so the shared portal's entry need not match
    // itself: at the same rent, matching any ad in the group is enough.
    const sameRent = members[index].filter(onSharedPortal).every((member) => ads.every((ad) => ad.rent === member.rent));
    return sameRent && anyPair(isSameUnit);
  };

  input.merged.forEach((listing, position) => {
    const ads = input.members[position];
    const candidates = [...new Set(ads.flatMap((ad) => [
      ...(byName.get(normName(ad.name)) ?? []),
      ...(byAddress.get(normAddress(ad.address)) ?? []),
      ...(byArea.get(normArea(ad.address)) ?? []),
    ]))].filter((index) => merged[index] != null).sort((x, y) => x - y);
    const [index, ...others] = candidates.filter((candidate) => joins(candidate, ads));

    if (index == null) {
      merged.push(listing);
      members.push([...ads]);
      indexAds(ads, merged.length - 1);
      return;
    }
    merged[index] = mergeDuplicateListings(merged[index]!, listing);
    members[index].push(...ads);
    indexAds(ads, index);
    // These ads may also be what shows two earlier rows to be one room (two
    // agencies' AtHome ads, then the SUUMO room that carries both sets of
    // figures). Each later row joins on the same terms as any new ad.
    for (const other of others) {
      if (!joins(index, members[other])) continue;
      merged[index] = mergeDuplicateListings(merged[index]!, merged[other]!);
      members[index].push(...members[other]);
      indexAds(members[other], index);
      merged[other] = undefined;
      members[other] = [];
    }
  });
  return merged.filter((listing): listing is RawListing => listing != null);
}
