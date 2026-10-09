/**
 * Loads portal ad pages in the headed browser (createBridge: Playwright or the
 * Chrome bridge) and reports what was shown. Never uses plain HTTP clients:
 * portals treat those differently from a person browsing.
 */
import { createBridge } from "../shared/chromeBridge";
import type { AdVisit } from "./classify";

interface BrowserTab { id: number; url?: string; tabFence?: string; incarnation?: string }
interface NavigateResult { tab: BrowserTab; httpStatus?: number }

const NAVIGATION_TIMEOUT_MS = 30_000;
const READ_PAGE = "JSON.stringify({ title: document.title, url: location.href, text: document.body ? document.body.innerText.slice(0, 6000) : '' })";

export class AdPageVisitor {
  private bridge = createBridge();
  private tab?: BrowserTab;
  private connected = false;
  private readonly sessionId = `availability-${process.pid}`;

  async visit(ad: { url: string }): Promise<AdVisit> {
    if (!this.connected) {
      await this.bridge.connect();
      this.connected = true;
    }
    const common = { url: ad.url, wait: true, timeoutMs: NAVIGATION_TIMEOUT_MS, allowRedirects: true, sessionId: this.sessionId };
    const navigated = this.tab
      ? await this.bridge.request<NavigateResult>("navigate", {
          ...common, tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation,
        }, NAVIGATION_TIMEOUT_MS + 5_000)
      : await this.bridge.request<NavigateResult>("new_tab", { ...common, active: false, turn: 1 }, NAVIGATION_TIMEOUT_MS + 5_000);
    this.tab = navigated.tab;

    let page = await this.read();
    page = await this.waitForPersonToVerify(page);
    return { requestedUrl: ad.url, finalUrl: page.url || navigated.tab.url || ad.url, httpStatus: navigated.httpStatus ?? null, title: page.title, text: page.text };
  }

  async close(): Promise<void> {
    if (this.tab) {
      await this.bridge.request("close_tab", { tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation, sessionId: this.sessionId }, 5_000).catch(() => undefined);
    }
    this.tab = undefined;
    this.bridge.close();
  }

  private async read(): Promise<{ title: string; url: string; text: string }> {
    const result = await this.bridge.request<{ result?: { result?: { value?: string } } }>("evaluate", {
      tabId: this.tab!.id, tabFence: this.tab!.tabFence, incarnation: this.tab!.incarnation, sessionId: this.sessionId,
      expression: READ_PAGE, awaitPromise: true,
    }, 35_000);
    const value = result.result?.result?.value;
    if (!value) throw new Error("page could not be read");
    return JSON.parse(value) as { title: string; url: string; text: string };
  }

  /**
   * Opt-in (ATHOME_VERIFY_WAIT_SECONDS): if a verification page is showing, wait
   * passively, reading only the title, for a person to complete it in the window.
   */
  private async waitForPersonToVerify(page: { title: string; url: string; text: string }) {
    const waitMs = Number(process.env.ATHOME_VERIFY_WAIT_SECONDS ?? 0) * 1000;
    const deadline = Date.now() + waitMs;
    while (waitMs > 0 && /認証/.test(page.title) && Date.now() < deadline) {
      console.error("A portal is showing its verification page: complete it in the browser window (waiting).");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try { page = await this.read(); } catch { /* the page may be navigating after the check */ }
    }
    return page;
  }
}
