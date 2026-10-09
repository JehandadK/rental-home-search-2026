/** Headed-browser public RoomSpot search collector. */
import { createBridge } from "../shared/browserBridge";
import { readDetailPageExpression, readLoadedDetailPage, type EvaluateResult } from "../shared/detailPage";
import { EndOfResultsError, RESULT_PAGE_SIZE } from "../shared/resultPages";

/** Returned in-page when RoomSpot answers a page past page 1 with no results. */
const END_OF_RESULTS = "__roomspot_end_of_results__";

interface BrowserTab { id: number; tabFence?: string; incarnation?: string }

export class RoomspotBrowser {
  private bridge = createBridge();
  private tab?: BrowserTab;
  /** HTTP status of the last navigation, when the driver reports it. */
  private lastStatus?: number;
  private readonly sessionId = `roomspot-scraper-${process.pid}`;

  // Navigate without waiting for the load event: RoomSpot's third-party trackers
  // (im-apps.net, clarity.ms) can hang it past the timeout although the results
  // page itself arrives. fetchPage already polls for window.localize.
  async connect(url: string): Promise<void> {
    await this.bridge.connect();
    const result = await this.bridge.request<{ tab: BrowserTab; httpStatus?: number }>("new_tab", {
      url, active: false, wait: false, timeoutMs: 30_000, allowRedirects: true,
      sessionId: this.sessionId, turn: 1,
    });
    this.tab = result.tab;
    this.lastStatus = result.httpStatus;
  }

  async navigate(url: string): Promise<void> {
    if (!this.tab) return this.connect(url);
    const result = await this.bridge.request<{ tab: BrowserTab; httpStatus?: number }>("navigate", {
      tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation,
      url, wait: false, timeoutMs: 30_000, allowRedirects: true, sessionId: this.sessionId,
    });
    this.tab = result.tab;
    this.lastStatus = result.httpStatus;
  }

  /** Loads one ad's detail page in the same tab and reads it, for its 広告主情報 block. */
  async readDetail(url: string): Promise<{ status?: number; url: string; title: string; html: string }> {
    await this.navigate(url);
    return readLoadedDetailPage(() => this.bridge.request<EvaluateResult>("evaluate", {
      tabId: this.tab!.id, tabFence: this.tab!.tabFence, incarnation: this.tab!.incarnation,
      sessionId: this.sessionId, expression: readDetailPageExpression(url, ".kokoku-detail-realtor"), awaitPromise: true,
    }, 35_000), this.lastStatus);
  }

  /** Fetch one page via RoomSpot's own public WordPress REST endpoint. */
  async fetchPage(page: number): Promise<string> {
    if (!this.tab) throw new Error("RoomSpot browser is not initialized");
    const expression = `(async () => {
      const deadline = Date.now() + 20000;
      while (!window.localize?.restRoute || !window.localize?.searchParams) {
        if (Date.now() > deadline) throw new Error('RoomSpot search metadata not found');
        await new Promise(r => setTimeout(r, 200));
      }
      const params = structuredClone(window.localize.searchParams);
      params.sort = 'new_arrival'; params.item_per_page = ${RESULT_PAGE_SIZE.roomspot}; params.page_num = ${page};
      const pairs = Object.entries(params).flatMap(([key, value]) =>
        Array.isArray(value) ? value.map(item => [key + '[]', item]) : [[key, value ?? '']]);
      const response = await fetch(window.localize.restRoute + '?' + new URLSearchParams(pairs).toString(), {
        credentials: 'include',
      });
      // Past the last page RoomSpot answers with no cards, no HTML or a 404. Page 1
      // never may: an empty first page is not evidence of an empty market.
      const pastFirst = ${page > 1};
      if (response.status === 404 && pastFirst) return ${JSON.stringify(END_OF_RESULTS)};
      const body = await response.text();
      let json;
      try { json = JSON.parse(body); } catch { throw new Error('RoomSpot REST HTTP ' + response.status + ' returned no JSON (blocked or unrecognised page)'); }
      if (!response.ok) throw new Error('RoomSpot REST HTTP ' + response.status);
      if (typeof json?.html !== 'string' || !json.html.trim()) {
        // A REST error object ({ code, message }) is not an empty results page.
        if (pastFirst && json && typeof json === 'object' && !('code' in json) && !('message' in json)) return ${JSON.stringify(END_OF_RESULTS)};
        throw new Error('RoomSpot REST returned no results HTML');
      }
      const doc = new DOMParser().parseFromString(json.html, 'text/html');
      const cards = [...doc.querySelectorAll('article.data')];
      if (!cards.length) {
        if (pastFirst) return ${JSON.stringify(END_OF_RESULTS)};
        throw new Error('RoomSpot returned no property cards; not verified exhaustion');
      }
      for (const card of cards) {
        card.querySelectorAll('script,style,svg,input,button,iframe').forEach(e => e.remove());
        // Keep the lazy-loaded photos (exterior, floor plans) as data-src + alt; drop icons.
        card.querySelectorAll('img').forEach(img => { if (!/^https?:/.test(img.getAttribute('data-src') || '')) img.remove(); });
        for (const e of [card, ...card.querySelectorAll('*')]) for (const a of [...e.attributes]) {
          const keep = e.tagName === 'IMG' ? ['class','data-src','alt'] : ['class','title','href'];
          if (!keep.includes(a.name)) e.removeAttribute(a.name);
        }
      }
      return cards.map(c => c.outerHTML).join('').replace(/>\\s+</g, '><');
    })()`;
    const response = await this.bridge.request<EvaluateResult>(
      "evaluate",
      { tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation,
        sessionId: this.sessionId, expression, awaitPromise: true },
      120_000,
    );
    // The bridge reports an in-page throw as exceptionDetails, with no value.
    const exception = response.result?.exceptionDetails;
    if (exception) {
      const message = exception.exception?.description ?? exception.text ?? "page evaluation failed";
      throw new Error(`RoomSpot capture stopped on page ${page}: ${message.split("\n")[0].slice(0, 300)}`);
    }
    const html = response.result?.result?.value;
    if (html === END_OF_RESULTS) throw new EndOfResultsError(`RoomSpot has no results page ${page}`);
    if (html == null) throw new Error("RoomSpot returned no response HTML");
    return html;
  }

  async close(): Promise<void> {
    if (this.tab) await this.bridge.request("close_tab", { tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation, sessionId: this.sessionId }, 5000).catch(() => undefined);
    this.tab = undefined; this.bridge.close();
  }
}
