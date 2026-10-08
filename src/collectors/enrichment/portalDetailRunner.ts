/**
 * Bounded AtHome / RoomSpot detail loading for the agency store: a persistent
 * queue, a small request budget, per-ad backoff, a source circuit breaker and a
 * capture cache that replays deterministically. Pages are loaded only by the
 * injected headed-browser loader; the data layer picks URLs and merges stores.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgencyDetailPlanner, PortalDetailSource, ScrapeIngestion } from "../../data-layer/ingestion/contracts";
import { withFileLock, writeJsonAtomically } from "../../node/jsonFile";
import { captureKey } from "../shared/captureStore";
import { positiveInteger } from "../shared/pageBudget";
import {
  classifyPortalDetailPage, PORTAL_DETAIL_SITES, portalDetailBatch, sha256, validatePortalDetailCapture,
  type PortalDetailCapture, type PortalDetailPage,
} from "./portalDetailIngestion";

const HOUR = 3600000, DAY = 24 * HOUR;
/** A cached page is re-read (with --force) once it is this old. */
const REFRESH_AFTER_MS = 7 * DAY;

export interface PortalDetailLoader {
  /** Load one detail URL in the headed browser and read the document. */
  load(url: string): Promise<PortalDetailPage>;
  close(): Promise<void>;
}

export interface PortalDetailDependencies {
  source: PortalDetailSource;
  dataDir: string;
  client: ScrapeIngestion & AgencyDetailPlanner;
  loader: PortalDetailLoader;
  /** Records ended ads (availability), before the store batch is submitted. */
  onEnded?(source: PortalDetailSource, ads: readonly EndedAd[]): Promise<void>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

interface QueueItem { url: string; queuedAt: string; checkedAt?: string; retryAfter?: string; attempts?: number; error?: string }
interface DetailQueue {
  schemaVersion: 1;
  source: PortalDetailSource;
  /** Circuit breaker: no page requests before this time. */
  blockedUntil?: string;
  /** Consecutive breaker trips; each doubles the cooldown. */
  trips?: number;
  items: QueueItem[];
}

export interface EndedAd { url: string; checkedAt: string; evidence: string }

export interface PortalDetailResult {
  source: PortalDetailSource;
  requests: number;
  limit: number;
  reused: number;
  applied: number;
  failed: number;
  queued: number;
  /** Ads whose page is gone, with the availability checker's positive evidence. */
  ended: EndedAd[];
  /** Set when the breaker is open: the reason and when requests may resume. */
  blocked?: { reason: string; until: string };
}

async function optional<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}

export const portalDetailQueuePath = (dataDir: string, source: PortalDetailSource) => join(dataDir, `${source}-detail-queue.json`);
export const portalDetailCapturePath = (dataDir: string, source: PortalDetailSource, url: string) =>
  join(dataDir, ".captures", "details", captureKey(source, url) + ".json");

/** Paths, clock, browser and the public data-layer client are injected for offline replay tests. */
export function runPortalDetails(args: readonly string[], dependencies: PortalDetailDependencies): Promise<PortalDetailResult> {
  if (!Object.hasOwn(PORTAL_DETAIL_SITES, dependencies.source)) throw new Error(`Unsupported detail source: ${dependencies.source}`);
  return withFileLock(join(dependencies.dataDir, `${dependencies.source}-detail-enrichment`), () => runLocked(args, dependencies));
}

