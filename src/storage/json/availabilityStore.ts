/**
 * data/availability.json: availability checks for each portal ad.
 *
 * An overlay kept apart from the source snapshots on purpose: refreshes and
 * `data:build` rewrite those files, and this evidence must survive them. It is
 * merged into the web payload at publish time. The newest check per ad is the
 * record itself; every earlier check is kept in its `history`, so the first
 * time an ad was found gone is never overwritten.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adKey, type AvailabilityMap } from "../../domain/availability";
import type { AdAvailability } from "../../domain/types";
import { updateJsonFile } from "../../node/jsonFile";
import { DATA_DIR } from "./dataStore";

export const AVAILABILITY_PATH = join(DATA_DIR, "availability.json");

export type AvailabilityEntry = AdAvailability & { source: string; url: string };

/**
 * The newest check for one ad, with every earlier check (oldest first). A
 * history entry keeps the URL it checked, since one record can cover several
 * ads (a SUUMO jnc with several bc codes).
 */
export type StoredAvailability = AvailabilityEntry & { history?: (AdAvailability & { url?: string })[] };

export interface AvailabilityFile {
  schemaVersion: 1;
  records: Record<string, StoredAvailability>;
}

export function parseAvailabilityFile(text: string, path = AVAILABILITY_PATH): AvailabilityFile {
  const parsed = JSON.parse(text) as AvailabilityFile;
  if (parsed.schemaVersion !== 1 || typeof parsed.records !== "object" || parsed.records === null) {
    throw new Error(`Unsupported availability file: ${path}`);
  }
  return parsed;
}

export async function readAvailabilityFile(path = AVAILABILITY_PATH): Promise<AvailabilityFile> {
  if (!existsSync(path)) return { schemaVersion: 1, records: {} };
  return parseAvailabilityFile(await readFile(path, "utf8"), path);
}

/** The newest check per ad, as consumers overlay it. */
export async function readAvailability(path = AVAILABILITY_PATH): Promise<AvailabilityMap> {
  return (await readAvailabilityFile(path)).records;
}

type Check = AdAvailability & { url?: string };
const checkOf = ({ state, checkedAt, evidence, method, url }: Check): Check => ({ state, checkedAt, evidence, method, ...(url ? { url } : {}) });
const sameCheck = (a: Check, b: Check) =>
  a.checkedAt === b.checkedAt && a.state === b.state && a.method === b.method && a.evidence === b.evidence && (!a.url || !b.url || a.url === b.url);

/**
 * Add checks to the file under its lock. The newest check per ad becomes the
 * record; all others, older ones included, are kept in its history.
 */
export async function recordAvailability(entries: readonly AvailabilityEntry[], path = AVAILABILITY_PATH): Promise<void> {
  if (!entries.length) return;
  await updateJsonFile<AvailabilityFile>(path, () => ({ schemaVersion: 1, records: {} }), (file) => {
    for (const entry of entries) {
      const key = adKey(entry.source, entry.url);
      const existing = file.records[key];
      // As before, a check at least as new as the current one becomes current.
      const current = !existing || Date.parse(entry.checkedAt) >= Date.parse(existing.checkedAt) ? entry : existing;
      const history = [...(existing?.history ?? []), ...(existing ? [checkOf(existing)] : []), checkOf(entry)]
        .filter((check, i, all) => !sameCheck(check, current) && all.findIndex((other) => sameCheck(other, check)) === i)
        .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
      const { url: _url, ...latest } = checkOf(current);
      file.records[key] = { ...latest, source: current.source, url: current.url, ...(history.length ? { history } : {}) };
    }
    return file;
  });
}
