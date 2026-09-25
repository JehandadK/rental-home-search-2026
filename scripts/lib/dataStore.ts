/**
 * Source-of-truth store for scraped listings.
 *
 * Design rule: **one file per source, owned exclusively by that source's
 * importer.** Nothing else may write it. `listings_raw.json` is a derived
 * build artifact — the union of every source file — so re-running one
 * scraper can never delete another source's data.
 *
 *   src/data/sources/suumo.json   ← npm run scrape        (owns SUUMO data)
 *   src/data/sources/nifty.json   ← npm run import:nifty  (owns Nifty data)
 *   src/data/sources/_manifest.json                       (build provenance)
 *        │
 *        └── npm run data:build → src/data/listings_raw.json (derived, do not edit)
 *                               → npm run enrich → listings.json
 *
 * Safety features:
 *   - atomic writes (temp file + rename) so a crash cannot truncate data
 *   - timestamped backups of every file before it is replaced
 *   - a shrink guard that refuses to persist a scrape that lost a large
 *     share of its listings (parser broke, site redesign, network failure)
 */
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawListing } from "../../src/types";
import { reconcileLifecycle, trackingKey, type LifecycleStats } from "./lifecycle";
import { deduplicateListings, isSameUnit } from "../../src/domain/listingDedup";
import { restoreObservedLifecycle } from "./observations";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "..", "..", "src", "data");
export const SOURCES_DIR = join(DATA_DIR, "sources");
export const BACKUP_DIR = join(DATA_DIR, ".backups");
export const RAW_PATH = join(DATA_DIR, "listings_raw.json");
export const MANIFEST_PATH = join(SOURCES_DIR, "_manifest.json");

/** Keep this many historical copies of each file. */
const BACKUPS_PER_FILE = 10;

/**
 * A scrape that returns less than this fraction of the previous run is
 * treated as a failure, not as data. Override with `force: true`.
 */
const SHRINK_GUARD = 0.5;

/** One source's data plus the provenance needed to judge it later. */
export interface SourceFile {
  source: string;
  scrapedAt: string;
  count: number;
  /**
   * True only when this source file represents a complete market snapshot.
   * Incremental discovery imports preserve unseen records but cannot prove
   * they are still live, so they set false. SOLD reconciliation runs only
   * when every source is complete, avoiding false delistings.
   * Missing/legacy completeness is unknown, never authoritative.
   */
  completeSnapshot?: boolean;
  /** Free-form capture details: search URLs, page counts, capture method. */
  provenance?: Record<string, unknown>;
  listings: RawListing[];
}

export interface ManifestEntry {
  source: string;
  scrapedAt: string;
  count: number;
  contributed: number;
  duplicatesDropped: number;
}

export interface BuildManifest {
  builtAt: string;
  total: number;
  sources: ManifestEntry[];
  /** Cross-source duplicates removed, keyed by the winning source. */
  duplicatesDropped: number;
  /** New/sold/reactivated reconciliation against the previous build. */
  lifecycle?: LifecycleStats;
}

/** Write JSON via temp file + rename so readers never see a partial file. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** Copy a file into .backups/ before it is replaced, pruning old copies. */
export async function backupFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = basename(path, ".json");
  const dest = join(BACKUP_DIR, `${name}-${stamp}.json`);
  await copyFile(path, dest);

  const stale = (await readdir(BACKUP_DIR))
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".json"))
    .sort()
    .slice(0, -BACKUPS_PER_FILE);
  for (const file of stale) await unlink(join(BACKUP_DIR, file));
  return dest;
}

export function sourcePath(source: string): string {
  return join(SOURCES_DIR, `${source}.json`);
}

export async function readSource(source: string): Promise<SourceFile | null> {
  const path = sourcePath(source);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as SourceFile;
}

export async function listSources(): Promise<SourceFile[]> {
  if (!existsSync(SOURCES_DIR)) return [];
  const files = (await readdir(SOURCES_DIR)).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  const sources: SourceFile[] = [];
  for (const file of files.sort()) {
    sources.push(JSON.parse(await readFile(join(SOURCES_DIR, file), "utf8")) as SourceFile);
  }
  return sources;
}

export class ShrinkGuardError extends Error {}

/**
 * Replace one source's data. Refuses to shrink the file dramatically
 * unless forced, so a broken parser cannot quietly wipe good data.
 */
export async function writeSource(
  file: Omit<SourceFile, "count">,
  options: { force?: boolean } = {},
): Promise<{ path: string; previousCount: number; backup: string | null }> {
  const previous = await readSource(file.source);
  const previousCount = previous?.count ?? 0;
  const nextCount = file.listings.length;

  if (!options.force && previousCount > 0 && nextCount < previousCount * SHRINK_GUARD) {
    throw new ShrinkGuardError(
      `Refusing to overwrite ${file.source}: ${nextCount} listings is a ${Math.round(
        (1 - nextCount / previousCount) * 100,
      )}% drop from ${previousCount}. The parser or the site probably changed. ` +
        `Existing data left untouched — re-run with --force if the drop is real.`,
    );
  }

  const path = sourcePath(file.source);
  const backup = await backupFile(path);
  const payload: SourceFile = { ...file, count: nextCount };
  await atomicWriteJson(path, payload);
  return { path, previousCount, backup };
}

