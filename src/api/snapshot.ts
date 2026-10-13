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

/** Where the two published files come from: a directory, or a URL (e.g. the static site's data/). */
export interface PublishedFiles {
  /** For logs: the directory or URL. */
  location: string;
  /** Changes when either file changes; null when the source cannot tell without reading them. */
  fingerprint(): Promise<string | null>;
  read(): Promise<[listings: Buffer, reference: Buffer]>;
  /** Stop a read in progress. */
  close?(): void;
}

/**
 * The files could not be fetched (network, HTTP status, timeout, size). Unlike
 * bad content, this is retried on the next check even when nothing changed.
 */
export class FetchError extends Error {}

export function localFiles(dir: string): PublishedFiles {
  const files = [join(dir, LISTINGS_FILE), join(dir, REFERENCE_FILE)];
  return {
    location: dir,
    fingerprint: async () => (await Promise.all(files.map((file) => stat(file)))).map((info) => `${info.mtimeMs}:${info.size}`).join("|"),
    read: async () => {
      const [listings, reference] = await Promise.all(files.map((file) => readFile(file)));
      return [listings, reference];
    },
  };
}

/** The largest published file accepted from a URL (the listings are ~25 MB today). */
export const MAX_REMOTE_FILE_BYTES = 100 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 60_000;

export interface RemoteOptions {
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
}

/**
 * The published files from a URL directory, such as https://example.com/rentals/data/.
 * Changes are detected with HEAD (ETag / Last-Modified), so an unchanged file
 * is never downloaded again; a server that sends neither is read and compared.
 */
export function remoteFiles(base: string, { fetch = globalThis.fetch, maxBytes = MAX_REMOTE_FILE_BYTES }: RemoteOptions = {}): PublishedFiles {
  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  if (root.protocol !== "https:" && root.protocol !== "http:") throw new Error(`Unsupported data URL ${base}: use http(s)`);
  if (root.username || root.password || root.search || root.hash) throw new Error("The data URL may not carry credentials, a query or a fragment");
  const urls = [new URL(LISTINGS_FILE, root), new URL(REFERENCE_FILE, root)];
  /** The download in progress, so close() and a failed partner can stop it. */
  let inFlight: AbortController | null = null;

  /** A file's validator, or null when HEAD gives none (or is refused): the caller then reads and compares. */
  const head = async (url: URL) => {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const validator = response.headers.get("etag") ?? response.headers.get("last-modified");
    return validator == null ? null : `${validator}:${response.headers.get("content-length") ?? ""}`;
  };

  const get = async (url: URL, signal: AbortSignal): Promise<Buffer> => {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(REMOTE_TIMEOUT_MS)]) });
    const declared = Number(response.headers.get("content-length") ?? NaN);
    const refuse = async (reason: string) => {
      await response.body?.cancel().catch(() => {});
      throw new FetchError(reason);
    };
    if (!response.ok) return refuse(`HTTP ${response.status} for ${url.href}`);
    if (declared > maxBytes) return refuse(`${url.href} is over ${maxBytes} bytes`);
    // One buffer when the size is known, rather than chunks plus a concatenated copy. fetch
    // decompresses a gzip/br response, and Content-Length is then the compressed size, so only
    // an unencoded body's length can be trusted.
    const encoding = (response.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
    const exact = encoding === "identity" && Number.isInteger(declared) && declared >= 0 ? Buffer.allocUnsafe(declared) : null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
      if (size + part.value.length > maxBytes || (exact && size + part.value.length > exact.length)) {
        await reader!.cancel().catch(() => {});
        throw new FetchError(`${url.href} is over ${exact && declared <= maxBytes ? `its stated ${declared}` : maxBytes} bytes`);
      }
      if (exact) exact.set(part.value, size);
      else chunks.push(part.value);
      size += part.value.length;
    }
    if (exact && size !== exact.length) throw new FetchError(`${url.href} ended after ${size} of ${declared} bytes`);
    return exact ?? Buffer.concat(chunks);
  };

  return {
    location: root.href,
    fingerprint: async () => {
      const prints = await Promise.all(urls.map(head));
      return prints.every((print) => print != null) ? prints.join("|") : null;
    },
    read: async () => {
      const controller = new AbortController();
      inFlight = controller;
      try {
        // If one download fails, stop the other rather than let it run on.
        const [listings, reference] = await Promise.all(urls.map((url) => get(url, controller.signal).catch((error: unknown) => {
          controller.abort();
          throw error;
        })));
        return [listings, reference];
      } catch (error) {
        throw error instanceof FetchError ? error : new FetchError(error instanceof Error ? error.message : String(error));
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    },
    close: () => inFlight?.abort(),
  };
}

