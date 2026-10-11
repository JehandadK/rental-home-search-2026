/**
 * Possible duplicates: pairs of listings that the conservative cross-portal
 * matcher (`isSameUnit` in listingDedup.ts) kept apart, but that look like
 * the same home. They are suggestions for a person to confirm, never merged
 * automatically.
 *
 * A pair must agree on the unit facts within loose tolerances (city, floor
 * area, layout, rent, build year, no stated-floor conflict) and share some
 * location evidence (a similar building name, the same 町名+丁目, or nearby
 * geocodes). What each signal contributed is kept as `reasons`, so the
 * reviewer can see why the pair was suggested.
 *
 * A person's answer is a `DuplicateDecision`, keyed by each side's portal ad
 * keys rather than listing ids: merged listing ids change when a rebuild
 * picks a different leading ad, but an ad's key does not. `resolveDecisions`
 * finds today's listings for each answer and builds the confirmed groups.
 */
import { listingAdKey } from "./availability";
import { haversineM } from "./geo";
import { isSold } from "./lifecycle";
import { comparableArea, comparableName, sourceListings } from "./listingDedup";
import { listingKey } from "./listingKey";
import type { EnrichedListing } from "./types";

export interface PossibleDuplicate {
  /** listingKey of each side, in a stable order. */
  keys: [string, string];
  /** 0–1: how alike the two listings are. */
  score: number;
  /** Short, human-readable evidence, strongest first. */
  reasons: string[];
}

export type DuplicateVerdict = "same" | "different";

export interface DuplicateDecision {
  verdict: DuplicateVerdict;
  /** Portal ad keys of each side when the person decided. */
  a: string[];
  b: string[];
  decidedAt: string;
}

/** The lowest score worth showing a person. */
export const MIN_DUPLICATE_SCORE = 0.55;

/** Layout pairs portals are known to classify differently for one room. */
const CONVERTIBLE_LAYOUTS = new Set(["2ldk|3k", "3dk|3ldk", "2ldk|2sldk", "2dk|2sdk", "3ldk|3sldk", "1ldk|2k", "1ldk|2dk"]);

const normLayout = (value: string | null | undefined) => (value ?? "").normalize("NFKC").toLowerCase().replace(/\s/g, "");
const normText = (value: string | null | undefined) => (value ?? "").normalize("NFKC").toLowerCase().replace(/\s/g, "");

/**
 * Names that describe the place rather than the building: AtHome and Nifty
 * print "越谷市 蒲生寿町（蒲生駅）" or "北越谷駅より徒歩2分 築55年2ヶ月 9階建"
 * when the agent withholds the name. Comparing those says nothing.
 */
export function isDescriptiveName(name: string): boolean {
  return /駅より徒歩|徒歩\d+分|築\d+年|\d+階建|[市区町村]\s|[(（][^)）]*駅[)）]$/.test(name.normalize("NFKC"));
}

