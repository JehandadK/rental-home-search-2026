/**
 * A `fetch` replacement that loads pages in the headed browser (createBridge:
 * Playwright or the Chrome bridge), for collectors written against `fetch`.
 * Portals must only ever see a browser, never a plain HTTP client.
 *
 * A page that redirects to a different path (an ended ad sent to a building or
 * search page) answers 404, so callers treat it as that ad being unavailable
 * rather than as an unrecognised page.
 */
import { createBridge } from "./chromeBridge";

interface BrowserTab { id: number; url?: string; tabFence?: string; incarnation?: string }
interface NavigateResult { tab: BrowserTab; httpStatus?: number }

const NAVIGATION_TIMEOUT_MS = 30_000;
const READ_PAGE = "JSON.stringify({ url: location.href, html: document.documentElement.outerHTML })";

export interface BrowserFetch {
  fetch: typeof fetch;
  close(): Promise<void>;
}

export function createBrowserFetch(sessionName = "browser-fetch"): BrowserFetch {
  const bridge = createBridge();
  const sessionId = `${sessionName}-${process.pid}`;
  let connected = false;
  let tab: BrowserTab | undefined;

  const load = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!connected) {
      await bridge.connect();
      connected = true;
    }
    const common = { url, wait: true, timeoutMs: NAVIGATION_TIMEOUT_MS, allowRedirects: true, sessionId };
    const navigated = tab
      ? await bridge.request<NavigateResult>("navigate", { ...common, tabId: tab.id, tabFence: tab.tabFence, incarnation: tab.incarnation }, NAVIGATION_TIMEOUT_MS + 5_000)
      : await bridge.request<NavigateResult>("new_tab", { ...common, active: false, turn: 1 }, NAVIGATION_TIMEOUT_MS + 5_000);
    tab = navigated.tab;
    const read = await bridge.request<{ result?: { result?: { value?: string } } }>("evaluate", {
      tabId: tab.id, tabFence: tab.tabFence, incarnation: tab.incarnation, sessionId, expression: READ_PAGE, awaitPromise: true,
    }, NAVIGATION_TIMEOUT_MS + 5_000);
    const value = read.result?.result?.value;
    if (!value) throw new Error("page could not be read");
    const page = JSON.parse(value) as { url: string; html: string };
    const movedAway = new URL(page.url).pathname !== new URL(url).pathname;
    return new Response(page.html, { status: movedAway ? 404 : navigated.httpStatus ?? 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };

  return {
    fetch: ((input: string | URL | Request) => load(input)) as typeof fetch,
    async close() {
      if (tab) await bridge.request("close_tab", { tabId: tab.id, tabFence: tab.tabFence, incarnation: tab.incarnation, sessionId }, 5_000).catch(() => undefined);
      tab = undefined;
      if (connected) bridge.close();
    },
  };
}