/** A directory path, or an http(s) URL. */
export const isDataUrl = (location: string) => /^https?:\/\//i.test(location);

export interface PublishedSnapshotSource extends SnapshotSource {
  /** Settles once the first load has finished, whether it succeeded or not. */
  ready: Promise<void>;
  /** Check the files now and load them if they changed. */
  reload(): Promise<void>;
  close(): void;
}

export interface PublishedSnapshotOptions {
  /** A directory holding listings.json and reference.json, or an http(s) URL of one. */
  from: string | PublishedFiles;
  /** How often to look for changes; 0 never looks. Default 30 s for a directory, 60 s for a URL. */
  checkEveryMs?: number;
  log?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
}

export function publishedSnapshotSource({ from, checkEveryMs, log = () => {}, fetch }: PublishedSnapshotOptions): PublishedSnapshotSource {
  const files = typeof from !== "string" ? from : isDataUrl(from) ? remoteFiles(from, { fetch }) : localFiles(from);
  const interval = checkEveryMs ?? (typeof from === "string" && isDataUrl(from) ? 60_000 : 30_000);
  let snapshot: Snapshot | null = null;
  let error: string | null = null;
  let loading: Promise<void> | null = null;
  /** The fingerprint the current snapshot (or the last failure) came from. */
  let seen: string | null = null;
  /** After close(), no load starts or reports anything. */
  let closed = false;

  const load = async () => {
    let print: string | null | undefined;
    try {
      if (closed) return;
      print = await files.fingerprint();
      if (closed || (print != null && print === seen)) return;
      const [listingsBytes, referenceBytes] = await files.read();
      // Compare the content before paying for the distance index: a fingerprint can change
      // (a touched file, a CDN node with its own ETags) while the data does not.
      if (snapshot && revisionOf(listingsBytes, referenceBytes) === snapshot.dataRevision) {
        seen = print ?? null;
        error = null;
        return;
      }
      // Let in-flight responses finish before the synchronous build of the distance index.
      await new Promise((resolve) => setImmediate(resolve));
      const next = snapshotFromFiles(listingsBytes, referenceBytes);
      seen = print ?? null;
      if (next.dataRevision !== snapshot?.dataRevision) {
        snapshot = next;
        log(`loaded data ${next.dataRevision}: ${next.context.listings.length} listings`);
      }
      error = null;
    } catch (cause) {
      if (closed) return;
      // Bad content is retried only once the files change again, rather than re-read every check;
      // a failed fetch (network, status, timeout) is retried on the next check.
      if (print != null && !(cause instanceof FetchError)) seen = print;
      error = cause instanceof Error ? cause.message : String(cause);
      log(`could not load data from ${files.location}: ${error}${snapshot ? ` (still serving ${snapshot.dataRevision})` : ""}`);
    }
  };
  const reload = () => (loading ??= load().finally(() => { loading = null; }));

  const ready = reload();
  const timer = interval > 0 ? setInterval(() => void reload(), interval) : null;
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
    close: () => {
      closed = true;
      if (timer) clearInterval(timer);
      files.close?.();
    },
  };
}

/** The data revision two files would give, without building a snapshot. */
function revisionOf(listingsBytes: Buffer, referenceBytes: Buffer): string | null {
  const revision = (JSON.parse(referenceBytes.toString("utf-8")) as { revision?: unknown }).revision;
  return typeof revision === "string" ? dataRevision(revision, listingsBytes) : null;
}
