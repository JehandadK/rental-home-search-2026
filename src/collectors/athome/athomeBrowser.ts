/**
 * AtHome protects direct scripted requests with browser verification. This
 * adapter uses the local Pi Control Chrome Bridge and AtHome's own public list
 * AJAX endpoint from a real first-party tab. Start at the homepage before
 * navigating to results: opening a list URL in a cold tab can trigger a block.
 * Only public listing HTML leaves the page; cookies/storage remain in Chrome.
 */
import { createBridge } from "../shared/chromeBridge";
import { athomeDownloadedCapture } from "./athomeCapture";

interface BrowserTab {
  id: number;
  url: string;
  tabFence?: string;
  incarnation?: string;
  sessionId?: string;
}

/** Returned by the legacy AJAX capture when the page is the modern `.property-card` template instead. */
const MODERN_TEMPLATE = "__athome_modern_template__";
const HOMEPAGE_URL = "https://www.athome.co.jp/";
const NAVIGATION_TIMEOUT_MS = 30_000;
// Leave time for the Bridge to return its navigation timeout/error.
const REQUEST_TIMEOUT_MS = NAVIGATION_TIMEOUT_MS + 5_000;

export class AthomeBrowser {
  private bridge = createBridge();
  private tab?: BrowserTab;
  private searchReady = false;
  private modernTemplate = false;
  private readonly sessionId = `athome-scraper-${process.pid}`;

  async connect(initialUrl: string): Promise<void> {
    if (this.tab) throw new Error("AtHome tab already exists; navigate it or close it before reconnecting");
    this.searchReady = false;
    await this.bridge.connect();
    // Do not open a results URL directly in a fresh tab. Await the homepage
    // load before navigating, and never replay a timed-out navigation.
    const created = await this.bridge.request<{ tab: BrowserTab }>("new_tab", {
      url: HOMEPAGE_URL,
      active: false,
      wait: true,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
      allowRedirects: false,
      sessionId: this.sessionId,
      turn: 1,
    }, REQUEST_TIMEOUT_MS);
    this.tab = created.tab;
    await this.navigate(initialUrl);
  }

  /** Switch city by navigating the same temporary tab. */
  async navigate(url: string): Promise<void> {
    if (!this.tab) return this.connect(url);
    // Invalidate readiness before dispatch: failure must not leave the old
    // city's document eligible for a capture attributed to the new city.
    this.searchReady = false;
    const result = await this.bridge.request<{ tab: BrowserTab }>("navigate", {
      tabId: this.tab.id,
      tabFence: this.tab.tabFence,
      incarnation: this.tab.incarnation,
      url,
      wait: true,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
      allowRedirects: true,
      sessionId: this.sessionId,
    }, REQUEST_TIMEOUT_MS);
    this.tab = result.tab;
    this.searchReady = true;
  }

