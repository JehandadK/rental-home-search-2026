/**
 * data/ur-history.json: every UR room sighting we hold, open or closed
 * (see src/domain/urRooms.ts). Additive: a write adds sweeps, page reads and
 * periods and never removes one, so a later partial read cannot erase what an
 * earlier one saw. The rooms page is derived from it at publish time.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyUrHistory, type RakuchinEstatePage, type RakuchinPeriod, type UrHistoryFile, type UrSweepRecord } from "../../domain/urRooms";
import { updateJsonFile } from "../../node/jsonFile";
import { DATA_DIR } from "./dataStore";

export const UR_HISTORY_PATH = join(DATA_DIR, "ur-history.json");

function parse(text: string, path: string): UrHistoryFile {
  const parsed = JSON.parse(text) as UrHistoryFile;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sweeps) || !Array.isArray(parsed.estatePages) || typeof parsed.periods !== "object" || parsed.periods === null) {
    throw new Error(`Unsupported UR history file: ${path}`);
  }
  return parsed;
}

export async function readUrHistory(path = UR_HISTORY_PATH): Promise<UrHistoryFile> {
  if (!existsSync(path)) return emptyUrHistory();
  return parse(await readFile(path, "utf8"), path);
}

export interface UrHistoryAdditions {
  sweeps?: readonly UrSweepRecord[];
  estatePages?: readonly RakuchinEstatePage[];
  periods?: readonly [string, RakuchinPeriod][];
}

/** Merge additions into a history: sweeps by time, page reads by estate and time, periods by row id (the first read is kept). */
export function addToUrHistory(history: UrHistoryFile, additions: UrHistoryAdditions): { history: UrHistoryFile; added: { sweeps: number; estatePages: number; periods: number } } {
  const sweepTimes = new Set(history.sweeps.map((sweep) => sweep.capturedAt));
  const pageKeys = new Set(history.estatePages.map((page) => `${page.estateCode}@${page.capturedAt}`));
  const sweeps = (additions.sweeps ?? []).filter((sweep) => !sweepTimes.has(sweep.capturedAt) && sweepTimes.add(sweep.capturedAt));
  const estatePages = (additions.estatePages ?? []).filter((page) => {
    const key = `${page.estateCode}@${page.capturedAt}`;
    return !pageKeys.has(key) && pageKeys.add(key);
  });
  const periods = { ...history.periods };
  let addedPeriods = 0;
  for (const [id, period] of additions.periods ?? []) {
    if (periods[id]) continue;
    periods[id] = period;
    addedPeriods++;
  }
  const byTime = <T>(at: (item: T) => string) => (a: T, b: T) => Date.parse(at(a)) - Date.parse(at(b));
  return {
    history: {
      schemaVersion: 1,
      sweeps: [...history.sweeps, ...sweeps].sort(byTime((sweep) => sweep.capturedAt)),
      estatePages: [...history.estatePages, ...estatePages].sort(byTime((page) => page.capturedAt)),
      periods,
    },
    added: { sweeps: sweeps.length, estatePages: estatePages.length, periods: addedPeriods },
  };
}

/** Add to data/ur-history.json under its lock. */
export async function recordUrHistory(additions: UrHistoryAdditions, path = UR_HISTORY_PATH) {
  let added = { sweeps: 0, estatePages: 0, periods: 0 };
  await updateJsonFile(path, emptyUrHistory, (current) => {
    const result = addToUrHistory(parse(JSON.stringify(current), path), additions);
    added = result.added;
    return result.history;
  });
  return added;
}
