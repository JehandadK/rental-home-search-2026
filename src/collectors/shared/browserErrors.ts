/**
 * The local Playwright browser could not be started. No portal request was
 * made, so callers must not treat it as a portal failure (no per-ad backoff,
 * no circuit breaker).
 */
export class BrowserUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserUnavailableError";
  }
}