  /**
   * Calls AtHome's same endpoint used by its sort and paging controls. The
   * first page form supplies all city/search parameters; only SORT/PAGENO are
   * changed. The returned partial HTML is exactly what AtHome renders.
   */
  async fetchPage(page: number, sort = "33"): Promise<string> {
    if (!this.tab || !this.searchReady) throw new Error("AtHome search navigation has not completed; capture stopped");
    if (this.modernTemplate) return this.fetchModernPage(page, sort);
    const expression = `(async () => {
      const form = document.querySelector('#search-parameter');
      if (!form) {
        if (document.querySelector('.property-card')) return ${JSON.stringify(MODERN_TEMPLATE)};
        throw new Error('AtHome search form not found after navigation (blocked or unsupported page); inspect the homepage before retrying');
      }
      const data = new URLSearchParams(new FormData(form));
      data.set('SORT', ${JSON.stringify(sort)});
      data.set('PAGENO', ${JSON.stringify(String(page))});
      data.set('EVENT', ${JSON.stringify(page === 1 ? "SORT" : "PAGING")});
      data.set('LOGCTL', 'GXNONE');
      const response = await fetch('/chintai/ajax/simplelist/simplelist/', {
        method: 'POST', body: data, credentials: 'include',
        signal: AbortSignal.timeout(20000),
      });
      const html = await response.text();
      if (!response.ok) throw new Error('AtHome AJAX HTTP ' + response.status);

      // Runtime.evaluate responses are bounded. Compact the very large portal
      // HTML in-page to only fields the Node parser needs, and discard 1K/1LDK
      // rooms before crossing the Bridge. This keeps every relevant room from
      // all 30 buildings without response truncation.
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const esc = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[char]);
      const text = (root, selector) => root.querySelector(selector)?.textContent?.trim() || '';
      const compact = [...doc.querySelectorAll('.p-property')].map((property) => {
        const rooms = [...property.querySelectorAll('.p-property__room--detailbox')].map((room) => {
          const layout = text(room, '.p-property__floor');
          if (!/^\\d+/.test(layout) || Number(layout.match(/^\\d+/)[0]) < 2) return '';
          const money = [...room.querySelector('.p-property__room-keymoney')?.children || []]
            .map((item) => '<p>' + esc(item.textContent?.trim()) + '</p>').join('');
          const facilities = [...room.querySelectorAll('.p-property__information-facility li')]
            .map((item) => '<li class="' + (item.classList.contains('p-property__information-facility_disabled-list')
              ? 'p-property__information-facility_disabled-list' : '') + '">' + esc(item.textContent?.trim()) + '</li>').join('');
          const href = room.querySelector('a[href*="/chintai/"]')?.getAttribute('href') || '';
          return '<div class="p-property__room--detailbox" data-bukken-no="' + esc(room.getAttribute('data-bukken-no')) + '">' +
            '<p class="p-property__information-price"><b class="p-property__information-rent">' +
              esc(text(room, '.p-property__information-rent')) + '</b>万円<span>' +
              esc(text(room, '.p-property__information-price span')) + '</span></p>' +
            '<div class="p-property__room-keymoney">' + money + '</div>' +
            '<div class="p-property__room-floorplan"><div class="p-property__floor">' + esc(layout) +
              '</div><span>' + esc(text(room, '.p-property__room-floorplan span')) + '</span></div>' +
            '<div class="p-property__information-facility"><ul>' + facilities + '</ul></div>' +
            '<a href="' + esc(href) + '">detail</a></div>';
        }).join('');
        // Keep building structure even on a page containing only small rooms.
        // Zero in-scope rooms is not proof of exhausted pagination.
        const value = (title) => property.querySelector('i[title="' + title + '"]')
          ?.closest('dl')?.querySelector('dd')?.textContent?.trim() || '';
        return '<div class="p-property"><h2 class="p-property__title--building">' +
          esc(text(property, '.p-property__title--building')) + '</h2>' +
          '<dl><i title="所在地"></i><dd>' + esc(value('所在地')) + '</dd></dl>' +
          '<dl><i title="交通"></i><dd>' + esc(value('交通')) + '</dd></dl>' +
          '<dl><i title="家"></i><dd>' + esc(value('家')) + '</dd></dl>' + rooms + '</div>';
      }).join('');
      return '<html><body>' + compact + '</body></html>';
    })()`;
    // A failed/uncertain capture requires explicit navigation before trying
    // again, rather than repeated evaluations on the same blocked document.
    this.searchReady = false;
    const result = await this.bridge.request<{
      result?: {
        result?: { value?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
    }>("evaluate", {
      tabId: this.tab.id,
      tabFence: this.tab.tabFence,
      incarnation: this.tab.incarnation,
      sessionId: this.sessionId,
      expression,
      awaitPromise: true,
    }, REQUEST_TIMEOUT_MS);
    const exception = result.result?.exceptionDetails;
    if (exception) {
      const message = exception.exception?.description ?? exception.text ?? "Page evaluation failed";
      throw new Error(`AtHome capture stopped: ${message.split("\n")[0].slice(0, 300)}`);
    }
    const html = result.result?.result?.value;
    if (html === MODERN_TEMPLATE) {
      this.modernTemplate = true;
      return this.fetchModernPage(page, sort);
    }
    if (!html || !html.includes("p-property")) {
      throw new Error("AtHome browser capture returned no property HTML");
    }
    this.searchReady = true;
    return html;
  }

  /**
   * The modern template has no AJAX form: results are ordinary paged documents
   * (`/list/pageN/?sort=33`). Navigate the warm tab, read the document once and
   * project it offline with the same code used for downloaded pages. A
   * verification page is reported, never retried or worked around.
   */
  private async fetchModernPage(page: number, sort: string): Promise<string> {
    const current = new URL(this.tab!.url);
    const target = new URL(current);
    target.pathname = target.pathname.replace(/list\/(?:page\d+\/)?$/, page > 1 ? `list/page${page}/` : "list/");
    target.searchParams.set("sort", sort);
    if (target.href !== current.href) await this.navigate(target.href);
    this.searchReady = false;
    const result = await this.bridge.request<{
      result?: { result?: { value?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    }>("evaluate", {
      tabId: this.tab!.id, tabFence: this.tab!.tabFence, incarnation: this.tab!.incarnation, sessionId: this.sessionId,
      expression: `(async () => {
        const end = Date.now() + 20000;
        while (!document.querySelector('.property-card')) {
          if (/認証/.test(document.title) || Date.now() > end) {
            throw new Error('AtHome results not available (verification page or no results): ' + document.title);
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return document.documentElement.outerHTML;
      })()`,
      awaitPromise: true,
    }, REQUEST_TIMEOUT_MS);
    const exception = result.result?.exceptionDetails;
    if (exception) {
      const message = exception.exception?.description ?? exception.text ?? "Page evaluation failed";
      throw new Error(`AtHome capture stopped: ${message.split("\n")[0].slice(0, 300)}`);
    }
    const document = result.result?.result?.value;
    if (!document) throw new Error("AtHome browser capture returned no document");
    const html = athomeDownloadedCapture(document, target.href, new Date().toISOString()).html;
    if (!html.includes("p-property")) throw new Error("AtHome browser capture returned no property HTML");
    this.searchReady = true;
    return html;
  }

  async close(): Promise<void> {
    // Do not make persistence depend on optional UI cleanup. The host's
    // turn/session cleanup owns temporary Agent tabs; closing through CDP can
    // wait for a confirmation and must never stall or lose a completed crawl.
    if (this.tab) await this.bridge.request("close_tab", { tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation, sessionId: this.sessionId }, 5000).catch(() => undefined);
    this.tab = undefined;
    this.searchReady = false;
    this.modernTemplate = false;
    this.bridge.close();
  }
}
