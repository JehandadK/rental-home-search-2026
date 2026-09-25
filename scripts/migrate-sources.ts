/**
 * One-time migration to the per-source data store.
 *
 * Splits the existing listings_raw.json into src/data/sources/<source>.json
 * so every source owns its own file. Safe to re-run: sources that already
 * have a file are left alone.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RAW_PATH, readSource, writeSource } from "./lib/dataStore";
import type { RawListing } from "../src/types";

async function main(): Promise<void> {
  if (!existsSync(RAW_PATH)) {
    console.log("No listings_raw.json to migrate.");
    return;
  }
  const listings = JSON.parse(await readFile(RAW_PATH, "utf8")) as RawListing[];
  const bySource = new Map<string, RawListing[]>();
  for (const listing of listings) {
    const key = listing.source || "unknown";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(listing);
  }

  for (const [source, group] of bySource) {
    if (await readSource(source)) {
      console.log(`  ${source}: source file already exists, skipped`);
      continue;
    }
    await writeSource({
      source,
      scrapedAt: new Date().toISOString(),
      provenance: { migratedFrom: "listings_raw.json", note: "captured before the per-source store existed" },
      listings: group,
    });
    console.log(`  ${source}: ${group.length} listings → src/data/sources/${source}.json`);
  }
  console.log("\nNext: npm run data:build");
}

void main();
