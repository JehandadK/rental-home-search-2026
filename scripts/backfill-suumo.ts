/**
 * Backfills structured fields on SUUMO records captured before the scraper
 * emitted them, reusing the `notes` string it already wrote
 * ("築5年・1階・管理費込").
 *
 * The admin fee is not recoverable from notes — SUUMO folded it into `rent`
 * — so it stays null (unknown) rather than being invented. A fresh
 * `npm run scrape` fills it in properly.
 *
 * Run with: npm run data:backfill
 */
import { ShrinkGuardError, readSource, writeSource } from "./lib/dataStore";
import { parseFloors } from "./lib/parseJa";
import type { RawListing } from "../src/types";

/** "築5年・1階・管理費込" → the floor segment, if present. */
function floorFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const segment = notes.split("・").find((part) => /階/.test(part) && !/階建/.test(part));
  return segment?.trim() || null;
}

function backfill(listing: RawListing): RawListing {
  const floor = listing.building?.floor ?? floorFromNotes(listing.notes);
  const { totalFloors } = parseFloors(floor ?? undefined);
  const next: RawListing = { ...listing };

  if (floor) {
    next.building = { ...listing.building, floor, ...(totalFloors ? { totalFloors } : {}) };
  }
  // `管理費込` confirms the fee is inside `rent`, but not its value.
  if (listing.notes?.includes("管理費込") && listing.costs?.adminFeeYen === undefined) {
    next.costs = { ...listing.costs, adminFeeYen: null };
  }
  return next;
}

async function main(): Promise<void> {
  const source = await readSource("suumo");
  if (!source) {
    console.log("No suumo source file — run `npm run scrape` first.");
    return;
  }

  const listings = source.listings.map(backfill);
  const withFloor = listings.filter((l) => l.building?.floor).length;

  await writeSource({
    source: source.source,
    scrapedAt: source.scrapedAt,
    provenance: { ...source.provenance, backfilledAt: new Date().toISOString() },
    listings,
  }, { expectedRevision: source.revision ?? null });

  console.log(`Backfilled ${listings.length} suumo listings: ${withFloor} now carry a structured floor.`);
  console.log("Admin fee stays unknown until the next `npm run scrape`.");
  console.log("\nNext: npm run data:build && npm run enrich");
}

main().catch((err) => {
  if (err instanceof ShrinkGuardError) {
    console.error(`\n${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
