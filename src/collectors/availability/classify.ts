/**
 * Decide from what a headed browser saw whether one portal ad is still listed.
 *
 * Pure: it never fetches anything. Rules come from pages observed on
 * 2026-09-30; each portal shows a different "no longer available" page:
 *   AtHome    HTTP 404, title 「お探しのページが見つかりません」
 *   SUUMO     HTTP 404, title 「エラー｜SUUMO」, or a redirect to the building's /library/ page
 *   RoomSpot  HTTP 404 with 掲載終了 in the page text
 *   Nifty     redirect from …/detail_<id>/ to the building's /mansion-info/ page
 *
 * `gone` needs positive evidence. Verification/busy pages, server errors and
 * anything unrecognised are `unknown` and never recorded as gone.
 */

export interface AdVisit {
  requestedUrl: string;
  /** `location.href` after any redirects. */
  finalUrl: string;
  /** HTTP status of the navigation when the browser reports it. */
  httpStatus?: number | null;
  title: string;
  /** Visible page text (may be truncated). */
  text: string;
}

export interface AdVerdict {
  state: "gone" | "listed" | "unknown";
  evidence: string;
}

/** Path shape of a live ad page on each portal. */
const AD_PATH: Record<string, RegExp> = {
  suumo: /^\/chintai\/jnc_\d+\/?$/,
  athome: /^\/chintai\/\d+\/?$/,
  nifty: /^\/rent\/[^/]+\/[^/]+\/detail_[0-9a-f]+\/?$/,
  roomspot: /^\/rent\/\d+\/?$/,
  yahoo: /^\/rent\/detail\/[^/]+\/\d+\/?$/,
};

const BLOCKED_TITLE = /認証|アクセス(が集中|制限)|Access Denied/i;
const BUSY_TEXT = /ただいま込み合っております/;
const GONE_TITLE = /お探しのページが見つかりません|ページが見つかりません|^エラー[｜|]/;

const pathOf = (url: string): { host: string; path: string } | undefined => {
  try {
    const { hostname, pathname } = new URL(url);
    return { host: hostname, path: pathname };
  } catch {
    return undefined;
  }
};

export function classifyAdVisit(source: string, visit: AdVisit): AdVerdict {
  const title = visit.title.trim();
  if (BLOCKED_TITLE.test(title) || (visit.text.length < 400 && BUSY_TEXT.test(visit.text))) {
    return { state: "unknown", evidence: `verification or busy page: ${title || visit.text.slice(0, 40)}` };
  }

  const status = visit.httpStatus ?? null;
  if (status === 404 || status === 410) return { state: "gone", evidence: `HTTP ${status} · ${title || "no title"}` };
  if (status != null && status >= 400) return { state: "unknown", evidence: `HTTP ${status}` };

  if (GONE_TITLE.test(title)) return { state: "gone", evidence: `not-found page · ${title}` };
  if (source === "roomspot" && visit.text.includes("掲載終了")) return { state: "gone", evidence: "RoomSpot shows 掲載終了" };

  const expected = AD_PATH[source];
  const requested = pathOf(visit.requestedUrl);
  const final = pathOf(visit.finalUrl);
  if (expected && requested && final && expected.test(requested.path) && !expected.test(final.path)) {
    return final.host === requested.host
      ? { state: "gone", evidence: `redirected off the ad page to ${final.path}` }
      : { state: "unknown", evidence: `redirected to another site: ${final.host}` };
  }

  return title
    ? { state: "listed", evidence: `HTTP ${status ?? 200} · ad page still shown` }
    : { state: "unknown", evidence: "page had no title" };
}
