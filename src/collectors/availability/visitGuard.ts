/**
 * Keeps a run of ad-page visits inside its page-load budget and off a portal
 * that has started refusing them.
 *
 * A portal is paused for the rest of the run after one verification or busy
 * page, or after two visits in a row that could not be read. Its remaining ads
 * are reported as not visited (never as gone) and cost no page load, so the
 * other portals' checks still go ahead.
 */
import type { AdCheck } from "./checkProperty";

const FAILURES_BEFORE_PAUSE = 2;
const NOT_VISITED = "not visited";

export class VisitGuard {
  loads = 0;
  private readonly paused = new Map<string, string>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly maxLoads: number) {}

  /** No page loads left: start no further property. */
  get exhausted(): boolean {
    return this.loads >= this.maxLoads;
  }

  /** Portals paused this run, with the reason. */
  get pausedPortals(): ReadonlyMap<string, string> {
    return this.paused;
  }

  /** Call before each page load; throws, without counting a load, for a paused portal. */
  admit(source: string): void {
    const reason = this.paused.get(source);
    if (reason) throw new Error(`${NOT_VISITED}: ${source} paused after ${reason}`);
    this.loads++;
  }

  /** Feed back a property's results so a refusing portal gets paused. */
  record(ads: readonly AdCheck[]): void {
    for (const ad of ads) {
      if (ad.verdict === "known-gone" || ad.evidence.includes(NOT_VISITED)) continue;
      if (ad.verdict !== "unknown") {
        this.failures.delete(ad.source);
        continue;
      }
      const failures = (this.failures.get(ad.source) ?? 0) + 1;
      this.failures.set(ad.source, failures);
      const refused = /^verification or busy page/.test(ad.evidence);
      if (refused || failures >= FAILURES_BEFORE_PAUSE) {
        this.paused.set(ad.source, refused ? "a verification or busy page" : `${failures} unreadable pages in a row`);
      }
    }
  }
}
