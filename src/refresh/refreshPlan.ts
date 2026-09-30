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

/** Empty parsed results, an overlap boundary or a page cap are NOT exhaustion evidence. */
export function completeMarket(requestedFull: boolean, cities: readonly { exhausted: boolean }[]): boolean {
  return requestedFull && cities.length > 0 && cities.every((city) => city.exhausted);
}
