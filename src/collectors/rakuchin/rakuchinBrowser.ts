/** Loads ラク賃 estate pages in the headed browser, one tab, and returns each page's HTML. */
import { createBridge, type BrowserBridge } from "../shared/browserBridge";

interface BrowserTab { id: number }
type EvaluateResponse = { result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } } };

export interface LoadedPage { url: string; status?: number; html: string }

export class RakuchinBrowser {
  private tab?: BrowserTab;

  constructor(private readonly bridge: BrowserBridge = createBridge()) {}

  async load(url: string): Promise<LoadedPage> {
    let status: number | undefined;
    if (!this.tab) {
      await this.bridge.connect();
      const opened = await this.bridge.request<{ tab: BrowserTab; httpStatus?: number }>("new_tab", { url, wait: "domcontentloaded", timeoutMs: 60_000 });
      this.tab = opened.tab;
      status = opened.httpStatus;
    } else {
      status = (await this.bridge.request<{ httpStatus?: number }>("navigate", { tabId: this.tab.id, url, wait: "domcontentloaded", timeoutMs: 60_000 })).httpStatus;
    }
    // The flight scripts are in the server HTML; wait until the history block has streamed in.
    const response = await this.bridge.request<EvaluateResponse>("evaluate", {
      tabId: this.tab.id, awaitPromise: true,
      expression: `(async () => {
        const deadline = Date.now() + 20000;
        while (!document.documentElement.outerHTML.includes('pastListings') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
        return { url: location.href, html: document.documentElement.outerHTML };
      })()`,
    }, 45_000);
    const failure = response.result?.exceptionDetails?.text;
    if (failure) throw new Error(`${url}: ${failure}`);
    const value = response.result?.result?.value as { url: string; html: string } | undefined;
    if (!value) throw new Error(`${url}: the page returned nothing`);
    return { url: value.url, status, html: value.html };
  }

  async close(): Promise<void> {
    if (this.tab) await this.bridge.request("close_tab", { tabId: this.tab.id }, 5000).catch(() => undefined);
    this.tab = undefined;
    this.bridge.close();
  }
}
