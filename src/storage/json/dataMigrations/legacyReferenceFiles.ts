/** Read the original reference JSON files that the managed catalog was migrated from. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LegacyReferenceData } from "./legacyReference";

export const LEGACY_REFERENCE_FILES = [
  "pois.json",
  "mosques.json",
  "stations.json",
  "elementary_schools.json",
  "kindergartens.json",
  "bus_stops.json",
  "soka_boundary.json",
  "neighbor_boundaries.json",
] as const;

/** The parsed files plus the SHA-256 of each, as recorded in the catalog manifest. */
export async function readLegacyReferenceFiles(
  dataDir: string,
): Promise<{ legacy: LegacyReferenceData; sourceFiles: Record<string, string> }> {
  const parsed = new Map<string, unknown>();
  const sourceFiles: Record<string, string> = {};
  for (const file of LEGACY_REFERENCE_FILES) {
    const raw = await readFile(join(dataDir, file), "utf8");
    parsed.set(file, JSON.parse(raw) as unknown);
    sourceFiles[file] = createHash("sha256").update(raw).digest("hex");
  }
  return {
    legacy: {
      pois: parsed.get("pois.json") as LegacyReferenceData["pois"],
      mosques: parsed.get("mosques.json") as LegacyReferenceData["mosques"],
      stations: parsed.get("stations.json") as LegacyReferenceData["stations"],
      schools: parsed.get("elementary_schools.json") as LegacyReferenceData["schools"],
      childcare: parsed.get("kindergartens.json") as LegacyReferenceData["childcare"],
      busStops: parsed.get("bus_stops.json") as LegacyReferenceData["busStops"],
      sokaBoundary: parsed.get("soka_boundary.json") as LegacyReferenceData["sokaBoundary"],
      neighborBoundaries: parsed.get("neighbor_boundaries.json") as LegacyReferenceData["neighborBoundaries"],
    },
    sourceFiles,
  };
}
