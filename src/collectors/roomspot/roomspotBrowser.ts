/** Chrome-backed public RoomSpot search collector. */
import { createBridge } from "../shared/chromeBridge";

interface BrowserTab { id: number; tabFence?: string; incarnation?: string }

export class RoomspotBrowser {
  private bridge = createBridge();
  private tab?: BrowserTab;
  private readonly sessionId = `roomspot-scraper-${process.pid}`;

  async connect(url: string): Promise<void> {
    await this.bridge.connect();
    const result = await this.bridge.request<{ tab: BrowserTab }>("new_tab", {
      url, active: false, wait: true, timeoutMs: 30_000, allowRedirects: true,
      sessionId: this.sessionId, turn: 1,
    });
    this.tab = result.tab;
  }

  async navigate(url: string): Promise<void> {
    if (!this.tab) return this.connect(url);
    const result = await this.bridge.request<{ tab: BrowserTab }>("navigate", {
      tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation,
      url, wait: true, timeoutMs: 30_000, allowRedirects: true, sessionId: this.sessionId,
    });
    this.tab = result.tab;
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
      params.sort = 'new_arrival'; params.item_per_page = 30; params.page_num = ${page};
      const pairs = Object.entries(params).flatMap(([key, value]) =>
        Array.isArray(value) ? value.map(item => [key + '[]', item]) : [[key, value ?? '']]);
      const response = await fetch(window.localize.restRoute + '?' + new URLSearchParams(pairs).toString(), {
        credentials: 'include',
      });
      const json = await response.json();
      if (!response.ok || !json.html) throw new Error('RoomSpot REST HTTP ' + response.status);
      const doc = new DOMParser().parseFromString(json.html, 'text/html');
      const cards = [...doc.querySelectorAll('article.data')];
      if (!cards.length) throw new Error('RoomSpot returned no property cards; not verified exhaustion');
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
    const response = await this.bridge.request<{ result?: { result?: { value?: string } } }>(
      "evaluate",
      { tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation,
        sessionId: this.sessionId, expression, awaitPromise: true },
      120_000,
    );
    const html = response.result?.result?.value;
    // An exhausted page is a valid end-of-results response, not a crawl
    // failure. Return its HTML so the parser yields [] and the caller stops.
    if (html == null) throw new Error("RoomSpot returned no response HTML");
    return html;
  }

  async close(): Promise<void> {
    if (this.tab) await this.bridge.request("close_tab", { tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation, sessionId: this.sessionId }, 5000).catch(() => undefined);
    this.tab = undefined; this.bridge.close();
  }
}