/**
 * Combine every source file into `listings_raw.json`, dropping cross-source
 * duplicates, and record what happened in `_manifest.json`.
 *
 * The merged set is then reconciled against the previous build (see
 * lib/lifecycle.ts): listings that vanished from every source are kept and
 * marked "sold", and first-seen listings are stamped so the UI can
 * highlight them as new.
 */
export async function buildRaw(): Promise<BuildManifest> {
  const sources = await listSources();
  const captured: RawListing[] = [];
  const contributed = new Map<string, number>();
  const dropped = new Map<string, number>();

  for (const source of sources) {
    contributed.set(source.source, 0);
    dropped.set(source.source, 0);
  }

  for (const source of sources) captured.push(...source.listings);
  const merged = deduplicateListings(captured);

  for (const listing of merged) {
    contributed.set(listing.source, (contributed.get(listing.source) ?? 0) + 1);
    for (const reference of listing.sourceListings ?? []) {
      if (reference.source !== listing.source) {
        dropped.set(reference.source, (dropped.get(reference.source) ?? 0) + 1);
      }
    }
  }

  const previousRaw: RawListing[] = existsSync(RAW_PATH)
    ? (JSON.parse(await readFile(RAW_PATH, "utf8")) as RawListing[])
    : [];
  // Also clean up duplicates retained by older builds. Without this, lifecycle
  // reconciliation would append the losing historical ad back as SOLD.
  const previous = deduplicateListings(previousRaw);
  const builtAt = new Date().toISOString();
  // An incremental source cannot establish that an unseen property was sold.
  // Reconcile removals only after complete snapshots of every source; during
  // discovery builds we overlay current data onto prior history so nothing is
  // falsely marked sold. New listings are still detected and stamped.
  const allSourcesComplete = sources.length > 0 && sources.every((source) => source.completeSnapshot === true);
  // Dedup the overlay too: incremental history carries forward ads that may
  // now match a freshly merged group (e.g. a portal's repeat ad whose twin
  // was captured in an earlier crawl and has since joined a cross-source row).
  const reconciliationBase = allSourcesComplete
    ? merged
    : deduplicateListings(mergeWithPreviousHistory(previous, merged));
  const reconciled = reconcileLifecycle(previous, reconciliationBase, builtAt);
  // A historical ad absorbed into a fresher row above (e.g. a portal's repeat
  // ad whose price moved) would otherwise be appended once more as SOLD — a
  // ghost duplicate of a room that is still active. Retire those: their links
  // already live on inside the absorbing row's sourceListings.
  const activeRows = reconciled.listings.filter((listing) => listing.status !== "sold");
  reconciled.listings = reconciled.listings.filter(
    (listing) =>
      listing.status !== "sold" || !activeRows.some((active) => isSameUnit(active, listing)),
  );

  // A partial source file preserves unseen history, so treating every merged
  // record as "seen now" would incorrectly reactivate old SOLD properties and
  // advance lastSeenAt. Restore prior lifecycle state unless the record was
  // actually observed by this incremental crawl.
  restoreObservedLifecycle(reconciled.listings, previous, sources, allSourcesComplete);
  const lifecycle = lifecycleStats(previous, reconciled.listings);

  const manifest: BuildManifest = {
    builtAt,
    total: reconciled.listings.length,
    duplicatesDropped: [...dropped.values()].reduce((a, b) => a + b, 0),
    lifecycle,
    sources: sources.map((s) => ({
      source: s.source,
      scrapedAt: s.scrapedAt,
      count: s.count,
      contributed: contributed.get(s.source) ?? 0,
      duplicatesDropped: dropped.get(s.source) ?? 0,
    })),
  };

  await backupFile(RAW_PATH);
  await atomicWriteJson(RAW_PATH, reconciled.listings);
  await atomicWriteJson(MANIFEST_PATH, manifest);
  return manifest;
}

/** Fresh records first; carry prior records absent from a partial refresh. */
function mergeWithPreviousHistory(
  previous: readonly RawListing[],
  current: readonly RawListing[],
): RawListing[] {
  const currentKeys = new Set(current.map(trackingKey));
  return [...current, ...previous.filter((listing) => !currentKeys.has(trackingKey(listing)))];
}

function lifecycleStats(previous: readonly RawListing[], current: readonly RawListing[]): LifecycleStats {
  const previousByKey = new Map(previous.map((listing) => [trackingKey(listing), listing]));
  const stats: LifecycleStats = { continued: 0, added: 0, sold: 0, reactivated: 0 };
  for (const listing of current) {
    const prior = previousByKey.get(trackingKey(listing));
    if (!prior) stats.added++;
    else if (prior.status === "sold" && listing.status !== "sold") stats.reactivated++;
    else if (prior.status !== "sold" && listing.status === "sold") stats.sold++;
    else stats.continued++;
  }
  return stats;
}