/** Dice coefficient over character bigrams; 1 means identical. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 0.9;
  const grams = (text: string) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < text.length - 1; i++) counts.set(text.slice(i, i + 2), (counts.get(text.slice(i, i + 2)) ?? 0) + 1);
    return counts;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [gram, count] of ga) shared += Math.min(count, gb.get(gram) ?? 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * shared) / total;
}

const floorOf = (listing: EnrichedListing) => normText(listing.building?.floor).replace(/[‐‑‒–—―ー−]/g, "-");
const KNOWN_FLOOR = (floor: string) => floor !== "" && floor !== "-";

interface Prepared {
  listing: EnrichedListing;
  key: string;
  name: string;
  descriptive: boolean;
  area: string;
  layout: string;
  floor: string;
}

/** How alike two listings are, or null when a unit fact rules the pair out. */
export function compareListings(a: Prepared, b: Prepared): Omit<PossibleDuplicate, "keys"> | null {
  const x = a.listing;
  const y = b.listing;
  if (!x.city || x.city !== y.city) return null;
  if (x.sizeM2 == null || y.sizeM2 == null) return null;

  const sizeTolerance = Math.max(1, Math.min(x.sizeM2, y.sizeM2) * 0.02);
  const sizeGap = Math.abs(x.sizeM2 - y.sizeM2);
  if (sizeGap > sizeTolerance) return null;

  const rentTolerance = Math.max(3_000, Math.min(x.rent, y.rent) * 0.08);
  const rentGap = Math.abs(x.rent - y.rent);
  if (rentGap > rentTolerance) return null;

  const layoutsDiffer = a.layout !== "" && b.layout !== "" && a.layout !== b.layout;
  if (layoutsDiffer && !CONVERTIBLE_LAYOUTS.has([a.layout, b.layout].sort().join("|"))) return null;

  const yearGap = x.builtYear != null && y.builtYear != null ? Math.abs(x.builtYear - y.builtYear) : null;
  if (yearGap != null && yearGap > 2) return null;

  // Two stated, different floors are two rooms in one building.
  if (KNOWN_FLOOR(a.floor) && KNOWN_FLOOR(b.floor) && a.floor !== b.floor) return null;

  const reasons: string[] = [];
  const named = !a.descriptive && !b.descriptive && a.name !== "" && b.name !== "";
  const similarity = named ? nameSimilarity(a.name, b.name) : 0;
  const sameArea = a.area !== "" && a.area === b.area;
  const metres = x.lat != null && x.lon != null && y.lat != null && y.lon != null
    ? haversineM({ lat: x.lat, lon: x.lon }, { lat: y.lat, lon: y.lon })
    : null;

  const nameSignal = named ? similarity : 0.35;
  const locationSignal = sameArea ? 1 : metres == null ? 0 : metres <= 150 ? 0.7 : metres <= 300 ? 0.4 : 0;
  // Some location evidence is required: alike facts in different places are different homes.
  if (similarity < 0.5 && locationSignal === 0) return null;
  if (named && similarity < 0.2 && !sameArea) return null;

  if (named && similarity === 1) reasons.push("same building name");
  else if (named && similarity >= 0.5) reasons.push("similar building name");
  else if (!named) reasons.push("building name not given");
  if (sameArea) reasons.push("same 丁目");
  else if (metres != null && metres <= 300) reasons.push(`${Math.round(metres)} m apart`);

  const sizeSignal = 1 - sizeGap / sizeTolerance;
  reasons.push(sizeGap < 0.05 ? "same floor area" : `area ±${sizeGap.toFixed(1)}㎡`);
  const rentSignal = 1 - rentGap / rentTolerance;
  reasons.push(rentGap === 0 ? "same rent" : `rent ±¥${rentGap.toLocaleString("en-US")}`);
  if (layoutsDiffer) reasons.push(`layout ${x.layout} / ${y.layout}`);

  const yearSignal = yearGap == null ? 0.5 : yearGap === 0 ? 1 : yearGap === 1 ? 0.7 : 0.3;
  if (yearGap === 0) reasons.push("same build year");
  else if (yearGap != null) reasons.push(`built ±${yearGap}y`);

  const sameStation = Boolean(x.advertisedStation && y.advertisedStation && normText(x.advertisedStation) === normText(y.advertisedStation));
  const walkGap = x.stationWalkMin != null && y.stationWalkMin != null ? Math.abs(x.stationWalkMin - y.stationWalkMin) : null;
  const accessSignal = (sameStation ? 0.5 : 0) + (walkGap == null ? 0.25 : walkGap === 0 ? 0.5 : walkGap <= 2 ? 0.3 : 0);
  if (sameStation && walkGap === 0) reasons.push("same station & walk");
  else if (sameStation) reasons.push("same station");

  // One portal rarely lists a room twice; two of its ads are more often two rooms.
  const sameSource = x.source === y.source;
  if (sameSource) reasons.push(`both on ${x.source}`);

  const score = 0.3 * nameSignal + 0.25 * locationSignal + 0.15 * sizeSignal + 0.1 * rentSignal
    + 0.1 * yearSignal + 0.1 * accessSignal - (layoutsDiffer ? 0.05 : 0) - (sameSource ? 0.1 : 0);
  return { score: Math.round(score * 100) / 100, reasons };
}

function prepare(listing: EnrichedListing): Prepared {
  return {
    listing,
    key: listingKey(listing),
    name: comparableName(listing.name),
    descriptive: isDescriptiveName(listing.name),
    area: comparableArea(listing.address),
    layout: normLayout(listing.layout),
    floor: floorOf(listing),
  };
}

/**
 * Every likely pair among active listings, best first. Listings are grouped
 * by city and swept in floor-area order, so only rooms of nearly the same
 * size are ever compared.
 */
