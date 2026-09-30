import type { RefreshStageRecord } from "./refreshLedger";

/** Only dependencies, not stage order, invalidate successfully completed work. */
export const DEPENDENCIES: Record<string, readonly string[]> = {
  "suumo-parking": ["suumo"],
  "nifty-import": ["nifty-soka", "nifty-koshigaya", "nifty-kawaguchi"],
  "detail-enrich": ["suumo", "athome", "roomspot", "nifty-import"],
  "data-build": ["suumo", "suumo-parking", "athome", "roomspot", "nifty-import", "detail-enrich"],
  enrich: ["data-build"],
  "web-data": ["enrich"],
};
export const NETWORK_STAGES = new Set(["suumo", "suumo-parking", "athome", "roomspot", "nifty-soka", "nifty-koshigaya", "nifty-kawaguchi", "detail-enrich"]);

/**
 * Emergency ceiling, not the normal incremental stopping condition.
 *
 * Newest-first collectors must normally continue until they cross the prior
 * observation boundary (two consecutive all-known pages). A tiny fixed budget
 * can strand fresh ads behind busy or imperfectly grouped result pages, so the
 * default is deliberately much larger than an ordinary refresh should need.
 * `--max-pages` remains available as an explicit diagnostic/operator cap.
 */
export const DEFAULT_INCREMENTAL_PAGE_CEILING = 100;

export function planRefresh(stages: readonly RefreshStageRecord[], resume: boolean): Set<string> {
  const planned = new Set<string>();
  for (const stage of stages) {
    if (stage.status === "skipped") continue;
    if (!resume || stage.status !== "success" || (DEPENDENCIES[stage.id] ?? []).some((id) => planned.has(id))) {
      planned.add(stage.id);
    }
  }
  return planned;
}

export function positiveInteger(value: string | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum) throw new Error(`Expected integer >= ${minimum}, got ${value}`);
  return n;
}

/** Empty parsed results, an overlap boundary or a page cap are NOT exhaustion evidence. */
export function completeMarket(requestedFull: boolean, cities: readonly { exhausted: boolean }[]): boolean {
  return requestedFull && cities.length > 0 && cities.every((city) => city.exhausted);
}
