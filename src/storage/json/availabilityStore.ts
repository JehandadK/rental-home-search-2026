/**
 * data/availability.json: the latest availability check for each portal ad.
 *
 * An overlay kept apart from the source snapshots on purpose: refreshes and
 * `data:build` rewrite those files, and this evidence must survive them. It is
 * merged into the web payload at publish time. Newest check wins per ad.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adKey, type AvailabilityMap } from "../../domain/availability";
import type { AdAvailability } from "../../domain/types";
import { updateJsonFile } from "../../node/jsonFile";
import { DATA_DIR } from "./dataStore";

export const AVAILABILITY_PATH = join(DATA_DIR, "availability.json");

interface AvailabilityFile {
  schemaVersion: 1;
  records: AvailabilityMap;
}

export async function readAvailability(path = AVAILABILITY_PATH): Promise<AvailabilityMap> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, "utf8")) as AvailabilityFile;
  if (parsed.schemaVersion !== 1 || typeof parsed.records !== "object" || parsed.records === null) {
    throw new Error(`Unsupported availability file: ${path}`);
  }
  return parsed.records;
}

export type AvailabilityEntry = AdAvailability & { source: string; url: string };

/** Merge checks into the file under its lock; an older check never replaces a newer one. */
export async function recordAvailability(entries: readonly AvailabilityEntry[], path = AVAILABILITY_PATH): Promise<void> {
  if (!entries.length) return;
  await updateJsonFile<AvailabilityFile>(path, () => ({ schemaVersion: 1, records: {} }), (file) => {
    for (const entry of entries) {
      const key = adKey(entry.source, entry.url);
      const existing = file.records[key];
      if (!existing || Date.parse(entry.checkedAt) >= Date.parse(existing.checkedAt)) file.records[key] = entry;
    }
    return file;
  });
}