export function findPossibleDuplicates(
  listings: readonly EnrichedListing[],
  minScore = MIN_DUPLICATE_SCORE,
): PossibleDuplicate[] {
  const byCity = new Map<string, Prepared[]>();
  const seen = new Set<string>();
  for (const listing of listings) {
    if (isSold(listing) || !listing.city || listing.sizeM2 == null) continue;
    // Two rows can share a key; compare the first, as every key-based view shows one.
    const key = listingKey(listing);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = byCity.get(listing.city) ?? [];
    group.push(prepare(listing));
    byCity.set(listing.city, group);
  }
  const pairs: PossibleDuplicate[] = [];
  for (const group of byCity.values()) {
    group.sort((p, q) => p.listing.sizeM2! - q.listing.sizeM2!);
    for (let i = 0; i < group.length; i++) {
      const size = group[i].listing.sizeM2!;
      const reach = Math.max(1, size * 0.02);
      for (let j = i + 1; j < group.length && group[j].listing.sizeM2! - size <= reach; j++) {
        if (group[i].key === group[j].key) continue;
        const match = compareListings(group[i], group[j]);
        if (!match || match.score < minScore) continue;
        const keys = [group[i].key, group[j].key].sort() as [string, string];
        pairs.push({ keys, ...match });
      }
    }
  }
  return pairs.sort((p, q) => q.score - p.score || p.keys[0].localeCompare(q.keys[0]));
}

/** Every portal ad a listing carries, as finely as each portal tells ads apart (SUUMO: jnc + bc). */
export function listingAdKeys(listing: EnrichedListing): string[] {
  return [...new Set(sourceListings(listing).map((reference) => listingAdKey(reference.source, reference.url, reference.id)))];
}

/** A decision's storage key: the two sides' ad keys, order-independent. */
export function decisionKey(a: readonly string[], b: readonly string[]): string {
  return [[...a].sort().join(","), [...b].sort().join(",")].sort().join(" ~ ");
}

/** A pair of listing keys, order-independent. */
export const pairId = (a: string, b: string): string => [a, b].sort().join(" ~ ");

export interface ResolvedDecisions {
  /** Each decision's two listings now (by listingKey); a side is undefined when its ads are gone. */
  sides: Map<string, [string | undefined, string | undefined]>;
  /** The decision about a pair of listings, by pairId. */
  byPair: Map<string, { id: string; decision: DuplicateDecision }>;
  /** Every listing in a confirmed group → the key of the group's lead. */
  leadOf: Map<string, string>;
  /** "Same" answers not applied because they would join homes a "Different" answer separates. */
  conflicts: Set<string>;
}

/**
 * Find today's listings for every decision. A side is the listing holding
 * the most of its ads, counting only ads exactly one listing carries, so a
 * key two listings share can never send an answer to the wrong home. "Same"
 * answers then join listings into groups, oldest first, unless the join would
 * put two listings a "Different" answer separates into one group.
 */
export function resolveDecisions(
  listings: readonly EnrichedListing[],
  decisions: Readonly<Record<string, DuplicateDecision>>,
): ResolvedDecisions {
  const sides: ResolvedDecisions["sides"] = new Map();
  const byPair: ResolvedDecisions["byPair"] = new Map();
  const leadOf = new Map<string, string>();
  const conflicts = new Set<string>();
  const entries = Object.entries(decisions);
  if (entries.length === 0) return { sides, byPair, leadOf, conflicts };

  const holders = new Map<string, string[]>();
  const byKey = new Map<string, EnrichedListing>();
  for (const listing of listings) {
    const key = listingKey(listing);
    if (byKey.has(key)) continue;
    byKey.set(key, listing);
    for (const ad of listingAdKeys(listing)) holders.set(ad, [...(holders.get(ad) ?? []), key]);
  }
  const resolve = (ads: readonly string[]): string | undefined => {
    const votes = new Map<string, number>();
    for (const ad of ads) {
      const owners = holders.get(ad);
      if (owners?.length === 1) votes.set(owners[0], (votes.get(owners[0]) ?? 0) + 1);
    }
    return [...votes].sort(([k1, v1], [k2, v2]) => v2 - v1 || k1.localeCompare(k2))[0]?.[0];
  };

  for (const [id, decision] of entries) {
    const left = resolve(decision.a);
    const right = resolve(decision.b);
    sides.set(id, [left, right]);
    if (left && right && left !== right) {
      const pair = pairId(left, right);
      const previous = byPair.get(pair);
      if (!previous || previous.decision.decidedAt < decision.decidedAt) byPair.set(pair, { id, decision });
    }
  }

  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const up = parent.get(key) ?? key;
    if (up === key) return key;
    const root = find(up);
    parent.set(key, root);
    return root;
  };
  const different = [...byPair.values()].filter(({ decision }) => decision.verdict === "different").map(({ id }) => sides.get(id)!);
  const same = [...byPair.values()].filter(({ decision }) => decision.verdict === "same")
    .sort((x, y) => x.decision.decidedAt.localeCompare(y.decision.decidedAt));
  for (const { id } of same) {
    const [left, right] = sides.get(id)!;
    const a = find(left!);
    const b = find(right!);
    if (a === b) continue;
    const separated = different.some(([x, y]) => {
      const [rx, ry] = [find(x!), find(y!)];
      return (rx === a && ry === b) || (rx === b && ry === a);
    });
    if (separated) conflicts.add(id);
    else parent.set(a, b);
  }

  const groups = new Map<string, string[]>();
  for (const key of new Set([...parent.keys(), ...parent.values()])) {
    const root = find(key);
    groups.set(root, [...(groups.get(root) ?? []), key]);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // A stable lead: an active listing if there is one, then the smallest key.
    const lead = [...members].sort((p, q) =>
      Number(isSold(byKey.get(p)!)) - Number(isSold(byKey.get(q)!)) || p.localeCompare(q))[0];
    for (const member of members) leadOf.set(member, lead);
  }
  return { sides, byPair, leadOf, conflicts };
}

