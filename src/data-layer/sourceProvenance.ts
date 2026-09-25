/** Capture provenance may be replaced; application-owned replay/freshness state may not be dropped by omission. */
export const MANAGED_INGESTION_PROVENANCE_KEYS = ["ingestionJournal", "detailObservedAtByUrl"] as const;

export function mergeSourceProvenance(
  previous: Readonly<Record<string, unknown>> | undefined,
  incoming: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!incoming) return previous ? { ...previous } : undefined;
  const next = { ...incoming };
  for (const key of MANAGED_INGESTION_PROVENANCE_KEYS) {
    if (next[key] === undefined && previous && Object.hasOwn(previous, key)) next[key] = previous[key];
  }
  return next;
}
