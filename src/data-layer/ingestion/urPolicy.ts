/**
 * UR賃貸住宅 rooms (www.ur-net.go.jp). A room's identity is UR's own estate
 * code plus room code (`ur-50_4090-000010701`), so a fresh observation
 * replaces the row with the same id and every other row is kept: a room UR
 * stops listing stays here until its own page says it is gone (an
 * availability record), never because a sweep missed it.
 */
import type { RawListing } from "../../domain/types";
import { UR_SOURCE } from "../../domain/ur";
import type { ListingSourceSnapshot } from "../contracts";
import type { ScrapeBatch } from "./contracts";
import { exactReconciliation } from "./reconciliation";
import type { SourcePolicy } from "./sourcePolicy";

export function prepareUrBatch(batch: ScrapeBatch, previous: ListingSourceSnapshot | null) {
  const prior = previous?.listings ?? [];
  const priorTimes = (previous?.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const byId = new Map(prior.map((row) => [row.id, row]));
  // An older replay cannot roll a room back to an earlier observation.
  const fresh = new Map<string, RawListing>();
  for (const observation of batch.observations) {
    const known = priorTimes[observation.sourceListingId];
    if (known && observation.observedAt && Date.parse(observation.observedAt) < Date.parse(known)) continue;
    fresh.set(observation.sourceListingId, observation.listing);
  }
  const listings = [...prior.map((row) => (row.id && fresh.has(row.id) ? fresh.get(row.id)! : row)),
    ...[...fresh.values()].filter((row) => !byId.has(row.id))];
  const added = [...fresh.keys()].filter((id) => !byId.has(id)).length;
  const observedAtByKey = { ...priorTimes };
  for (const observation of batch.observations) {
    if (fresh.has(observation.sourceListingId) && observation.observedAt) observedAtByKey[observation.sourceListingId] = observation.observedAt;
  }
  return {
    reconciliation: exactReconciliation(batch.source, previous, listings, batch.capturedAt, { ...previous?.provenance, ...batch.provenance, observedAtByKey }),
    added, updated: fresh.size - added, novel: added, ignored: batch.observations.length - fresh.size,
    previousCount: prior.length, currentCount: listings.length, observedCount: fresh.size,
  };
}

export const urSourcePolicy: SourcePolicy = {
  source: UR_SOURCE,
  host: "www.ur-net.go.jp",
  listings: { prepare: prepareUrBatch, exactUrlDiscovery: false },
};
