/**
 * Check whether one property is still available, as cheaply as possible.
 *
 * A property is available if ANY of its portal ads is live, so ads are visited
 * in a fixed cheapest-first order and the walk stops at the first live one.
 * Ads already known to be gone are not visited again. Only positive
 * evidence is recorded: an `unknown` visit (verification page, timeout) is
 * reported but never written as gone.
 */
import { adKey, type AvailabilityMap } from "../../domain/availability";
import { sourceListings } from "../../domain/listingDedup";
import type { AdAvailability, RawListing } from "../../domain/types";
import { classifyAdVisit, type AdVerdict, type AdVisit } from "./classify";

/** Light, reliable pages first; AtHome (large, verification-prone) last. */
const PROBE_ORDER = ["nifty", "suumo", "roomspot", "yahoo", "athome"];
const rank = (source: string) => (PROBE_ORDER.includes(source) ? PROBE_ORDER.indexOf(source) : PROBE_ORDER.length);

export interface AdCheck {
  source: string;
  url: string;
  verdict: AdVerdict["state"] | "known-gone";
  evidence: string;
}

export interface PropertyCheck {
  ads: AdCheck[];
  /** Every ad is now known gone. */
  rentedOut: boolean;
  /** Fresh results to persist (probe-derived, positive evidence only). */
  records: Array<AdAvailability & { source: string; url: string }>;
}

export interface CheckDependencies {
  visit(ad: { source: string; url: string }): Promise<AdVisit>;
  now(): string;
  sleep(ms: number): Promise<void>;
  delayMs: number;
}

export async function checkProperty(listing: RawListing, known: AvailabilityMap, deps: CheckDependencies): Promise<PropertyCheck> {
  const ads = sourceListings(listing)
    .filter((ad): ad is typeof ad & { url: string } => Boolean(ad.url))
    .sort((a, b) => rank(a.source) - rank(b.source));
  const result: PropertyCheck = { ads: [], rentedOut: false, records: [] };
  let goneCount = 0;
  let visited = false;

  for (const ad of ads) {
    if (known[adKey(ad.source, ad.url, ad.id)]?.state === "gone" || ad.availability?.state === "gone") {
      goneCount++;
      result.ads.push({ source: ad.source, url: ad.url, verdict: "known-gone", evidence: "already recorded as gone" });
      continue;
    }
    if (visited) await deps.sleep(deps.delayMs);
    visited = true;
    let verdict: AdVerdict;
    try {
      verdict = classifyAdVisit(ad.source, await deps.visit({ source: ad.source, url: ad.url }));
    } catch (error) {
      verdict = { state: "unknown", evidence: `visit failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
    }
    result.ads.push({ source: ad.source, url: ad.url, verdict: verdict.state, evidence: verdict.evidence });
    if (verdict.state !== "unknown") {
      result.records.push({ source: ad.source, url: ad.url, state: verdict.state, checkedAt: deps.now(), evidence: verdict.evidence, method: "probe" });
    }
    if (verdict.state === "gone") goneCount++;
    if (verdict.state === "listed") break; // available somewhere: no need to visit the rest
  }

  result.rentedOut = ads.length > 0 && goneCount === ads.length;
  return result;
}
