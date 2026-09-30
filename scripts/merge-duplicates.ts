/**
 * Cross-portal duplicate merger.
 *
 * The same room is often advertised on several portals (athome, SUUMO,
 * nifty, roomspot) under slightly different names. `npm run data:build`
 * already collapses those ads via src/domain/listingDedup.ts; this CLI makes
 * that step visible and runnable on its own:
 *
 *   npm run dedup            report which portal ads merge, and which almost
 *                            do (with the reason they are kept apart)
 *   npm run dedup -- --apply rebuild listings_raw.json from the source files,
 *                            applying the merge for real
 *
 * Source files under data/sources/ stay owned by their importers — this
 * script never edits them; --apply delegates to the normal build pipeline
 * (backups, lifecycle reconciliation, manifest).
 */
import { buildRaw, listSources } from "../src/storage/json/dataStore";
import type { RawListing } from "../src/domain/types";
import { deduplicateListings, isSameProperty, sourceListings } from "../src/domain/listingDedup";

const yen = new Intl.NumberFormat("ja-JP");

/** Group the surviving records that carry more than one portal ad. */
function mergedGroups(merged: RawListing[]): RawListing[] {
  return merged.filter((listing) => sourceListings(listing).length > 1);
}

/**
 * Pairs that look like the same unit (rent, area, layout all agree) yet were
 * NOT merged, with the gate that blocked them. These are candidates for
 * tuning the matcher — or genuinely different rooms (e.g. another floor).
 */
function nearMisses(listings: RawListing[]): { a: RawListing; b: RawListing; reason: string }[] {
  const byUnit = new Map<string, RawListing[]>();
  for (const listing of listings) {
    if (listing.rent == null || listing.sizeM2 == null) continue;
    const key = `${Math.round(listing.rent / 500)}|${Math.round(listing.sizeM2 * 5)}|${listing.layout ?? ""}`;
    const bucket = byUnit.get(key) ?? [];
    bucket.push(listing);
    byUnit.set(key, bucket);
  }

  const misses: { a: RawListing; b: RawListing; reason: string }[] = [];
  for (const bucket of byUnit.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const [a, b] = [bucket[i], bucket[j]];
        if (a.source === b.source || isSameProperty(a, b)) continue;
        const rentOk = Math.abs(a.rent - b.rent) <= Math.max(1_000, Math.min(a.rent, b.rent) * 0.01);
        const sizeOk = Math.abs((a.sizeM2 ?? 0) - (b.sizeM2 ?? 0)) <= 0.2;
        if (!rentOk || !sizeOk) continue;
        const floorA = (a.building?.floor ?? "").trim();
        const floorB = (b.building?.floor ?? "").trim();
        const reason =
          a.builtYear != null && b.builtYear != null && Math.abs(a.builtYear - b.builtYear) > 1
            ? `built year differs (${a.builtYear} vs ${b.builtYear})`
            : floorA && floorB && floorA !== "-" && floorB !== "-" && floorA !== floorB
              ? `floor differs (${floorA} vs ${floorB})`
              : "name and address both differ";
        misses.push({ a, b, reason });
      }
    }
  }
  return misses;
}

const short = (listing: RawListing) =>
  `¥${yen.format(listing.rent)} ${listing.layout ?? "?"} ${listing.sizeM2 ?? "?"}㎡` +
  `${listing.builtYear != null ? ` '${String(listing.builtYear).slice(2)}` : ""}` +
  `${listing.building?.floor ? ` ${listing.building.floor}` : ""}`;

async function report(): Promise<void> {
  const sources = await listSources();
  const captured = sources.flatMap((source) => source.listings);
  const merged = deduplicateListings(captured);
  const groups = mergedGroups(merged);

  console.log(
    `${captured.length} portal ads → ${merged.length} unique properties ` +
      `(${captured.length - merged.length} ads merged into ${groups.length} cross-listed properties)\n`,
  );

  console.log(`Cross-listed properties (primary portal first, per preference athome → suumo → nifty):`);
  for (const group of groups.sort((a, b) => a.rent - b.rent)) {
    const refs = sourceListings(group);
    console.log(`\n  ${group.name}  —  ${short(group)}`);
    for (const ref of refs) {
      console.log(`    ${ref.source.padEnd(9)} ${ref.url ?? "(no url)"}`);
    }
  }

  const misses = nearMisses(captured);
  console.log(`\n\nNear-misses kept apart (${misses.length}) — same rent/area/layout, one gate failed:`);
  for (const { a, b, reason } of misses.slice(0, 30)) {
    console.log(`\n  [${reason}]`);
    console.log(`    ${a.source.padEnd(9)} ${a.name}  (${a.address}, ${short(a)})`);
    console.log(`    ${b.source.padEnd(9)} ${b.name}  (${b.address}, ${short(b)})`);
  }
  if (misses.length > 30) console.log(`\n  … and ${misses.length - 30} more`);

  console.log(`\nRun \`npm run dedup -- --apply\` to rebuild listings_raw.json with these merges.`);
}

async function apply(): Promise<void> {
  const manifest = await buildRaw();
  console.log(`Built listings_raw.json — ${manifest.total} unique properties`);
  for (const entry of manifest.sources) {
    console.log(
      `  ${entry.source.padEnd(9)} ${String(entry.count).padStart(4)} ads → ${String(entry.contributed).padStart(4)} primary` +
        (entry.duplicatesDropped ? `, ${entry.duplicatesDropped} merged into other portals` : ""),
    );
  }
  if (manifest.lifecycle) {
    const { continued, added, sold, reactivated } = manifest.lifecycle;
    console.log(
      `\nLifecycle vs previous build: ${continued} still listed, ${added} NEW, ${sold} sold (kept)` +
        (reactivated ? `, ${reactivated} re-listed` : ""),
    );
  }
  console.log(`\nNext: npm run enrich && npm run data:web`);
}

if (process.argv.includes("--apply")) void apply();
else void report();
