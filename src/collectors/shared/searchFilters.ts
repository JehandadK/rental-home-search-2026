/**
 * Per-source search filters for the list collectors, from
 * `collectors.config.json` with a `--min-area N` override per run.
 *
 * A minimum floor area is sent as the portal's own search parameter where the
 * portal has one in its URL (each value was read from the portal's search
 * form in the headed browser on 2026-10-12):
 *   SUUMO     mb=<m²>&mt=9999999      steps 20, 25 … 70, 80, 90, 100
 *   Nifty     r10=<m²>                steps 10, 15 … 100
 *   RoomSpot  occupied_area_from=<m²>.0  steps 20, 25 … 70, 80, 90, 100
 * A minimum between steps rounds down, so no qualifying home is excluded.
 * The AtHome/RoomSpot collector also drops each page's rooms below the exact
 * minimum (`keepsArea`): AtHome keeps its search conditions in the browser
 * session rather than the URL, so that is its only filter. SUUMO and Nifty
 * rely on the portal search alone, so a minimum between steps may bring in a
 * few slightly smaller homes.
 */
import { readFileSync } from "node:fs";
import { COLLECTOR_CONFIG_PATH } from "../../node/dataPaths";

export type CollectorSource = "suumo" | "athome" | "roomspot" | "nifty" | "ur";

export interface CollectorSettings {
  /** Collect only homes with at least this floor area; null for any. */
  minAreaM2: number | null;
}

const NONE: CollectorSettings = { minAreaM2: null };

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

/** The minimum-area values each portal's search form offers. */
export const AREA_STEPS: Partial<Record<CollectorSource, readonly number[]>> = {
  suumo: [...range(20, 70, 5), 80, 90, 100],
  nifty: range(10, 100, 5),
  roomspot: [...range(20, 70, 5), 80, 90, 100],
};

const validArea = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** Every source's settings from the config file; a missing or malformed file means no filters. */
export function readCollectorConfig(path = COLLECTOR_CONFIG_PATH): Record<string, CollectorSettings> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
  const sources = (raw as { sources?: unknown })?.sources;
  if (!sources || typeof sources !== "object") return {};
  return Object.fromEntries(Object.entries(sources as Record<string, { minAreaM2?: unknown }>)
    .map(([source, settings]) => [source, { minAreaM2: validArea(settings?.minAreaM2) }]));
}

/** This run's settings for a source: `--min-area N` (0 = off) beats the config file. */
export function collectorSettings(
  source: CollectorSource,
  args: readonly string[],
  config: Record<string, CollectorSettings> = readCollectorConfig(),
): CollectorSettings {
  if (source === "ur") return NONE;
  const flag = args.indexOf("--min-area");
  if (flag >= 0) {
    const value = Number(args[flag + 1]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--min-area needs a number of square metres (0 = any), not ${args[flag + 1] ?? "nothing"}`);
    return { minAreaM2: validArea(value) };
  }
  return config[source] ?? NONE;
}

/** The largest step the portal offers at or below the minimum, or null when it offers none. */
export function portalAreaStep(source: CollectorSource, minAreaM2: number | null): number | null {
  const steps = AREA_STEPS[source];
  if (minAreaM2 == null || !steps) return null;
  return [...steps].reverse().find((step) => step <= minAreaM2) ?? null;
}

/** The portal search URL with its minimum-area parameter added. */
export function withMinArea(source: CollectorSource, url: string, minAreaM2: number | null): string {
  const step = portalAreaStep(source, minAreaM2);
  if (step == null) return url;
  const join = url.includes("?") ? "&" : "?";
  switch (source) {
    case "suumo": return `${url}${join}mb=${step}&mt=9999999`;
    case "nifty": return `${url}${join}r10=${step}`;
    case "roomspot": return `${url}${join}occupied_area_from=${step.toFixed(1)}`;
    default: return url;
  }
}

/** Keep a room at or above the minimum; one with no stated area is kept. */
export const keepsArea = (sizeM2: number | null | undefined, minAreaM2: number | null): boolean =>
  minAreaM2 == null || sizeM2 == null || sizeM2 >= minAreaM2;

/** One log line saying what this run collects. */
export function describeSettings(source: CollectorSource, settings: CollectorSettings): string {
  if (source === "ur") return "Area filter: none (UR sweeps every room of each estate)";
  if (settings.minAreaM2 == null) return "Area filter: none";
  const step = portalAreaStep(source, settings.minAreaM2);
  const roomsToo = source === "athome" || source === "roomspot";
  if (step == null) return `Area filter: ≥${settings.minAreaM2}㎡ (applied to each page's rooms)`;
  return `Area filter: ≥${settings.minAreaM2}㎡ (portal search ≥${step}㎡${roomsToo ? ", then each page's rooms" : ""})`;
}
