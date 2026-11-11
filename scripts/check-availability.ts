/**
 * Find properties that every portal has taken down ("rented out").
 *
 *   npm run check:availability                      most-likely-gone first, 25 properties
 *   npm run check:availability -- --limit 60 --city Soka --min-size 60
 *   npm run check:availability -- --url <ad url>    check one ad (and its property's other ads)
 *   npm run check:availability -- --keys-file keys.json --portals suumo,athome
 *                                                   every SUUMO and AtHome ad of these dashboard keys
 *   npm run check:availability -- --watch           the refresh stage: the top-scoring homes most overdue for a
 *                                                   check, inside a page-load budget (`availability` in
 *                                                   collectors.config.json; --top N, --stale-days N, --max-loads N)
 *   npm run check:availability -- --dry-run         list what would be visited; no browser
 *
 * Every visit goes through the headed Playwright browser, never plain HTTP. A property is checked cheapest portal
 * first and the walk stops at the first live ad. `--watch` asks SUUMO and AtHome first where a home has
 * ads there (they take an ad down once the home is let), and pauses a portal that shows a verification
 * page instead of loading more of it. Results go to
 * data/availability.json; run `npm run data:web` to publish them. Set
 * ATHOME_VERIFY_WAIT_SECONDS to give yourself time to pass a verification page.
 */
import { readFile } from "node:fs/promises";
import { listingKey } from "../src/domain/listingKey";
import { join } from "node:path";
import { adKey, DELISTING_PORTALS, withAvailability } from "../src/domain/availability";
import { deduplicateListings, sourceListings } from "../src/domain/listingDedup";
import type { EnrichedListing, RawListing } from "../src/domain/types";
import { DATA_DIR } from "../src/storage/json/dataStore";
import { readAvailability, recordAvailability } from "../src/storage/json/availabilityStore";
import { describePropertySync } from "../src/data-layer/properties/service";
import { syncCurrentProperties } from "../src/storage/json/propertyEvidence";
import { AdPageVisitor } from "../src/collectors/availability/adPageVisitor";
import { checkProperty } from "../src/collectors/availability/checkProperty";
import { selectCandidates } from "../src/collectors/availability/selectCandidates";
import { selectWatchlist, type WatchCandidate } from "../src/collectors/availability/watchlist";
import { readWatchConfig } from "../src/collectors/availability/watchConfig";
import { VisitGuard } from "../src/collectors/availability/visitGuard";
import { LISTINGS_FILE, REFERENCE_FILE, snapshotFromFiles } from "../src/api/snapshot";
import { decodeRequest } from "../src/domain/recommend/request";
import { recommend } from "../src/domain/recommend/pipeline";
import { WEB_PUBLISH_DIR } from "../src/node/dataPaths";
import { positiveInteger } from "../src/collectors/shared/pageBudget";

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const flags = (name: string) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []));
const number = (name: string) => (flag(name) == null ? undefined : Number(flag(name)));

const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)suumo\.jp$/, "suumo"], [/(^|\.)athome\.co\.jp$/, "athome"], [/(^|\.)myhome\.nifty\.com$/, "nifty"],
  [/(^|\.)roomspot\.net$/, "roomspot"], [/(^|\.)realestate\.yahoo\.co\.jp$/, "yahoo"],
];
/**
 * Each published home's score under the watch criteria, by dashboard key. It is
 * the recommendations pipeline over the published files, so "top" here is the
 * dashboard's ranking for the same criteria. Homes the criteria filter out, and
 * homes not published yet, have no score.
 */
async function watchScores(criteria: Record<string, unknown>): Promise<Map<string, number>> {
  const { context } = snapshotFromFiles(await readFile(join(WEB_PUBLISH_DIR, LISTINGS_FILE)), await readFile(join(WEB_PUBLISH_DIR, REFERENCE_FILE)));
  const decoded = decodeRequest(criteria, context.decode);
  if (!decoded.ok) {
    throw new Error(`availability.criteria in collectors.config.json: ${decoded.errors.map((error) => `${error.path || "request"} ${error.message}`).join("; ")}`);
  }
  const { config, filters, selection, state } = decoded.value.criteria;
  const { ranked } = recommend({
    listings: context.listings, index: context.index, config, filters, selection,
    marks: state.marks, duplicateDecisions: state.duplicateDecisions, availabilityMarks: state.availabilityMarks,
  }, { hints: false });
  return new Map(ranked.flatMap(({ listing, score }) => (score.total == null ? [] : [[listingKey(listing), score.total] as [string, number]])));
}

const sourceOf = (url: string) => HOSTS.find(([pattern]) => pattern.test(new URL(url).hostname))?.[1];

// Same merge as the web publish step, so a "property" here is a property on the dashboard.
const listings = deduplicateListings(JSON.parse(await readFile(join(DATA_DIR, "listings.json"), "utf8")) as EnrichedListing[]) as EnrichedListing[];
const known = await readAvailability();
const now = new Date();

// `--portals suumo,athome` visits every ad of those portals instead of stopping at the first live one.
const portals = flag("--portals")?.split(",").map((source) => source.trim()).filter(Boolean);
const keysFile = flag("--keys-file");
// `--watch`: the homes a refresh re-checks, within a page-load budget.
const watchMode = argv.includes("--watch");
const watch = readWatchConfig();
const maxLoads = positiveInteger(flag("--max-loads"), watchMode ? watch.pageLoads : Number.MAX_SAFE_INTEGER, 0);
const watched = new Map<RawListing, WatchCandidate<EnrichedListing>>();

