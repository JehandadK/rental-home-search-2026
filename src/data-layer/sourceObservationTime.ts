import type { RawListing } from "../domain/types";
import { trackingKey } from "../domain/listingIdentity";

interface SourceTimes {
  scrapedAt: string;
  completeSnapshot?: boolean;
  provenance?: Readonly<Record<string, unknown>>;
}

/** Imported history has no per-source capture evidence for unobserved rows. */
export function sourceObservationFallbackTime(source: SourceTimes | null | undefined): string | undefined {
  if (!source) return undefined;
  if (source.provenance?.bootstrapAudit && source.completeSnapshot !== true) return undefined;
  return source.scrapedAt;
}

/** Keep the legacy string envelope without displaying/using import time as a capture. */
export function sourceSnapshotCaptureTime(source: SourceTimes): string | undefined {
  const audit = source.provenance?.bootstrapAudit as { importedAt?: unknown } | undefined;
  if (audit?.importedAt !== source.scrapedAt || source.completeSnapshot === true) return source.scrapedAt;
  const times = source.provenance?.observedAtByKey;
  if (!times || typeof times !== "object" || Array.isArray(times)) return undefined;
  return Object.values(times).filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
}

/** Older replayed captures can enrich new IDs, but cannot overwrite newer ads. */
export function newerRows(previous: (SourceTimes & { listings: readonly RawListing[] }) | null, rows: readonly RawListing[], at: string, aliases: (l: RawListing) => string[]): RawListing[] {
  const index = new Map((previous?.listings ?? []).flatMap((l) => aliases(l).map((key) => [key, l] as const)));
  const times = (previous?.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  return rows.filter((row) => {
    const prior = aliases(row).map((key) => index.get(key)).find(Boolean);
    const previousTime = prior ? times[trackingKey(prior)] ?? sourceObservationFallbackTime(previous) : undefined;
    return previousTime === undefined || Date.parse(at) >= Date.parse(previousTime);
  });
}
