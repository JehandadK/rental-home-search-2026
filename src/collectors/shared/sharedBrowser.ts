/**
 * One headed Chromium window, on one persistent profile, that every portal
 * collector of a run attaches to (PLAYWRIGHT_CDP_URL) and opens its own tabs in,
 * instead of each launching and closing a fresh browser. Every site keeps its
 * cookies and any verification passed by hand, as a person's browser would.
 *
 * Chromium listens on a free localhost port (--remote-debugging-port=0) and
 * writes it to <profile>/DevToolsActivePort; the port is open only while the
 * shared browser runs. The caller owns shutdown: Playwright's own signal handlers
 * are off, so a refresh can save its checkpoint before the browser goes.
 */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cachedChromium, loadPlaywright, type LaunchOptions } from "./playwrightBridge";

/** The profile shared by every portal when PLAYWRIGHT_USER_DATA_DIR is not set. */
export const DEFAULT_SHARED_PROFILE = ".context/browser-profile";

export interface SharedBrowser {
  /** For PLAYWRIGHT_CDP_URL, e.g. "http://127.0.0.1:53114". */
  cdpUrl: string;
  userDataDir: string;
  close(): Promise<void>;
  /** Runs once if the browser goes away on its own (window quit, crash), not on close(). */
  onUnexpectedClose(listener: () => void): void;
}

const PORT_FILE_WAIT_MS = 15_000;

/**
 * The DevTools port Chromium wrote for this profile: the first line of
 * DevToolsActivePort, once the second (the browser path) shows it is complete.
 */
export function devToolsPort(portFile: string): number | undefined {
  const [first, second] = portFile.split("\n");
  if (!second?.trim()) return undefined;
  const port = Number(first.trim());
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

export async function openSharedBrowser(userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR ?? DEFAULT_SHARED_PROFILE): Promise<SharedBrowser> {
  const dir = resolve(userDataDir);
  const portFile = join(dir, "DevToolsActivePort");
  // Only a port file written by this launch counts: an older one names a dead port, and a
  // browser already open on the profile makes the launch fail without touching its file.
  const launchedAt = Date.now() - 1_000;
  const headless = process.env.PLAYWRIGHT_HEADLESS === "1";
  const { chromium } = loadPlaywright();
  const options = (executablePath?: string): LaunchOptions => ({
    headless, executablePath, locale: "ja-JP", timezoneId: "Asia/Tokyo", args: ["--remote-debugging-port=0"],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  });
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, options(process.env.PLAYWRIGHT_EXECUTABLE_PATH));
  } catch (error) {
    const fallback = process.env.PLAYWRIGHT_EXECUTABLE_PATH ? undefined : cachedChromium(headless);
    if (!fallback) throw error;
    context = await chromium.launchPersistentContext(dir, options(fallback));
  }
  const deadline = Date.now() + PORT_FILE_WAIT_MS;
  let port: number | undefined;
  while (!port && Date.now() < deadline) {
    const fresh = ((await stat(portFile).catch(() => undefined))?.mtimeMs ?? 0) >= launchedAt;
    if (fresh) port = devToolsPort(await readFile(portFile, "utf8").catch(() => ""));
    if (!port) await new Promise((done) => setTimeout(done, 200));
  }
  if (!port) {
    await context.close().catch(() => undefined);
    throw new Error(`The shared browser did not report its DevTools port in ${portFile}`);
  }
  let closing = false;
  const unexpected: Array<() => void> = [];
  context.on?.("close", () => { if (!closing) for (const listener of unexpected) listener(); });
  return {
    cdpUrl: `http://127.0.0.1:${port}`,
    userDataDir: dir,
    close: () => { closing = true; return context.close(); },
    onUnexpectedClose: (listener) => { unexpected.push(listener); },
  };
}
