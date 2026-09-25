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
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawListing } from "../../src/types";
import type { ArchivedSourceListing } from "../../src/data-layer/contracts";
import { mergeSourceProvenance } from "../../src/data-layer/sourceProvenance";
import { RevisionConflictError } from "../../src/data-layer/errors";
export { RevisionConflictError } from "../../src/data-layer/errors";
import { reconcileLifecycle, trackingKey, type LifecycleStats } from "./lifecycle";
import { deduplicateListings, isSameUnit } from "../../src/domain/listingDedup";
import { restoreObservedLifecycle } from "./observations";
import {
  withFileLock,
  writeJsonAtomically as atomicWriteJson,
  writeJsonAtomicallyUnlocked,
} from "./jsonFile";

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
  /** Revision of the committed source contents; legacy files are hashed on read. */
  revision?: string;
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
  /** Source rows retired from the current snapshot; retained for audit/reappearance. */
  archivedListings?: ArchivedSourceListing[];
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

/** Write JSON under a per-file lock using a unique temp file and atomic rename. */
export { atomicWriteJson };

/** Copy a file into a backup directory before it is replaced, pruning old copies. */
async function backupFileIn(path: string, backupDir: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  await mkdir(backupDir, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID()}`;
  const name = basename(path, ".json");
  const dest = join(backupDir, `${name}-${stamp}.json`);
  await copyFile(path, dest);

  const stale = (await readdir(backupDir))
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".json"))
    .sort()
    .slice(0, -BACKUPS_PER_FILE);
  for (const file of stale) await unlink(join(backupDir, file));
  return dest;
}

/** Copy a file into the repository's standard .backups/ directory. */
export async function backupFile(path: string): Promise<string | null> {
  return backupFileIn(path, BACKUP_DIR);
}

export class ShrinkGuardError extends Error {}

function hashRevision(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON-backed source repository, parameterized for isolated contract tests. */
export class JsonSourceStore {
  readonly transactionLockPath: string;

  constructor(
    readonly sourcesDir: string,
    readonly backupDir: string,
    transactionLockPath = join(dirname(sourcesDir), ".sources.lock"),
  ) {
    this.transactionLockPath = transactionLockPath;
  }

  sourcePath(source: string): string {
    return join(this.sourcesDir, `${source}.json`);
  }

  async readSource(source: string): Promise<SourceFile | null> {
    const path = this.sourcePath(source);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Omit<SourceFile, "revision"> & { revision?: string };
    return { ...parsed, revision: parsed.revision ?? hashRevision(raw) };
  }

  async listSources(): Promise<SourceFile[]> {
    if (!existsSync(this.sourcesDir)) return [];
    const files = (await readdir(this.sourcesDir)).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
    const sources: SourceFile[] = [];
    for (const file of files.sort()) {
      const source = await this.readSource(basename(file, ".json"));
      if (source) sources.push(source);
    }
    return sources;
  }

  async writeSource(
    file: Omit<SourceFile, "count" | "revision">,
    options: { force?: boolean; expectedRevision: string | null },
  ): Promise<{ path: string; previousCount: number; backup: string | null; revision: string }> {
    const path = this.sourcePath(file.source);
    return withFileLock(this.transactionLockPath, () => withFileLock(path, async () => {
      // Read and compare only after acquiring the locks. Two writers based on
      // the same revision cannot both commit; the loser receives a conflict.
      const previous = await this.readSource(file.source);
      const actualRevision = previous?.revision ?? null;
      if (options.expectedRevision !== actualRevision) {
        throw new RevisionConflictError(options.expectedRevision, actualRevision, path);
      }

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

      // Preserve fields unknown to this adapter so newer data is not silently
      // erased by an older script. Caller-provided values still take precedence.
      const bodyRecord = { ...(previous ?? {}), ...file, count: nextCount } as Record<string, unknown>;
      if (previous?.provenance || file.provenance) {
        bodyRecord.provenance = mergeSourceProvenance(previous?.provenance, file.provenance);
      }
      delete bodyRecord.revision;
      const body = bodyRecord as unknown as Omit<SourceFile, "revision">;
      const previousBody = previous ? { ...previous } as Record<string, unknown> : null;
      if (previousBody) delete previousBody.revision;
      if (previousBody && JSON.stringify(body) === JSON.stringify(previousBody)) {
        return { path, previousCount, backup: null, revision: actualRevision! };
      }

      const backup = await backupFileIn(path, this.backupDir);
      const revision = hashRevision(JSON.stringify(body));
      const payload: SourceFile = { ...body, revision };
      await writeJsonAtomicallyUnlocked(path, payload);
      return { path, previousCount, backup, revision };
    }));
  }
}

const defaultSourceStore = new JsonSourceStore(SOURCES_DIR, BACKUP_DIR);

export function sourcePath(source: string): string {
  return defaultSourceStore.sourcePath(source);
}

export async function readSource(source: string): Promise<SourceFile | null> {
  return defaultSourceStore.readSource(source);
}

export async function listSources(): Promise<SourceFile[]> {
  return defaultSourceStore.listSources();
}

export async function writeSource(
  file: Omit<SourceFile, "count" | "revision">,
  options: { force?: boolean; expectedRevision: string | null },
): Promise<{ path: string; previousCount: number; backup: string | null; revision: string }> {
  return defaultSourceStore.writeSource(file, options);
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
  // Writers use the same lock, so the build reads a coherent set of source
  // snapshots and cannot race another source update midway through the merge.
  return withFileLock(join(DATA_DIR, ".sources.lock"), buildRawUnlocked);
}

async function buildRawUnlocked(): Promise<BuildManifest> {
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

