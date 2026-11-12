/**
 * Score the duplicate matcher against pairs whose answer is known.
 *
 *   npm run dedup:eval
 *
 * Nobody labelled these pairs by hand; the portals did:
 *
 *   SAME       two SUUMO ads with one room code (`jnc_…`). SUUMO gives each
 *              room one code and each agency's ad for it a `bc`, so these are
 *              one room advertised by two agencies. A third portal's ad that
 *              agrees exactly with one of them is the same room as the other
 *              too, which gives cross-portal pairs with real-world differences.
 *   DIFFERENT  two UR rooms in one estate, or two SUUMO room codes in one
 *              building, that differ in floor or clearly in rent; and, the
 *              same way, a third portal's ad against the other room.
 *   UNKNOWN    two SUUMO room codes in one building on the same floor at the
 *              same rent. SUUMO may have missed that they are one room, or
 *              they are twin rooms. Counted, never scored.
 *
 * Each set is scored twice: on the two ads alone ("pair"), and on whether the
 * build puts them in one row ("build"), where an ad can reach a row through
 * other ads. The matcher should merge every SAME pair and no DIFFERENT pair.
 * Run this before and after changing `isSameUnit` to see what the change did.
 */
import { listSources } from "../src/storage/json/dataStore";
import {
  comparableArea,
  comparableName,
  deduplicateListings,
  isSameUnit,
  sharesAdIdentity,
  sourceListings,
} from "../src/domain/listingDedup";
import type { RawListing } from "../src/domain/types";

type Pair = [RawListing, RawListing];

const roomCode = (listing: RawListing) => listing.url?.match(/\/jnc_(\d+)/)?.[1];
const building = (listing: RawListing) => `${comparableName(listing.name)}|${comparableArea(listing.address)}`;
const floorNumber = (listing: RawListing): number | null => {
  const match = (listing.building?.floor ?? "").normalize("NFKC").match(/^(\d+)階$/);
  return match ? Number(match[1]) : null;
};
const floorsDiffer = (a: RawListing, b: RawListing) => {
  const [x, y] = [floorNumber(a), floorNumber(b)];
  return x != null && y != null && x !== y;
};
const rentGap = (a: RawListing, b: RawListing) => Math.abs(a.rent - b.rent) / Math.min(a.rent, b.rent);
const clearlyDifferent = (a: RawListing, b: RawListing) => floorsDiffer(a, b) || rentGap(a, b) > 0.05;

/** Agrees on every fact a list page prints: the anchor that carries a room code to another portal. */
const agreesExactly = (a: RawListing, b: RawListing) =>
  a.source !== b.source && a.rent === b.rent && a.layout === b.layout && !floorsDiffer(a, b) &&
  a.sizeM2 != null && b.sizeM2 != null && Math.abs(a.sizeM2 - b.sizeM2) < 0.011;

function groupBy<T>(items: readonly T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k == null) continue;
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

function* pairsOf<T>(items: readonly T[]): Generator<[T, T]> {
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) yield [items[i], items[j]];
}

/** The matcher's answer for two ads on their own. */
const matches = ([a, b]: Pair) => sharesAdIdentity(a, b) || isSameUnit(a, b);

function report(label: string, pairs: Pair[], want: boolean, grouped: (pair: Pair) => boolean): void {
  const count = (test: (pair: Pair) => boolean) => {
    const merged = pairs.filter(test).length;
    const right = want ? merged : pairs.length - merged;
    return `${String(right).padStart(5)} ${(pairs.length ? ((100 * right) / pairs.length).toFixed(1) : "–").padStart(5)}%`;
  };
  console.log(`  ${label.padEnd(46)} ${String(pairs.length).padStart(5)}   ${count(matches)}   ${count(grouped)}`);
}

