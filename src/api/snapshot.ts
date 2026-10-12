/**
 * The data the API ranks: the files `npm run data:web` publishes (the same
 * deduplicated listings and reference catalog the dashboard loads), prepared
 * once per change.
 *
 * Loading never blocks serving. The server starts before the first snapshot
 * is ready (data endpoints answer 503 until then), and a changed file is
 * loaded beside the current snapshot, which keeps serving until the new one is
 * complete. A failed reload keeps the last good snapshot and reports why.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ReferenceDataSnapshot } from "../data-layer/contracts";
import { createRecommendationContext, type RecommendationContext } from "../domain/recommend/rankHomes";
import { buildReferenceModel } from "../domain/referenceData";
import { unpackListings, type WebPayload } from "../domain/webPayload";

export interface Snapshot {
  context: RecommendationContext;
  /** Changes whenever either published file changes: reference revision + listings hash. */
  dataRevision: string;
  loadedAt: string;
}

export interface SnapshotStatus {
  state: "loading" | "ready" | "failed";
  dataRevision: string | null;
  loadedAt: string | null;
  /** The last load failure, also kept while an older snapshot still serves. */
  error: string | null;
}

export interface SnapshotSource {
  /** The snapshot to serve, or null before the first one is ready. */
  current(): Snapshot | null;
  status(): SnapshotStatus;
}

/** A fixed snapshot, for tests and embedding. */
export function staticSnapshotSource(snapshot: Snapshot): SnapshotSource {
  return {
    current: () => snapshot,
    status: () => ({ state: "ready", dataRevision: snapshot.dataRevision, loadedAt: snapshot.loadedAt, error: null }),
  };
}

export const LISTINGS_FILE = "listings.json";
export const REFERENCE_FILE = "reference.json";

/** Build a snapshot from the two published files' bytes. */
export function snapshotFromFiles(listingsBytes: Buffer, referenceBytes: Buffer, loadedAt = new Date()): Snapshot {
  const payload = JSON.parse(listingsBytes.toString("utf-8")) as WebPayload;
  const reference = JSON.parse(referenceBytes.toString("utf-8")) as ReferenceDataSnapshot;
  if (typeof reference?.revision !== "string" || !Array.isArray(reference.places?.records)) {
    throw new Error(`${REFERENCE_FILE} is not a reference snapshot`);
  }
  const listings = unpackListings(payload);
  const { catalog } = buildReferenceModel(reference);
  return {
    context: createRecommendationContext(listings, catalog),
    dataRevision: dataRevision(reference.revision, listingsBytes),
    loadedAt: loadedAt.toISOString(),
  };
}

const dataRevision = (referenceRevision: string, listingsBytes: Buffer) =>
  `${referenceRevision.slice(0, 12)}.${createHash("sha256").update(listingsBytes).digest("hex").slice(0, 12)}`;

export interface FileSnapshotSource extends SnapshotSource {
  /** Settles once the first load has finished, whether it succeeded or not. */
  ready: Promise<void>;
  /** Check the files now and load them if they changed. */
  reload(): Promise<void>;
  close(): void;
}

export interface FileSnapshotOptions {
  /** Directory holding listings.json and reference.json. */
  dir: string;
  /** How often to look for changed files; 0 never looks. */
  checkEveryMs?: number;
  log?: (message: string) => void;
}

export function fileSnapshotSource({ dir, checkEveryMs = 30_000, log = () => {} }: FileSnapshotOptions): FileSnapshotSource {
  let snapshot: Snapshot | null = null;
  let error: string | null = null;
  let loading: Promise<void> | null = null;
  /** mtime+size of the files the current snapshot (or the last failure) came from. */
  let seen: string | null = null;
  const files = [join(dir, LISTINGS_FILE), join(dir, REFERENCE_FILE)];

  const fingerprint = async () =>
    (await Promise.all(files.map((file) => stat(file)))).map((info) => `${info.mtimeMs}:${info.size}`).join("|");

  const load = async () => {
    let print: string | undefined;
    try {
      print = await fingerprint();
      if (print === seen) return;
      const [listingsBytes, referenceBytes] = await Promise.all(files.map((file) => readFile(file)));
      // Let in-flight responses finish before the synchronous build of the distance index.
      await new Promise((resolve) => setImmediate(resolve));
      const next = snapshotFromFiles(listingsBytes, referenceBytes);
      seen = print;
      if (next.dataRevision !== snapshot?.dataRevision) {
        snapshot = next;
        log(`loaded data ${next.dataRevision}: ${next.context.listings.length} listings`);
      }
      error = null;
    } catch (cause) {
      // Retry only once the files change again, rather than re-reading a broken file every check.
      if (print !== undefined) seen = print;
      error = cause instanceof Error ? cause.message : String(cause);
      log(`could not load data from ${dir}: ${error}${snapshot ? ` (still serving ${snapshot.dataRevision})` : ""}`);
    }
  };
  const reload = () => (loading ??= load().finally(() => { loading = null; }));

  const ready = reload();
  const timer = checkEveryMs > 0 ? setInterval(() => void reload(), checkEveryMs) : null;
  timer?.unref();

  return {
    current: () => snapshot,
    status: () => ({
      state: snapshot ? "ready" : error ? "failed" : "loading",
      dataRevision: snapshot?.dataRevision ?? null,
      loadedAt: snapshot?.loadedAt ?? null,
      error,
    }),
    ready,
    reload,
    close: () => { if (timer) clearInterval(timer); },
  };
}
