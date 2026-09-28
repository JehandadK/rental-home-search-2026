import type { RawListing } from "../../types";
import type { ListingSourceSnapshot, SourceReconciliation } from "../contracts";
import { indexSourceRows, sourceRowKey, sourceRowLocator } from "../sourceRowIdentity";

/**
 * Translate an approved source merger's result into explicit, non-destructive exact-row changes.
 * Retained rows keep their prior storage position; new rows are appended in merge order.
 */
export function exactReconciliation(source: string, previous: ListingSourceSnapshot | null, listings: readonly RawListing[], observedAt: string,
  provenance: Readonly<Record<string, unknown>>): SourceReconciliation {
  const prior = indexSourceRows(previous?.listings ?? []);
  const current = indexSourceRows(listings);
  const ordered = [...prior.keys()].filter((key) => current.has(key)).map((key) => current.get(key)!);
  for (const [key, row] of current) if (!prior.has(key)) ordered.push(row);
  return { source, expectedRevision: previous?.revision ?? null, observedAt, listings: ordered, provenance,
    retirements: (previous?.listings ?? []).filter((row) => !current.has(sourceRowKey(sourceRowLocator(row)))).map((row) => ({
      ...sourceRowLocator(row), effectiveAt: observedAt,
      reason: `Superseded by a newer ${source} observation with matching source aliases (exact-row reconciliation); not evidence of delisting`,
    })) };
}
