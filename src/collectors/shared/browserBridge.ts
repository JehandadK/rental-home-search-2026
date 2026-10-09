import { PlaywrightBridge } from "./playwrightBridge";

/** Minimal surface the portal browser adapters need from a browser driver. */
export interface BrowserBridge {
  connect(): Promise<void>;
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): void;
}

/** The headed browser every portal page loads in: a locally launched Playwright Chromium. */
export function createBridge(): BrowserBridge {
  return new PlaywrightBridge();
}