async function runLocked(args: readonly string[], dependencies: PortalDetailDependencies): Promise<PortalDetailResult> {
  const { source, dataDir, client, loader, now, sleep } = dependencies;
  const site = PORTAL_DETAIL_SITES[source];
  const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const limit = positiveInteger(arg("--limit"), 10, 0);
  const force = args.includes("--force");
  const replay = args.includes("--replay");

  const queuePath = portalDetailQueuePath(dataDir, source);
  const queue = await optional<DetailQueue>(queuePath, { schemaVersion: 1, source, items: [] });
  if (queue.schemaVersion !== 1 || queue.source !== source || !Array.isArray(queue.items)) throw new Error(`Invalid ${source} detail queue`);
  const urls = await client.planAgencyDetails({ source, force });
  // Planned ads only (an ad that gained its store, or left the source, drops out),
  // worked in the planner's order: most recently seen first.
  const prior = new Map(queue.items.map((item) => [item.url, item]));
  queue.items = urls.map((url) => prior.get(url) ?? { url, queuedAt: now().toISOString() });
  const save = () => writeJsonAtomically(queuePath, queue);
  await save(); // deferred URLs survive later runs

  let requests = 0, reused = 0, failed = 0;
  const ended: PortalDetailResult["ended"] = [];
  let blocked = queue.blockedUntil && Date.parse(queue.blockedUntil) > now().getTime()
    ? { reason: "circuit breaker open from an earlier run", until: queue.blockedUntil } : undefined;
  const trip = (reason: string) => {
    queue.trips = (queue.trips ?? 0) + 1;
    queue.blockedUntil = new Date(now().getTime() + Math.min(HOUR * 2 ** (queue.trips - 1), DAY)).toISOString();
    blocked = { reason, until: queue.blockedUntil };
  };
  const captures = new Map<string, PortalDetailCapture>();
  let consecutiveErrors = 0;

  try {
    for (const item of queue.items) {
      const path = portalDetailCapturePath(dataDir, source, item.url);
      let capture = await optional<PortalDetailCapture | null>(path, null);
      if (capture) validatePortalDetailCapture(source, capture, item.url);
      const wanted = !capture || (force && now().getTime() - Date.parse(capture.capturedAt) > REFRESH_AFTER_MS);
      // Backoff holds even with --force: a failed or ended page is not asked for again early.
      const waiting = item.retryAfter !== undefined && Date.parse(item.retryAfter) > now().getTime();
      let unsuccessful = false;
      if (wanted && !replay && !blocked && requests < limit && !waiting) {
        // Queued network work goes to this portal only, never to arbitrary URLs.
        const target = new URL(item.url);
        if (target.protocol !== "https:" || target.hostname !== site.host || target.username || target.password) throw new Error("Invalid detail origin");
        requests++;
        let kind: ReturnType<typeof classifyPortalDetailPage>["kind"] | "error";
        let page: PortalDetailPage | undefined, evidence = "";
        try {
          page = await loader.load(item.url);
          ({ kind, evidence } = classifyPortalDetailPage(source, page, item.url));
        } catch (e) {
          kind = "error";
          evidence = (e as Error).message.slice(0, 300);
        }
        const at = now();
        consecutiveErrors = kind === "error" ? consecutiveErrors + 1 : 0;
        if (kind === "detail") {
          const fresh: PortalDetailCapture = { schemaVersion: 1, source, url: item.url, capturedAt: at.toISOString(), html: page!.html, sha256: sha256(page!.html) };
          validatePortalDetailCapture(source, fresh, item.url);
          await writeJsonAtomically(path, fresh);
          capture = fresh;
          delete queue.trips;
        } else if (kind === "ended") {
          unsuccessful = true;
          item.error = `ended: ${evidence}`;
          ended.push({ url: item.url, checkedAt: at.toISOString(), evidence });
          // An ended ad stays ended: look again in a week, not every run.
          item.retryAfter = new Date(at.getTime() + 7 * DAY).toISOString();
        } else {
          unsuccessful = true;
          failed++;
          item.error = kind === "error" ? evidence : `${kind}: ${evidence}`;
          item.attempts = (item.attempts ?? 0) + 1;
          item.retryAfter = new Date(at.getTime() + Math.min(HOUR * 2 ** (item.attempts - 1), 7 * DAY)).toISOString();
          // One source circuit breaker: never repeat requests into a challenge, a block,
          // an unknown page, or a browser that keeps failing to load pages.
          if (kind !== "error") trip(item.error!);
          else if (consecutiveErrors >= 2) trip(`repeated load errors: ${item.error}`);
        }
        await save();
        await sleep(site.delayMs);
      } else if (capture) reused++;
      if (!capture) continue;
      // An older capture is still evidence of what the page said when it was read.
      captures.set(item.url, capture);
      if (!unsuccessful && (item.checkedAt !== capture.capturedAt || item.error || item.retryAfter || item.attempts)) {
        item.checkedAt = capture.capturedAt; delete item.error; delete item.retryAfter; delete item.attempts;
        await save();
      }
    }
  } finally {
    // Gone evidence is recorded even when the run stops early, and before the
    // submission below, which must not lose it either.
    if (ended.length && dependencies.onEnded) await dependencies.onEnded(source, ended);
  }
  if (!blocked && queue.blockedUntil) { delete queue.blockedUntil; await save(); }
  let applied = 0;
  if (captures.size) applied = (await client.ingestScrape(await portalDetailBatch(source, [...captures.values()]))).updated;
  return { source, requests, limit, reused, applied, failed, queued: queue.items.length, ended, ...(blocked ? { blocked } : {}) };
}

/** `detail:<source>`: pages load in the headed browser only, with the real clock. */
export async function portalDetailsCli(
  args: readonly string[],
  dependencies: Pick<PortalDetailDependencies, "source" | "dataDir" | "client" | "loader" | "onEnded">,
): Promise<void> {
  const result = await runPortalDetails(args, {
    ...dependencies, now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).finally(() => dependencies.loader.close());
  console.log(`${result.source} details: ${result.requests}/${result.limit} requests; ${result.reused} cache replays; ${result.applied} stores added; `
    + `${result.failed} failures; ${result.ended.length} ended ads; queue retained (${result.queued} URLs).`);
  if (result.blocked) console.log(`  paused until ${result.blocked.until}: ${result.blocked.reason}`);
  if (result.failed) process.exitCode = 2;
}
