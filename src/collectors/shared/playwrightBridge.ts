/**
 * Drop-in replacement for ChromeBridge that drives a locally launched Playwright
 * Chromium. Speaks only the four requests the portal browser adapters use
 * (new_tab, navigate, evaluate, close_tab), so the adapters stay unchanged.
 *
 * Enabled with BROWSER_DRIVER=playwright. Headed by default because Nifty and AtHome
 * serve a wait/verification page to headless Chromium; PLAYWRIGHT_HEADLESS=1 opts out.
 * PLAYWRIGHT_USER_DATA_DIR keeps cookies between runs, so a portal's human
 * verification passed once by hand in the headed window is reused. It is never
 * automated or bypassed here. playwright-core is resolved from PLAYWRIGHT_CORE_PATH, then node resolution, then the global
 * `playwright-cli` install.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// playwright-core is resolved at runtime (not a project dependency), so type only what is used.
interface Page {
  goto(url: string, options: { waitUntil: "load" | "domcontentloaded" | "commit"; timeout: number }): Promise<{ status(): number } | null>;
  evaluate(expression: string): Promise<unknown>;
  url(): string;
  close(): Promise<void>;
}
interface BrowserContext { newPage(): Promise<Page> }
interface Browser { newContext(options: Record<string, unknown>): Promise<BrowserContext>; close(): Promise<void> }
interface LaunchOptions { headless: boolean; executablePath?: string; locale?: string; timezoneId?: string }
interface PlaywrightCore {
  chromium: {
    launch(options: LaunchOptions): Promise<Browser>;
    launchPersistentContext(userDataDir: string, options: LaunchOptions): Promise<BrowserContext & { close(): Promise<void> }>;
  };
}

const GLOBAL_CORE = "/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright-core";

function loadPlaywright(): PlaywrightCore {
  const load = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_CORE_PATH, "playwright-core", GLOBAL_CORE].filter((path): path is string => Boolean(path));
  for (const path of candidates) {
    try { return load(path); } catch { /* try next */ }
  }
  throw new Error("playwright-core not found. Set PLAYWRIGHT_CORE_PATH or install playwright-cli globally.");
}

/**
 * The globally installed playwright-core often wants a newer browser revision
 * than the one already cached. Use PLAYWRIGHT_EXECUTABLE_PATH, else the newest
 * cached Chromium, rather than downloading a browser.
 */
function cachedChromium(headless: boolean): string | undefined {
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const prefix = headless ? "chromium_headless_shell-" : "chromium-";
  const dirs = readdirSync(root).filter((name) => name.startsWith(prefix)).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  for (const dir of dirs) {
    const candidates = headless
      ? [join(root, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"), join(root, dir, "chrome-headless-shell-mac-x64", "chrome-headless-shell")]
      : [join(root, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
         join(root, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")];
    const found = candidates.find(existsSync);
    if (found) return found;
  }
  return undefined;
}

export class PlaywrightBridge {
  private browser?: Browser;
  private persistent?: BrowserContext & { close(): Promise<void> };
  private context?: BrowserContext;
  private pages = new Map<number, Page>();
  private nextTabId = 1;

  async connect(): Promise<void> {
    if (this.context) return;
    const headless = process.env.PLAYWRIGHT_HEADLESS === "1";
    const { chromium } = loadPlaywright();
    const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR;
    const context = { locale: "ja-JP", timezoneId: "Asia/Tokyo" };
    const open = async (executablePath?: string) => {
      if (userDataDir) {
        this.persistent = await chromium.launchPersistentContext(userDataDir, { headless, executablePath, ...context });
        this.context = this.persistent;
      } else {
        this.browser = await chromium.launch({ headless, executablePath });
        this.context = await this.browser.newContext(context);
      }
    };
    try {
      await open(process.env.PLAYWRIGHT_EXECUTABLE_PATH);
    } catch (error) {
      const fallback = process.env.PLAYWRIGHT_EXECUTABLE_PATH ? undefined : cachedChromium(headless);
      if (!fallback) throw error;
      await open(fallback);
    }
  }

  async request<T>(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (!this.context) throw new Error("Bridge is disconnected");
    const timeout = Number(params.timeoutMs ?? timeoutMs);
    // `wait: "domcontentloaded"` stops once the document is parsed, for pages whose
    // third-party trackers keep the load event from ever firing.
    const waitUntil = params.wait === "domcontentloaded" ? "domcontentloaded" as const : params.wait ? "load" as const : "commit" as const;
    switch (method) {
      case "new_tab": {
        const page = await this.context.newPage();
        const id = this.nextTabId++;
        this.pages.set(id, page);
        const response = await page.goto(String(params.url), { waitUntil, timeout });
        return { tab: { id, url: page.url() }, httpStatus: response?.status() } as T;
      }
      case "navigate": {
        const page = this.page(params);
        const response = await page.goto(String(params.url), { waitUntil, timeout });
        return { tab: { id: Number(params.tabId), url: page.url() }, httpStatus: response?.status() } as T;
      }
      case "evaluate": {
        try {
          const value = await this.page(params).evaluate(String(params.expression));
          return { result: { result: { value } } } as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { result: { exceptionDetails: { text: message, exception: { description: message } } } } as T;
        }
      }
      case "close_tab": {
        await this.pages.get(Number(params.tabId))?.close();
        this.pages.delete(Number(params.tabId));
        return {} as T;
      }
      default:
        throw new Error(`PlaywrightBridge does not support ${method}`);
    }
  }

  close(): void {
    // Adapters call close() synchronously at the end of a run.
    void (this.persistent ?? this.browser)?.close().catch(() => undefined);
    this.browser = undefined;
    this.persistent = undefined;
    this.context = undefined;
  }

  private page(params: Record<string, unknown>): Page {
    const page = this.pages.get(Number(params.tabId));
    if (!page) throw new Error(`Unknown tab ${String(params.tabId)}`);
    return page;
  }
}
