import type { RawListing } from "../../src/domain/types";
import type { SourceFile } from "./dataStore";
import { trackingKey } from "./lifecycle";

/** Reconcile actual capture evidence from ANY contributing ad, never build time. */
export function restoreObservedLifecycle(rows: RawListing[], previous: readonly RawListing[], sources: readonly SourceFile[], authoritative = false): void {
  const previousByKey = new Map(previous.map((l) => [trackingKey(l), l]));
  const evidence = new Map<string, string>();
  const identities = (l: RawListing) => [
    `${l.source}|key:${trackingKey(l)}`,
    ...(l.id ? [`${l.source}|id:${l.id}`] : []),
    ...(l.url ? [`${l.source}|url:${l.url}`] : []),
  ];
  for (const source of sources) {
    const keys = new Set(Array.isArray(source.provenance?.observedTrackingKeys) ? source.provenance.observedTrackingKeys as string[] : []);
    const times = (source.provenance?.observedAtByKey ?? {}) as Record<string, string>;
    for (const listing of source.listings) {
      const key = trackingKey(listing);
      const at = times[key] ?? (source.completeSnapshot === true || keys.has(key) ? source.scrapedAt : undefined);
      if (!at || !Number.isFinite(Date.parse(at))) continue;
      for (const identity of identities(listing)) if (!evidence.has(identity) || Date.parse(at) > Date.parse(evidence.get(identity)!)) evidence.set(identity, at);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (authoritative && row.status === "sold") continue;
    const prior = previousByKey.get(trackingKey(row));
    const aliases = [...identities(row), ...(row.sourceListings ?? []).flatMap((ref) => [
      ...(ref.id ? [`${ref.source}|id:${ref.id}`] : []), ...(ref.url ? [`${ref.source}|url:${ref.url}`] : []),
    ])];
    const at = aliases.map((key) => evidence.get(key)).filter((x): x is string => Boolean(x)).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    // Old preserved evidence cannot reactivate a listing delisted after it.
    if (at && (!prior?.soldAt || Date.parse(at) > Date.parse(prior.soldAt))) {
      rows[i] = { ...row, status: "active", soldAt: null,
        firstSeenAt: prior ? prior.firstSeenAt : row.firstSeenAt,
        lastSeenAt: prior?.lastSeenAt && Date.parse(prior.lastSeenAt) > Date.parse(at) ? prior.lastSeenAt : at };
    } else if (prior) {
      rows[i] = { ...row, status: prior.status, firstSeenAt: prior.firstSeenAt, lastSeenAt: prior.lastSeenAt, soldAt: prior.soldAt };
    } else {
      rows[i] = { ...row, lastSeenAt: at ?? null };
    }
  }
}
