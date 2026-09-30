import type { RawListing } from "../../domain/types";
import { trackingKey } from "../../domain/listingIdentity";
import type { ListingSourceSnapshot, SourceReconciliation } from "../contracts";
import { indexSourceRows, sourceRowKey, sourceRowLocator } from "../sourceRowIdentity";
import { sourceObservationFallbackTime, sourceSnapshotCaptureTime } from "../sourceObservationTime";
import type { ScrapeBatch } from "./contracts";
import { InvalidScrapeBatchError } from "./errors";
import { mergeSuumoObserved, suumoKey, suumoDiscoveryMatchKeys as suumoMatchKeys } from "./suumoIdentity";

const defined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, v]) => v != null)) as Partial<T>;

/** Preserve expensive nested details when a summary card did not publish those fields. */
function summaryWithDetails(fresh: RawListing, prior: RawListing | undefined): RawListing {
  if (!prior) return fresh;
  return { ...fresh,
    ...(prior.costs || fresh.costs ? { costs: { ...prior.costs, ...defined(fresh.costs ?? {}) } } : {}),
    ...(prior.tenancy || fresh.tenancy ? { tenancy: { ...prior.tenancy, ...defined(fresh.tenancy ?? {}) } } : {}),
    ...(prior.building || fresh.building ? { building: { ...prior.building, ...defined(fresh.building ?? {}) } } : {}),
  };
}

/** Approved SUUMO incremental policy: source aliases, never generated display IDs, decide overlap. */
export function prepareSuumoBatch(request: ScrapeBatch, snapshot: ListingSourceSnapshot | null) {
  if ((!snapshot && request.scraper.name !== "native-capture") || (snapshot && snapshot.source !== "suumo")) throw new InvalidScrapeBatchError("No SUUMO snapshot exists. Initialize preserved history with `npm run data:migrate` first.");
  // Native captures may create the first SUUMO source; the direct collector still requires preserved history.
  const previous: Omit<ListingSourceSnapshot, "revision"> & { revision: string | null } = snapshot
    ?? { source: "suumo", revision: null, scrapedAt: request.capturedAt, completeSnapshot: false, listings: [], archivedListings: [], provenance: {} };
  indexSourceRows(previous.listings); // legacy ID collisions are fine; ambiguous ID/URL pairs are not
  const byAlias = new Map<string, RawListing[]>();
  for (const listing of previous.listings) for (const alias of suumoMatchKeys(listing)) {
    byAlias.set(alias, [...(byAlias.get(alias) ?? []), listing]);
  }
  const times = { ...(previous.provenance?.observedAtByKey ?? {}) as Record<string, string> };
  const selected = new Set<string>();
  const observed = [] as ScrapeBatch["observations"][number][];
  const fresh: RawListing[] = [];
  let observedCount = 0;
  for (const observation of request.observations) {
    const keys = suumoMatchKeys(observation.listing);
    const matches = [...new Set(keys.flatMap((key) => byAlias.get(key) ?? []))];
    const priorTimes = matches.map((listing) => times[trackingKey(listing)] ?? sourceObservationFallbackTime(previous)).filter((at): at is string => at !== undefined);
    // Replayed stale prices must not supersede newer stored observations. This
    // check precedes within-run dedup so a later eligible capture can still win.
    if (priorTimes.some((at) => !Number.isFinite(Date.parse(at)) || Date.parse(observation.observedAt!) < Date.parse(at))) continue;
    observedCount++;
    if (keys.some((key) => selected.has(key))) continue;
    keys.forEach((key) => selected.add(key));
    const priors = keys.map((key) => byAlias.get(key)?.[0]).filter((listing): listing is RawListing => Boolean(listing));
    const prior = priors.find((listing) => listing.parking != null) ?? priors[0];
    fresh.push(summaryWithDetails(observation.listing, prior));
    observed.push(observation);
  }
  // Only a valid, actually selected observation authorizes alias compaction.
  // An all-stale batch must not opportunistically retire unrelated history.
  const merged = fresh.length ? mergeSuumoObserved(previous.listings, fresh)
    : { listings: [...previous.listings], added: 0, updated: 0, overlaps: 0 };
  const current = indexSourceRows(merged.listings);
  const acceptedObservations = observed.filter((observation) => current.has(sourceRowKey(sourceRowLocator(observation.listing))));
  const novelObservations = acceptedObservations.filter((observation) => !suumoMatchKeys(observation.listing).some((key) => byAlias.has(key)));
  const observedKeys = acceptedObservations.map((observation) => trackingKey(observation.listing));
  for (const observation of acceptedObservations) times[trackingKey(observation.listing)] = observation.observedAt!;
  const previousAt = sourceSnapshotCaptureTime(previous);
  const observedAt = previousAt && Date.parse(previousAt) > Date.parse(request.capturedAt) ? previousAt : request.capturedAt;
  const retirements = previous.listings.filter((listing) => !current.has(sourceRowKey(sourceRowLocator(listing)))).map((listing) => ({
    ...sourceRowLocator(listing), effectiveAt: observedAt,
    reason: "Superseded or compacted by SUUMO incremental source-alias reconciliation (bc/jnc, property, market); not evidence of delisting",
  }));
  const reconciliation: SourceReconciliation = { source: "suumo", expectedRevision: previous.revision, observedAt,
    listings: merged.listings, retirements,
    provenance: { ...previous.provenance, ...request.provenance,
      newListings: merged.added, newListingIds: novelObservations.map((observation) => suumoKey(observation.listing)),
      overlappingListings: merged.overlaps, observedTrackingKeys: [...new Set(observedKeys)], observedAtByKey: times },
  };
  return { reconciliation, added: merged.added, updated: merged.updated, novel: novelObservations.length, observedCount,
    ignored: request.observations.length - acceptedObservations.length, previousCount: previous.listings.length, currentCount: merged.listings.length };
}
