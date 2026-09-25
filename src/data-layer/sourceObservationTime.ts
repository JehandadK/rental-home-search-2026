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
