/**
 * One headed Chromium window, on one persistent profile, that every portal
 * collector of a run attaches to (PLAYWRIGHT_CDP_URL) and opens its own tabs in,
 * instead of each launching and closing a fresh browser. Every site keeps its
 * cookies and any verification passed by hand, as a person's browser would.
 *
 * Chromium listens on a free localhost port (--remote-debugging-port=0) and
 * writes it to <profile>/DevToolsActivePort; the port is open only while the
 * shared browser runs.
 */
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cachedChromium, loadPlaywright, type LaunchOptions } from "./playwrightBridge";

/** The profile shared by every portal when PLAYWRIGHT_USER_DATA_DIR is not set. */
export const DEFAULT_SHARED_PROFILE = ".context/browser-profile";

export interface SharedBrowser {
  /** For PLAYWRIGHT_CDP_URL, e.g. "http://127.0.0.1:53114". */
  cdpUrl: string;
  userDataDir: string;
  close(): Promise<void>;
}

const PORT_FILE_WAIT_MS = 15_000;

/** The DevTools port Chromium wrote for this profile, from the first line of DevToolsActivePort. */
export function devToolsPort(portFile: string): number | undefined {
  const port = Number(portFile.split("\n")[0]?.trim());
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

export async function openSharedBrowser(userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR ?? DEFAULT_SHARED_PROFILE): Promise<SharedBrowser> {
  const dir = resolve(userDataDir);
  const portFile = join(dir, "DevToolsActivePort");
  // A file left by an earlier, crashed browser would name a dead port.
  await rm(portFile, { force: true });
  const headless = process.env.PLAYWRIGHT_HEADLESS === "1";
  const { chromium } = loadPlaywright();
  const options = (executablePath?: string): LaunchOptions => ({
    headless, executablePath, locale: "ja-JP", timezoneId: "Asia/Tokyo", args: ["--remote-debugging-port=0"],
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
    port = devToolsPort(await readFile(portFile, "utf8").catch(() => ""));
    if (!port) await new Promise((done) => setTimeout(done, 200));
  }
  if (!port) {
    await context.close().catch(() => undefined);
    throw new Error(`The shared browser did not report its DevTools port in ${portFile}`);
  }
  return { cdpUrl: `http://127.0.0.1:${port}`, userDataDir: dir, close: () => context.close() };
}
