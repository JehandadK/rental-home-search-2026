import type { RefreshStageRecord } from "./refreshLedger";
import { TARGET_CITY_LABELS } from "../collectors/shared/targetCities";

/** One Nifty list stage per target city: "nifty-soka", "nifty-katsushika", … */
export const niftyStageId = (cityLabel: string): string => `nifty-${cityLabel.toLowerCase()}`;
export const NIFTY_CITY_STAGES: readonly string[] = TARGET_CITY_LABELS.map(niftyStageId);

/** Only dependencies, not stage order, invalidate successfully completed work. */
export const DEPENDENCIES: Record<string, readonly string[]> = {
  "suumo-parking": ["suumo"],
  "nifty-import": NIFTY_CITY_STAGES,
  "detail-enrich": ["suumo", "athome", "roomspot", "nifty-import"],
  "data-build": ["suumo", "suumo-parking", "athome", "roomspot", "nifty-import", "detail-enrich"],
  enrich: ["data-build"],
  "web-data": ["enrich"],
};
export const NETWORK_STAGES = new Set(["suumo", "suumo-parking", "athome", "roomspot", ...NIFTY_CITY_STAGES, "detail-enrich"]);

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

/**
 * Portal collectors read only the portal and write only their own source file,
 * so collectors for different sources can run at the same time. Everything
 * downstream (Nifty import, details, merge, geocode, web payload) depends on
 * their output and stays sequential.
 */
export const PARALLEL_COLLECTOR_STAGES = new Set(["suumo", "athome", "roomspot", ...NIFTY_CITY_STAGES]);

/**
 * Stages that write the same source file (the Nifty cities share nifty.json)
 * must not commit at the same time: the store's revision check rejects the loser.
 * They form one group that runs in order; different groups run concurrently.
 */
export const collectorGroup = (stageId: string): string => stageId.startsWith("nifty-") ? "nifty" : stageId;

/** Run `task` over `items` with at most `limit` in flight; results keep input order. */
export async function runLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Chromium allows one instance per user-data directory, so concurrent collectors
 * cannot all launch PLAYWRIGHT_USER_DATA_DIR. Only AtHome needs the session whose
 * verification was passed by hand; every other stage gets a fresh, non-persistent
 * Playwright context.
 */
export const PERSISTENT_PROFILE_STAGE = "athome";

/** Child-process environment for a stage; never mutates `env`. */
export function stageEnv(stageId: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (stageId === PERSISTENT_PROFILE_STAGE || env.PLAYWRIGHT_USER_DATA_DIR == null) return env;
  const { PLAYWRIGHT_USER_DATA_DIR: _profile, ...rest } = env;
  return rest;
}
