/**
 * Headed-browser access to UR's API: one public UR page is loaded, then every
 * call is made from inside it with the page's own `ur.api.ajax` helper, the
 * way the page itself asks for vacancies. Nothing is requested from Node.
 */
import { createBridge, type BrowserBridge } from "../shared/browserBridge";
import type { FormField } from "./urApi";

interface BrowserTab { id: number }
type EvaluateResponse = { result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } } };

/** An API call that failed in the page (HTTP error, timeout), as opposed to an empty answer. */
export class UrApiError extends Error {}

export interface UrApi {
  call(endpoint: string, params: readonly FormField[]): Promise<unknown>;
}

export class UrBrowser implements UrApi {
  private tab?: BrowserTab;

  constructor(private readonly bridge: BrowserBridge = createBridge()) {}

  /** Loads a UR page that ships `ur.api` (any city list page does) and waits for it. */
  async open(pageUrl: string): Promise<void> {
    await this.bridge.connect();
    const result = await this.bridge.request<{ tab: BrowserTab }>("new_tab", { url: pageUrl, wait: "domcontentloaded", timeoutMs: 60_000 });
    this.tab = result.tab;
    await this.evaluate(`(async () => {
      const deadline = Date.now() + 30000;
      while (!(window.ur && window.ur.api && typeof window.ur.api.ajax === 'function')) {
        if (Date.now() > deadline) throw new Error('UR page did not load ur.api');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return true;
    })()`);
  }

  async call(endpoint: string, params: readonly FormField[]): Promise<unknown> {
    const value = await this.evaluate(`new Promise((resolve) => {
      window.ur.api.ajax(${JSON.stringify(endpoint)}, ${JSON.stringify(params)})
        .done((data) => resolve({ ok: true, data }))
        .fail((xhr, status) => resolve({ ok: false, status: xhr && xhr.status, error: String(status) }));
    })`) as { ok: boolean; data?: unknown; status?: number; error?: string };
    if (!value?.ok) throw new UrApiError(`UR API ${endpoint} failed: HTTP ${value?.status ?? "?"} ${value?.error ?? ""}`.trim());
    return value.data ?? null;
  }

  async close(): Promise<void> {
    if (this.tab) await this.bridge.request("close_tab", { tabId: this.tab.id }, 5000).catch(() => undefined);
    this.tab = undefined;
    this.bridge.close();
  }

  private async evaluate(expression: string): Promise<unknown> {
    if (!this.tab) throw new Error("UR browser is not open");
    const response = await this.bridge.request<EvaluateResponse>("evaluate", { tabId: this.tab.id, expression, awaitPromise: true }, 90_000);
    const failure = response.result?.exceptionDetails?.text;
    if (failure) throw new UrApiError(failure);
    return response.result?.result?.value;
  }
}