async function main(): Promise<void> {
  const sources = await listSources();
  const ads = sources.flatMap((source) => source.listings).filter((ad) => ad.sizeM2 != null && ad.rent > 0);
  const suumo = ads.filter((ad) => ad.source === "suumo");
  const others = groupBy(ads.filter((ad) => ad.source !== "suumo" && ad.source !== "ur"), building);

  const sameSuumo: Pair[] = [];
  const sameAcross: Pair[] = [];
  for (const room of groupBy(suumo, roomCode).values()) {
    for (const pair of pairsOf(room)) sameSuumo.push(pair);
    if (room.length < 2) continue;
    for (const anchor of room) {
      for (const other of others.get(building(anchor)) ?? []) {
        if (!agreesExactly(anchor, other)) continue;
        for (const sibling of room) if (sibling !== anchor && !agreesExactly(sibling, other)) sameAcross.push([other, sibling]);
      }
    }
  }

  const differentSuumo: Pair[] = [];
  const differentAcross: Pair[] = [];
  const unknown: Pair[] = [];
  for (const rooms of groupBy(suumo, building).values()) {
    for (const [a, b] of pairsOf(rooms)) {
      if (roomCode(a) === roomCode(b)) continue;
      if (!clearlyDifferent(a, b)) {
        if (a.rent === b.rent) unknown.push([a, b]);
        continue;
      }
      differentSuumo.push([a, b]);
      for (const other of others.get(building(a)) ?? []) {
        if (agreesExactly(a, other) && !agreesExactly(b, other)) differentAcross.push([other, b]);
        if (agreesExactly(b, other) && !agreesExactly(a, other)) differentAcross.push([other, a]);
      }
    }
  }
  const differentUr: Pair[] = [];
  for (const estate of groupBy(ads.filter((ad) => ad.source === "ur"), (ad) => ad.name).values()) {
    for (const [a, b] of pairsOf(estate)) if (clearlyDifferent(a, b)) differentUr.push([a, b]);
  }

  // What the build ends with: ads reach one row through other ads too.
  const rowOf = new Map<RawListing, number>();
  const byAd = new Map(ads.map((ad) => [`${ad.source}|${ad.id}|${ad.url}`, ad]));
  deduplicateListings(ads).forEach((row, index) => {
    for (const ad of sourceListings(row)) {
      const member = byAd.get(`${ad.source}|${ad.id}|${ad.url}`);
      if (member) rowOf.set(member, index);
    }
  });
  const grouped = ([a, b]: Pair) => rowOf.get(a) != null && rowOf.get(a) === rowOf.get(b);

  const head = (title: string, verb: string) =>
    console.log(`${title.padEnd(48)} pairs   ${`pair ${verb}`.padEnd(14)} ${`build ${verb}`}`);
  console.log(`${ads.length} portal ads → ${new Set(rowOf.values()).size} rows\n`);
  head("Known to be the same room", "merged");
  report("SUUMO, one room code, two agencies", sameSuumo, true, grouped);
  report("another portal's ad ↔ that room's other agency", sameAcross, true, grouped);
  console.log();
  head("Known to be different rooms", "apart");
  report("SUUMO, one building, two room codes", differentSuumo, false, grouped);
  report("another portal's ad ↔ the other room", differentAcross, false, grouped);
  report("UR, one estate, two rooms", differentUr, false, grouped);
  console.log("\nNot known (same building, floor and rent; two SUUMO room codes):");
  console.log(`  ${unknown.length} pairs, ${unknown.filter(matches).length} matched, ${unknown.filter(grouped).length} in one row`);

  const missed = [...sameSuumo, ...sameAcross].filter((pair) => !grouped(pair));
  if (process.argv.includes("--missed")) {
    console.log("\nSame room, in two rows:");
    for (const [a, b] of missed) {
      console.log(`  ${a.source} ${a.name} ¥${a.rent} ${a.layout} ${a.sizeM2}㎡ ${a.builtYear} ${a.building?.floor ?? "?"}`);
      console.log(`  ${b.source} ${b.name} ¥${b.rent} ${b.layout} ${b.sizeM2}㎡ ${b.builtYear} ${b.building?.floor ?? "?"}\n`);
    }
  }
}

void main();
