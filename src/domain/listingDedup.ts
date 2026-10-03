import type {
  ListingBuilding,
  ListingCosts,
  ListingPhoto,
  ParkingInfo,
  RawListing,
  SourceListingReference,
} from "./types";

/**
 * Portal preference for the merged record's presentation and link ordering:
 * athome first, then suumo, then nifty. Every portal ad is still retained in
 * `sourceListings` — this only decides which one leads.
 */
const SOURCE_PRIORITY = ["athome", "suumo", "nifty", "roomspot"];

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
const normName = (value: string): string => {
  let name = foldRomanNumerals(norm(value)).replace(HYPHENS, "-").replace(/-/g, "");
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

/** Prefer an exact lot address over a portal's town/chome-only spelling. */
function chooseAddress(primary: string, secondary: string): string {
  if (normArea(primary) !== normArea(secondary)) return primary;
  return normAddress(secondary).length > normAddress(primary).length ? secondary : primary;
}

const close = (a: number | null | undefined, b: number | null | undefined, tolerance: number): boolean =>
  a != null && b != null && Math.abs(a - b) <= tolerance;

/**
 * Portals print 階数 as "-" when it does not apply (terraced houses) or is
 * unstated; that is absence of information, not a floor to conflict with.
 */
const UNKNOWN_FLOORS = new Set(["", "-"]);
const normFloor = (value: string | null | undefined): string => norm(value).replace(HYPHENS, "-");

function hasFloorConflict(a: RawListing, b: RawListing): boolean {
  const floorA = normFloor(a.building?.floor);
  const floorB = normFloor(b.building?.floor);
  return !UNKNOWN_FLOORS.has(floorA) && !UNKNOWN_FLOORS.has(floorB) && floorA !== floorB;
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
 * additionally requires the agent walk time to agree when both sides state it.
 */
export function isSameUnit(a: RawListing, b: RawListing): boolean {
  if (!close(a.sizeM2, b.sizeM2, 0.2)) return false;
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

  const strongIdentity = sameName && sameAddress;
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

/** Preferred portal wins ties; completeness decides within one tier. */
export function isBetterListing(candidate: RawListing, incumbent: RawListing): boolean {
  if (sourceRank(candidate) !== sourceRank(incumbent)) return sourceRank(candidate) < sourceRank(incumbent);
  return filledCount(candidate) > filledCount(incumbent);
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
  for (const reference of references) {
    const key = reference.id
      ? `${reference.source}|id:${reference.id}`
      : `${reference.source}|url:${reference.url ?? ""}`;
    unique.set(key, reference);
  }
  return [...unique.values()].sort((x, y) => referenceRank(x) - referenceRank(y));
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
  const merged = mergeObject(primary, secondary)!;
  const references = [...sourceListings(primary), ...sourceListings(secondary)];
  const uniqueReferences = new Map(references.map((reference) => [
    reference.id
      ? `${reference.source}|id:${reference.id}`
      : `${reference.source}|url:${reference.url ?? ""}`,
    reference,
  ]));

  return {
    ...merged,
    address: chooseAddress(primary.address, secondary.address),
    parking: chooseParking(primary.parking, secondary.parking),
    costs: mergeCosts(primary.costs, secondary.costs),
    tenancy: mergeObject(primary.tenancy, secondary.tenancy),
    building: mergeBuilding(primary.building, secondary.building),
    attributes: [...new Map([...(primary.attributes ?? []), ...(secondary.attributes ?? [])].map((item) => [
      `${item.key}|${item.state ?? ""}|${item.raw}`,
      item,
    ])).values()],
    sourceListings: [...uniqueReferences.values()].sort((x, y) => referenceRank(x) - referenceRank(y)),
    ...mergePhotos(primary.photos, secondary.photos),
  };
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
/** A portal detail id is authoritative even if a later scrape corrected its facts. */
function sharesSourceListingIdentity(a: RawListing, b: RawListing): boolean {
  const identities = new Set(
    sourceListings(a)
      .filter((reference) => reference.id)
      .map((reference) => `${reference.source}|${reference.id}`),
  );
  return sourceListings(b).some(
    (reference) => reference.id && identities.has(`${reference.source}|${reference.id}`),
  );
}

function deduplicateWithinSource(listings: readonly RawListing[]): RawListing[] {
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
      (members[index].some((member) => sharesSourceListingIdentity(member, listing)) ||
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
  return merged;
}

/**
 * Collapse duplicate ads into one row per room. Phase 1 folds each portal's
 * own repeat ads; phase 2 merges across portals, never combining two ads
 * from the same portal into a cross-source group (they may be distinct
 * units) — phase 1 has already removed the true same-unit repeats.
 */
export function deduplicateListings(listings: readonly RawListing[]): RawListing[] {
  const input = deduplicateWithinSource(listings);
  const merged: RawListing[] = [];
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

  for (const listing of input) {
    const candidateIndices = new Set([
      ...(byName.get(normName(listing.name)) ?? []),
      ...(byAddress.get(normAddress(listing.address)) ?? []),
      ...(byArea.get(normArea(listing.address)) ?? []),
    ]);
    const listingSources = new Set(sourceListings(listing).map(({ source }) => source));
    const duplicateIndex = [...candidateIndices].find((index) => {
      // An unknown-floor ad may match either unit in isolation, but cannot
      // bridge two groups whose observed floors explicitly disagree.
      const sharedIdentity = members[index].some((member) => sharesSourceListingIdentity(member, listing));
      if (!sharedIdentity && members[index].some((member) => hasFloorConflict(member, listing))) return false;
      const candidateSources = sourceListings(merged[index]).map(({ source }) => source);
      if (!candidateSources.some((source) => listingSources.has(source))) {
        return members[index].some((member) => isSameProperty(member, listing));
      }
      // The group already carries a portal this listing also carries: fold in
      // only when this is the same unit as that portal's existing entry (a
      // repeat agency ad, or a historical group whose name/address drifted
      // from the surviving ad). A merely similar ad stays out — it may be a
      // different unit. Members may themselves be pre-merged groups, so
      // compare against their whole source set.
      return members[index].some(
        (member) =>
          sharesSourceListingIdentity(member, listing) ||
          (sourceListings(member).some((ref) => listingSources.has(ref.source)) &&
            isSameUnit(member, listing)),
      );
    });

    const index = duplicateIndex ?? merged.length;
    if (duplicateIndex == null) {
      merged.push(listing);
      members.push([listing]);
    } else {
      merged[index] = mergeDuplicateListings(merged[index], listing);
      members[index].push(listing);
    }
    addTo(byName, normName(listing.name), index);
    addTo(byAddress, normAddress(listing.address), index);
    addTo(byArea, normArea(listing.address), index);
  }
  return merged;
}