let targets: RawListing[];
const urls = flags("--url");
if (keysFile) {
  // A JSON array of dashboard keys (as in a ranking's results[].key), or one key per line.
  const text = await readFile(keysFile, "utf8");
  const keys = new Set<string>(text.trim().startsWith("[") ? JSON.parse(text) : text.split("\n").map((line) => line.trim()).filter(Boolean));
  targets = listings.filter((listing) => keys.has(listingKey(listing)));
  const missing = keys.size - targets.length;
  if (missing) console.log(`${missing} key${missing === 1 ? "" : "s"} matched no current property`);
} else if (urls.length) {
  targets = urls.map((url) => {
    const source = sourceOf(url);
    if (!source) throw new Error(`Unsupported portal URL: ${url}`);
    const key = adKey(source, url);
    return listings.find((listing) => sourceListings(listing).some((ad) => adKey(ad.source, ad.url, ad.id) === key))
      ?? ({ name: url, address: "", rent: 0, layout: null, sizeM2: null, builtYear: null, stationWalkMin: null, url, source } as RawListing);
  });
} else if (watchMode) {
  const scores = await watchScores(watch.criteria);
  const top = positiveInteger(flag("--top"), watch.top);
  const due = selectWatchlist(listings, known, {
    top, staleDays: number("--stale-days") ?? watch.staleDays, now, scoreOf: (listing) => scores.get(listingKey(listing)) ?? null,
  });
  // Every due home costs at least one page load, so the budget also caps how many can be reached.
  targets = due.slice(0, maxLoads).map((candidate) => candidate.listing);
  for (const candidate of due) watched.set(candidate.listing, candidate);
  console.log(`${due.length} of the top ${top} homes are due a check (budget: ${maxLoads} page loads)`);
} else {
  targets = selectCandidates(listings, known, {
    limit: positiveInteger(flag("--limit"), 25), staleDays: number("--stale-days") ?? 3, now,
    recheckGone: argv.includes("--recheck-gone"), city: flag("--city"), minSizeM2: number("--min-size"), maxRent: number("--max-rent"),
  });
}

console.log(`${targets.length} propert${targets.length === 1 ? "y" : "ies"} to check${argv.includes("--dry-run") ? " (dry run: no browser)" : ""}`);
if (argv.includes("--dry-run")) {
  for (const listing of targets) {
    const candidate = watched.get(listing);
    const lead = candidate ? `#${String(candidate.rank).padEnd(3)} ${candidate.score.toFixed(1)} · confirmed ${candidate.confirmedAt?.slice(0, 10) ?? "never"}` : listing.lastSeenAt?.slice(0, 10) ?? "never seen";
    console.log(`  ${listing.name} · ${lead} · ${sourceListings(listing).map((ad) => ad.source).join("+")}`);
  }
  process.exit(0);
}

const visitor = new AdPageVisitor();
const guard = new VisitGuard(maxLoads);
let rentedOut = 0, stillListed = 0, unresolved = 0, checked = 0, recorded = 0;
try {
  for (const listing of targets) {
    if (guard.exhausted) break;
    const loadsBefore = guard.loads;
    // A watched home with SUUMO or AtHome ads is settled by those alone, and by the first live one.
    const delisting = watchMode && sourceListings(listing).some((ad) => ad.url && DELISTING_PORTALS.includes(ad.source));
    const scope = delisting ? DELISTING_PORTALS : portals;
    const check = await checkProperty(withAvailability(listing, known), known, {
      visit: async (ad) => {
        guard.admit(ad.source);
        return visitor.visit(ad);
      },
      now: () => new Date().toISOString(), delayMs: 2_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }, { portals: scope, stopAtLive: delisting });
    guard.record(check.ads);
    await recordAvailability(check.records);
    recorded += check.records.length;
    checked++;
    const allGone = check.ads.length > 0 && check.ads.every((ad) => ad.verdict === "gone" || ad.verdict === "known-gone");
    const state = check.rentedOut ? "RENTED OUT"
      : scope && allGone ? "GONE" : check.ads.some((ad) => ad.verdict === "listed") ? "listed" : check.ads.length ? "unresolved" : "no ads";
    if (check.rentedOut || state === "GONE") rentedOut++; else if (state === "listed") stillListed++; else unresolved++;
    console.log(`${state.padEnd(10)} ${listing.name}`);
    for (const ad of check.ads) console.log(`             ${ad.source.padEnd(8)} ${ad.verdict.padEnd(10)} ${ad.evidence}`);
    // Nothing was loaded for a home whose portals are all paused: no need to wait.
    if (guard.loads > loadsBefore) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await visitor.close();
}
console.log(describePropertySync(await syncCurrentProperties("check:availability")));
const paused = [...guard.pausedPortals].map(([source, reason]) => `${source} paused after ${reason}`);
const goneLabel = watchMode ? "Gone (everywhere, or from SUUMO and AtHome)" : portals ? `Gone from ${portals.join("/")}` : "Rented out";
console.log(`\n${goneLabel}: ${rentedOut} · still listed: ${stillListed} · unresolved or no such ads: ${unresolved}. Publish with \`npm run data:web\`.`);
// One line for `npm run refresh`, which prints it in place of the stage's output.
console.log(`Stage summary: ${guard.loads} page loads · ${checked} homes checked · ${rentedOut} gone · ${stillListed} still listed · ${unresolved} unresolved${paused.length ? ` · ${paused.join(", ")}` : ""}`);
// Pages were loaded and not one could be read: the browser or the network failed, not the homes.
if (guard.loads > 0 && recorded === 0) {
  console.error("No ad page could be read; nothing was recorded.");
  process.exitCode = 2;
}
