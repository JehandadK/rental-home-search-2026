/**
 * Find properties that every portal has taken down ("rented out").
 *
 *   npm run check:availability                      most-likely-gone first, 25 properties
 *   npm run check:availability -- --limit 60 --city Soka --min-size 60
 *   npm run check:availability -- --url <ad url>    check one ad (and its property's other ads)
 *   npm run check:availability -- --dry-run         list what would be visited; no browser
 *
 * Every visit goes through the headed browser (BROWSER_DRIVER=playwright, else
 * the Chrome bridge), never plain HTTP. A property is checked cheapest portal
 * first and the walk stops at the first live ad. Results go to
 * data/availability.json; run `npm run data:web` to publish them. Set
 * ATHOME_VERIFY_WAIT_SECONDS to give yourself time to pass a verification page.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adKey, withAvailability } from "../src/domain/availability";
import { deduplicateListings, sourceListings } from "../src/domain/listingDedup";
import type { EnrichedListing, RawListing } from "../src/domain/types";
import { DATA_DIR } from "../src/storage/json/dataStore";
import { readAvailability, recordAvailability } from "../src/storage/json/availabilityStore";
import { describePropertySync } from "../src/data-layer/properties/service";
import { syncCurrentProperties } from "../src/storage/json/propertyEvidence";
import { AdPageVisitor } from "../src/collectors/availability/adPageVisitor";
import { checkProperty } from "../src/collectors/availability/checkProperty";
import { selectCandidates } from "../src/collectors/availability/selectCandidates";
import { positiveInteger } from "../src/collectors/shared/pageBudget";

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const flags = (name: string) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []));
const number = (name: string) => (flag(name) == null ? undefined : Number(flag(name)));

const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)suumo\.jp$/, "suumo"], [/(^|\.)athome\.co\.jp$/, "athome"], [/(^|\.)myhome\.nifty\.com$/, "nifty"],
  [/(^|\.)roomspot\.net$/, "roomspot"], [/(^|\.)realestate\.yahoo\.co\.jp$/, "yahoo"],
];
const sourceOf = (url: string) => HOSTS.find(([pattern]) => pattern.test(new URL(url).hostname))?.[1];

// Same merge as the web publish step, so a "property" here is a property on the dashboard.
const listings = deduplicateListings(JSON.parse(await readFile(join(DATA_DIR, "listings.json"), "utf8")) as EnrichedListing[]) as EnrichedListing[];
const known = await readAvailability();
const now = new Date();

let targets: RawListing[];
const urls = flags("--url");
if (urls.length) {
  targets = urls.map((url) => {
    const source = sourceOf(url);
    if (!source) throw new Error(`Unsupported portal URL: ${url}`);
    const key = adKey(source, url);
    return listings.find((listing) => sourceListings(listing).some((ad) => adKey(ad.source, ad.url, ad.id) === key))
      ?? ({ name: url, address: "", rent: 0, layout: null, sizeM2: null, builtYear: null, stationWalkMin: null, url, source } as RawListing);
  });
} else {
  targets = selectCandidates(listings, known, {
    limit: positiveInteger(flag("--limit"), 25), staleDays: number("--stale-days") ?? 3, now,
    recheckGone: argv.includes("--recheck-gone"), city: flag("--city"), minSizeM2: number("--min-size"), maxRent: number("--max-rent"),
  });
}

console.log(`${targets.length} propert${targets.length === 1 ? "y" : "ies"} to check${argv.includes("--dry-run") ? " (dry run: no browser)" : ""}`);
if (argv.includes("--dry-run")) {
  for (const listing of targets) console.log(`  ${listing.name} · ${listing.lastSeenAt?.slice(0, 10) ?? "never seen"} · ${sourceListings(listing).map((ad) => ad.source).join("+")}`);
  process.exit(0);
}

const visitor = new AdPageVisitor();
let rentedOut = 0, stillListed = 0, unresolved = 0;
try {
  for (const listing of targets) {
    const check = await checkProperty(withAvailability(listing, known), known, {
      visit: (ad) => visitor.visit(ad), now: () => new Date().toISOString(), delayMs: 2_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    await recordAvailability(check.records);
    const state = check.rentedOut ? "RENTED OUT" : check.ads.some((ad) => ad.verdict === "listed") ? "listed" : "unresolved";
    if (check.rentedOut) rentedOut++; else if (state === "listed") stillListed++; else unresolved++;
    console.log(`${state.padEnd(10)} ${listing.name}`);
    for (const ad of check.ads) console.log(`             ${ad.source.padEnd(8)} ${ad.verdict.padEnd(10)} ${ad.evidence}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await visitor.close();
}
console.log(describePropertySync(await syncCurrentProperties("check:availability")));
console.log(`\nRented out: ${rentedOut} · still listed: ${stillListed} · unresolved: ${unresolved}. Publish with \`npm run data:web\`.`);
