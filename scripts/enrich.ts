/** Address-keyed, checkpointed geocoding; no repeated requests for shared addresses. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { enrichListing } from "../src/domain/enrichListing";
import { geocodeAddress } from "../src/integrations/geocode";
import { DATA_DIR, atomicWriteJson } from "./lib/dataStore";
import { withFileLock } from "./lib/jsonFile";
import { addressKey, cachedGeocode, seedGeocodes, type GeocodeCache } from "./lib/geocodeCache";
import type { EnrichedListing, RawListing } from "../src/domain/types";

const OUT = join(DATA_DIR, "listings.json");
const CACHE = join(DATA_DIR, "geocodes.json");
async function optional<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(join(DATA_DIR, "listings_raw.json"), "utf8")) as RawListing[];
  const cache: GeocodeCache = process.argv.includes("--regeocode") ? {} : seedGeocodes(
    await optional<EnrichedListing[]>(OUT, []), await optional<GeocodeCache>(CACHE, {}),
  );
  const enriched: EnrichedListing[] = [];
  let reused = 0, queriedAddresses = 0, failed = 0;
  const errors = new Set<string>();
  for (const listing of raw) {
    let entry = cachedGeocode(cache, listing.address);
    if (entry) reused++;
    else if (!errors.has(addressKey(listing.address))) {
      try {
        queriedAddresses++;
        // HTTP failures are not negative address matches and are never cached.
        const value = await geocodeAddress(listing.address);
        entry = { value, checkedAt: new Date().toISOString() };
        cache[addressKey(listing.address)] = entry;
        await atomicWriteJson(CACHE, cache);
      } catch {
        failed++; errors.add(addressKey(listing.address));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    enriched.push(entry?.value ? enrichListing(listing, entry.value, entry.value.matched) : { ...listing, geocoded: false });
  }
  await atomicWriteJson(CACHE, cache);
  await atomicWriteJson(OUT, enriched);
  console.log(`Enriched ${raw.length}: ${reused} address-cache hits; ${queriedAddresses} addresses queried; ${failed} transient failures; ${enriched.filter((l) => !l.geocoded).length} unresolved.`);
  if (failed) process.exitCode = 2;
}

// Protect the cache's long-running read/modify/write cycle from a second
// standalone enrich invocation; atomic cache writes alone cannot prevent lost updates.
await withFileLock(join(DATA_DIR, "geocode-enrichment"), main);
