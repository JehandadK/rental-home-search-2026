/**
 * AtHome and RoomSpot detail captures as agency-only detail patches. Pure and
 * deterministic: replaying the same cached HTML always yields the same batch.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { DetailPatchBatch, ListingDetailPatch, PortalDetailSource } from "../../data-layer/ingestion/contracts";
import { contentFingerprint } from "../../data-layer/contentIdentity";
import type { ListingAgency } from "../../domain/types";
import { parseAthomeAgency } from "../athome/athome";
import { classifyAdVisit } from "../availability/classify";
import { parseRoomspotAgency } from "../roomspot/roomspot";

/** Bump when a parser reads more from the same capture, so a cached capture is a new batch, not a replay conflict. */
export const PORTAL_DETAIL_PARSER_VERSION = "1";

interface PortalDetailSite {
  host: string;
  /** Class of the store block; a page without it is never saved as a detail capture. */
  storeBlock: string;
  parse(html: string): ListingAgency | null;
  /** Pause after every page request. */
  delayMs: number;
  /** Path of a live ad page, as the availability checker knows it. */
  adPath: RegExp;
}

export const PORTAL_DETAIL_SITES: Readonly<Record<PortalDetailSource, PortalDetailSite>> = {
  athome: { host: "www.athome.co.jp", storeBlock: "company-info-area", parse: parseAthomeAgency, delayMs: 4000, adPath: /^\/chintai\/\d+\/?$/ },
  roomspot: { host: "www.roomspot.net", storeBlock: "kokoku-detail-realtor", parse: parseRoomspotAgency, delayMs: 3000, adPath: /^\/rent\/\d+\/?$/ },
};

export interface PortalDetailCapture {
  schemaVersion: 1;
  source: PortalDetailSource;
  url: string;
  capturedAt: string;
  html: string;
  sha256: string;
}

/** What the headed browser saw after loading one detail URL. */
export interface PortalDetailPage {
  /** Navigation HTTP status, when the browser reports one. */
  status?: number;
  /** Final document URL after redirects. */
  url: string;
  title: string;
  html: string;
}

const adPath = (url: string) => { try { return new URL(url).pathname.replace(/\/+$/, ""); } catch { return null; } };

export type PortalDetailPageKind = "detail" | "ended" | "verification" | "blocked" | "unrecognized";

/**
 * Sorts a loaded page into the one outcome the runner acts on. Whether an ad is
 * gone, and what a verification page looks like, follow the availability
 * checker's observed rules (classifyAdVisit); `ended` needs its positive evidence.
 */
export function classifyPortalDetailPage(source: PortalDetailSource, page: PortalDetailPage, requestedUrl: string): { kind: PortalDetailPageKind; evidence: string } {
  if (page.status === 403 || page.status === 429) return { kind: "blocked", evidence: `HTTP ${page.status}` };
  // Another ad's document (a tab not yet navigated, or a redirect to a sibling room)
  // says nothing about this ad: neither its store nor that it ended.
  const finalPath = adPath(page.url);
  if (finalPath !== adPath(requestedUrl) && finalPath !== null && PORTAL_DETAIL_SITES[source].adPath.test(finalPath)) {
    return { kind: "unrecognized", evidence: `page shows ${page.url}, not the requested ad` };
  }
  const hasStore = page.html.includes(PORTAL_DETAIL_SITES[source].storeBlock);
  // Page text is evidence only on a page that is not an ad page, and a live ad's
  // end date (掲載終了予定日) is not its end.
  const text = hasStore ? "" : cheerio.load(page.html)("body").text().replace(/掲載終了予定日?/g, "").replace(/\s+/g, " ").slice(0, 20_000);
  const verdict = classifyAdVisit(source, { requestedUrl, finalUrl: page.url, httpStatus: page.status ?? null, title: page.title, text });
  if (verdict.state === "gone") return { kind: "ended", evidence: verdict.evidence };
  if (verdict.state === "unknown") {
    return { kind: /^verification|busy/.test(verdict.evidence) ? "verification" : "unrecognized", evidence: verdict.evidence };
  }
  if (finalPath !== adPath(requestedUrl)) return { kind: "unrecognized", evidence: `page shows ${page.url}, not the requested ad` };
  if (hasStore && (page.status === undefined || page.status === 200)) return { kind: "detail", evidence: verdict.evidence };
  return { kind: "unrecognized", evidence: `no ${PORTAL_DETAIL_SITES[source].storeBlock} block: ${page.title.slice(0, 100)}` };
}

export const sha256 = (html: string) => createHash("sha256").update(html).digest("hex");

export function validatePortalDetailCapture(source: PortalDetailSource, capture: PortalDetailCapture, expectedUrl: string): void {
  if (!capture || capture.schemaVersion !== 1 || capture.source !== source || capture.url !== expectedUrl) throw new Error("Detail capture identity mismatch");
  const url = new URL(capture.url);
  if (url.protocol !== "https:" || url.hostname !== PORTAL_DETAIL_SITES[source].host || url.username || url.password) throw new Error("Invalid detail origin");
  if (typeof capture.capturedAt !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(capture.capturedAt) || !Number.isFinite(Date.parse(capture.capturedAt))) throw new Error("Invalid detail capture time");
  if (typeof capture.html !== "string" || capture.html.length > 12_000_000) throw new Error("Invalid/oversized detail capture");
  if (capture.sha256 !== sha256(capture.html)) throw new Error("Detail capture checksum mismatch");
  if (!capture.html.includes(PORTAL_DETAIL_SITES[source].storeBlock)) throw new Error(`Unrecognized ${source} detail capture`);
}

/** The store, both fields from one block, or nothing at all. */
export function agencyDetailPatch(source: PortalDetailSource, html: string): ListingDetailPatch {
  const agencyInfo = PORTAL_DETAIL_SITES[source].parse(html);
  return agencyInfo ? { agency: agencyInfo.name, agencyInfo } : {};
}

/** Only captured fields cross this boundary, never a copy of the stored listing. */
export async function portalDetailBatch(source: PortalDetailSource, captures: readonly PortalDetailCapture[]): Promise<DetailPatchBatch> {
  if (!captures.length) throw new Error("No detail captures to submit");
  const ordered = [...captures].sort((a, b) => a.url.localeCompare(b.url));
  const observations = await Promise.all(ordered.map(async (capture) => {
    validatePortalDetailCapture(source, capture, capture.url);
    return { sourceListingId: capture.url, observedAt: capture.capturedAt,
      evidence: { url: capture.url, captureId: await contentFingerprint({ url: capture.url, capturedAt: capture.capturedAt, html: capture.html }) },
      details: agencyDetailPatch(source, capture.html) };
  }));
  const scraper = { name: `${source}-detail`, version: "1", parserVersion: PORTAL_DETAIL_PARSER_VERSION };
  const scope = { urls: ordered.map((capture) => capture.url), cities: [], filters: { fields: "agency" } };
  const capturedAt = ordered.reduce((latest, capture) => Date.parse(capture.capturedAt) > Date.parse(latest) ? capture.capturedAt : latest, ordered[0].capturedAt);
  return { schemaVersion: 1, source, scraper, observationKind: "detail-patch", mode: "detail-enrichment",
    runId: `${source}-detail-captures:${capturedAt}`,
    batchId: await contentFingerprint({ scraper, scope, captures: ordered.map(({ url, capturedAt: at, sha256: hash }) => ({ url, capturedAt: at, sha256: hash })) }),
    capturedAt, scope, observations };
}
