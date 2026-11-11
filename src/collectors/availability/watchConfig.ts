/**
 * The `availability` block of `collectors.config.json`: which homes a refresh
 * re-checks and how many ad pages it may load doing so.
 *
 * The dashboard keeps the owner's weights and filters in the browser, where a
 * script cannot read them, so the criteria that decide which homes are "top"
 * are repeated here as a recommendations API request (RECOMMENDATIONS_API.md):
 * `{ "weights": { … }, "filters": { … }, "travel": { … } }`. Anything left out
 * keeps its default. A missing or malformed file means the defaults below.
 */
import { readFileSync } from "node:fs";
import { COLLECTOR_CONFIG_PATH } from "../../node/dataPaths";

export interface WatchConfig {
  /** How many of the best-scoring homes to watch. */
  top: number;
  /** Ad pages one refresh may load for these checks; 0 turns the stage off. */
  pageLoads: number;
  /** Homes confirmed on offer within this many days are not visited. */
  staleDays: number;
  /** A recommendations API request body; `{}` ranks with the default weights. */
  criteria: Record<string, unknown>;
}

export const DEFAULT_WATCH: WatchConfig = { top: 300, pageLoads: 60, staleDays: 5, criteria: {} };

const count = (value: unknown, fallback: number, minimum: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : fallback;

export function parseWatchConfig(raw: unknown): WatchConfig {
  const block = (raw as { availability?: Record<string, unknown> } | null)?.availability;
  if (!block || typeof block !== "object") return DEFAULT_WATCH;
  const criteria = block.criteria;
  return {
    top: count(block.top, DEFAULT_WATCH.top, 1),
    pageLoads: count(block.pageLoads, DEFAULT_WATCH.pageLoads, 0),
    staleDays: count(block.staleDays, DEFAULT_WATCH.staleDays, 0),
    criteria: criteria && typeof criteria === "object" && !Array.isArray(criteria) ? criteria as Record<string, unknown> : {},
  };
}

export function readWatchConfig(path = COLLECTOR_CONFIG_PATH): WatchConfig {
  try {
    return parseWatchConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_WATCH;
  }
}