/** The listing a key is shown as: its group's lead, or itself. */
export const shownKey = (resolved: Pick<ResolvedDecisions, "leadOf">, key: string): string => resolved.leadOf.get(key) ?? key;

/**
 * Apply "same" answers: each confirmed group is shown as its lead listing,
 * carrying every member's ads and photos, the earliest first sighting and
 * the latest last one. When nothing is merged the input array itself is
 * returned, and listings no answer touches keep their identity, so memoised
 * views do not re-render.
 */
export function applySameDecisions(
  listings: readonly EnrichedListing[],
  resolved: Pick<ResolvedDecisions, "leadOf">,
): readonly EnrichedListing[] {
  if (resolved.leadOf.size === 0) return listings;
  const members = new Map<string, EnrichedListing[]>();
  for (const listing of listings) {
    const lead = resolved.leadOf.get(listingKey(listing));
    if (lead) members.set(lead, [...(members.get(lead) ?? []), listing]);
  }
  const shown: EnrichedListing[] = [];
  for (const listing of listings) {
    const key = listingKey(listing);
    const lead = resolved.leadOf.get(key);
    if (!lead) shown.push(listing);
    else if (lead === key) shown.push(mergeGroup(listing, members.get(lead)!));
  }
  return shown;
}

function mergeGroup(lead: EnrichedListing, members: readonly EnrichedListing[]): EnrichedListing {
  const references = new Map<string, NonNullable<EnrichedListing["sourceListings"]>[number]>();
  const photos = new Map<string, NonNullable<EnrichedListing["photos"]>[number]>();
  for (const member of [lead, ...members.filter((other) => other !== lead)]) {
    for (const reference of sourceListings(member)) {
      references.set(listingAdKey(reference.source, reference.url, reference.id), reference);
    }
    for (const photo of member.photos ?? []) photos.set(photo.url, photo);
  }
  return {
    ...lead,
    sourceListings: [...references.values()],
    ...(photos.size ? { photos: [...photos.values()] } : {}),
    firstSeenAt: pick(members.map((member) => member.firstSeenAt), "earliest"),
    lastSeenAt: pick(members.map((member) => member.lastSeenAt), "latest"),
  };
}

/** The earliest or latest ISO time; a null (predates tracking) only when no time is known. */
function pick(values: (string | null | undefined)[], which: "earliest" | "latest"): string | null | undefined {
  const known = values.filter((value): value is string => typeof value === "string").sort();
  if (known.length) return which === "earliest" ? known[0] : known[known.length - 1];
  return values.find((value) => value === null);
}

/**
 * Per-listing user state (marks, notes) keyed by listingKey, seen through the
 * confirmed groups: a lead without its own entry shows an absorbed member's.
 * Returns the input when nothing carries over.
 */
export function carryToLeads<T>(
  values: Readonly<Record<string, T>>,
  leadOf: ReadonlyMap<string, string>,
): Readonly<Record<string, T>> {
  let carried: Record<string, T> | undefined;
  for (const [member, lead] of leadOf) {
    if (member === lead || !(member in values) || lead in (carried ?? values)) continue;
    carried ??= { ...values };
    carried[lead] = values[member];
  }
  return carried ?? values;
}

/** Still to review: nobody answered it, and other answers have not already made it one home. */
export function isPendingPair(pair: PossibleDuplicate, resolved: Pick<ResolvedDecisions, "byPair" | "leadOf">): boolean {
  const [a, b] = pair.keys;
  return !resolved.byPair.has(pairId(a, b)) && shownKey(resolved, a) !== shownKey(resolved, b);
}
