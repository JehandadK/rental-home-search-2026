/**
 * Property documents: one schema-loose, additive record per real-world
 * property, kept for later analysis (time on market, price moves, which
 * portal had it first).
 *
 * Nothing in a document is replaced in place:
 *   - `facts` keep every value any portal ever reported for a field, side by
 *     side when they conflict, with where and when each was seen. `chosen` is
 *     only the value currently shown, re-derived on every sync.
 *   - `ads[].sightings` keep every capture time a portal page showed the ad.
 *   - `events` are appended once (ad checks, lifecycle changes, merges) and
 *     never edited; re-recording the same event is a no-op.
 *   - `summary` is derived from all of the above and safe to recompute.
 * Unknown fields are preserved, so later collectors can add data without a
 * schema change.
 */
import { canonicalJson } from "./canonicalJson";
import type { RawListing } from "./types";

export const PROPERTY_DOCUMENT_SCHEMA_VERSION = 1;

/** One distinct value one portal reported for a field. */
export interface FactObservation {
  value: unknown;
  source: string;
  /** The ads (see `adKey`) that showed this value. */
  adKeys: string[];
  /** Capture times bracketing when this value was seen; null when unknown. */
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  /** Seen at some point before this time (a superseded ad version), exact time unknown. */
  observedBefore?: string;
  /** When this store first recorded the value. Set once. */
  firstRecordedAt: string;
  /**
   * Per ad: the snapshot time at which this value most recently became what
   * that ad shows. Only moves when an ad switches to this value, so
   * re-reporting an unchanged value never rewrites the document.
   */
  reportedAt?: Record<string, string>;
}

/** How `chosen` was picked from `values`: the freshest of capture and report time. */
export type FactChoiceRule = "latest-evidence";

export interface PropertyFact {
  /** The value shown to the user. Derived; every reported value stays in `values`. */
  chosen: unknown;
  chosenFrom: { source: string; rule: FactChoiceRule; observedAt: string | null };
  values: FactObservation[];
}

/** One portal advertisement for this property. */
export interface PropertyAd {
  source: string;
  ids: string[];
  urls: string[];
  /** Every capture time a portal page showed this ad (sorted, unique). */
  sightings: string[];
  firstRecordedAt: string;
}

/**
 * Known event types; any other string is allowed so new collectors can add
 * their own without a schema change.
 *   ad.checked         the ad page itself was looked at (data: state, evidence, method)
 *   ad.superseded      a newer version of the ad replaced this one in the source file
 *   lifecycle.firstSeen  a data build first stamped the property as discovered
 *   lifecycle.status   a data build's status changed (data: status active|sold)
 *   property.merged    another document was folded into this one (data: absorbed)
 */
export type PropertyEventType =
  | "ad.checked"
  | "ad.superseded"
  | "lifecycle.firstSeen"
  | "lifecycle.status"
  | "property.merged"
  | (string & {});

export interface PropertyEvent {
  /** Deterministic from the event's content, so re-recording is a no-op. */
  id: string;
  type: PropertyEventType;
  /** When it happened, per its evidence; null when unknown. */
  at: string | null;
  /** When this store recorded it. */
  recordedAt: string;
  source?: string;
  adKey?: string;
  url?: string | null;
  data?: Record<string, unknown>;
}

export interface PropertyAdSummary {
  source: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Latest evidence the ad was up: a sighting or a "listed" check. */
  lastListedAt: string | null;
  /** Earliest "gone" check after the last listed evidence; null while listed or unchecked. */
  goneSince: string | null;
  /** Times the ad came back after a "gone" check. */
  relistCount: number;
}

export interface PropertySummary {
  /** Earliest evidence of the property, from any portal. */
  firstSeenAt: string | null;
  /**
   * The portal behind that evidence. With basis "build" it is the merged row's
   * preferred portal when the build first stamped it, not necessarily the first.
   */
  firstSeenSource: string | null;
  firstSeenBasis: "sighting" | "check" | "build" | null;
  firstSeenAdKey: string | null;
  firstSeenUrl: string | null;
  lastSeenAt: string | null;
  lastListedAt: string | null;
  /**
   * When every ad is confirmed gone: it left the market after `after` (last
   * evidence it was up) and by `before` (when the last ad was found gone).
   */
  offMarket: { after: string | null; before: string } | null;
  /** Days from first seen to leaving the market, as the bounds above allow. */
  daysOnMarket: { min: number; max: number } | null;
  /** Earliest 情報公開日 any portal printed (YYYY-MM-DD), and the latest 情報更新日. */
  portalPublishedOn: string | null;
  portalUpdatedOn: string | null;
  /** gone: every ad confirmed gone; sold: a complete build no longer saw it. */
  status: "listed" | "gone" | "sold" | "unknown";
  /** Latest data-build status, when it took effect, and how often a build saw it return after sold. */
  buildStatus: { status: string; since: string | null; reactivations: number } | null;
  /** Times an ad came back after its portal showed it gone (ad-page evidence). */
  relistCount: number;
  sources: string[];
  ads: Record<string, PropertyAdSummary>;
  /** Fact paths where more than one distinct value was reported. */
  conflicts: string[];
}

export interface PropertyDocument {
  schemaVersion: typeof PROPERTY_DOCUMENT_SCHEMA_VERSION;
  propertyId: string;
  createdAt: string;
  /** Set when this document was folded into another; it is kept, never deleted. */
  mergedInto?: string;
  /** Identity keys (`ad:`, `id:`, `key:`) that resolve to this property. */
  aliases: string[];
  ads: Record<string, PropertyAd>;
  facts: Record<string, PropertyFact>;
  /** Times a data build confirmed the property was observed (portal not attributed). */
  seenByBuilds: string[];
  events: PropertyEvent[];
  summary: PropertySummary;
  [extra: string]: unknown;
}

/** Fields that are identity or this app's own lifecycle bookkeeping, not portal-reported facts. */
const NON_FACT_FIELDS = new Set([
  "id", "url", "source", "sourceListings", "status", "firstSeenAt", "lastSeenAt", "soldAt",
  // Derived by this app from building/sourceDetails, which are kept as facts.
  "attributes",
]);

/**
 * Every field the portal reported, as dotted paths (`costs.depositYen`,
 * `sourceDetails.築年月`). Nested objects are flattened; arrays are one value.
 * Absent values (null, undefined, "") are not facts: the portal did not say.
 */
export function listingFacts(listing: RawListing): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  const walk = (value: Record<string, unknown>, prefix: string) => {
    for (const [key, item] of Object.entries(value)) {
      if (!prefix && NON_FACT_FIELDS.has(key)) continue;
      if (item === null || item === undefined || item === "") continue;
      const path = `${prefix}${key}`;
      if (typeof item === "object" && !Array.isArray(item)) walk(item as Record<string, unknown>, `${path}.`);
      else if (!Array.isArray(item) || item.length > 0) facts[path] = item;
    }
  };
  walk(listing as unknown as Record<string, unknown>, "");
  return facts;
}

/** Filename-safe, deterministic id for a property founded by `alias` (64-bit FNV-1a). */
export function propertyIdFor(alias: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(alias)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `p_${hash.toString(16).padStart(16, "0")}`;
}

const emptySummary = (): PropertySummary => ({
  firstSeenAt: null, firstSeenSource: null, firstSeenBasis: null, firstSeenAdKey: null, firstSeenUrl: null,
  lastSeenAt: null, lastListedAt: null, offMarket: null, daysOnMarket: null, portalPublishedOn: null, portalUpdatedOn: null,
  status: "unknown", buildStatus: null, relistCount: 0, sources: [], ads: {}, conflicts: [],
});

export function newPropertyDocument(propertyId: string, recordedAt: string): PropertyDocument {
  return {
    schemaVersion: PROPERTY_DOCUMENT_SCHEMA_VERSION,
    propertyId,
    createdAt: recordedAt,
    aliases: [],
    ads: {},
    facts: {},
    seenByBuilds: [],
    events: [],
    summary: emptySummary(),
  };
}

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);
const isTime = (iso: unknown): iso is string => typeof iso === "string" && Number.isFinite(Date.parse(iso));
const earlier = (a: string | null | undefined, b: string | null | undefined): string | null =>
  !isTime(a) ? (isTime(b) ? b : null) : !isTime(b) ? a : time(b) < time(a) ? b : a;
const later = (a: string | null | undefined, b: string | null | undefined): string | null =>
  !isTime(a) ? (isTime(b) ? b : null) : !isTime(b) ? a : time(b) > time(a) ? b : a;

/** Insert into a sorted unique list; returns false when already present. */
function insertSorted(list: string[], value: string, compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b)): boolean {
  if (list.includes(value)) return false;
  const index = list.findIndex((item) => compare(value, item) < 0);
  if (index === -1) list.push(value);
  else list.splice(index, 0, value);
  return true;
}

const byTime = (a: string, b: string) => time(a) - time(b) || a.localeCompare(b);

export function addAlias(doc: PropertyDocument, alias: string): boolean {
  return insertSorted(doc.aliases, alias);
}

/** Register an ad (or new ids/urls for it). Returns true when anything was added. */
export function addAd(doc: PropertyDocument, key: string, ad: { source: string; id?: string | null; url?: string | null }, recordedAt: string): boolean {
  let changed = false;
  let record = doc.ads[key];
  if (!record) {
    record = doc.ads[key] = { source: ad.source, ids: [], urls: [], sightings: [], firstRecordedAt: recordedAt };
    changed = true;
  }
  if (ad.id) changed = insertSorted(record.ids, ad.id) || changed;
  if (ad.url) changed = insertSorted(record.urls, ad.url) || changed;
  return changed;
}

/** Record that a portal page showed the ad at `at`. */
export function addSighting(doc: PropertyDocument, key: string, at: string): boolean {
  const record = doc.ads[key];
  if (!record || !isTime(at)) return false;
  return insertSorted(record.sightings, at, byTime);
}

export function addBuildSighting(doc: PropertyDocument, at: string): boolean {
  return isTime(at) && insertSorted(doc.seenByBuilds, at, byTime);
}

export interface FactContext {
  source: string;
  adKey: string;
  observedAt: string | null;
  observedBefore?: string;
  recordedAt: string;
  /** Snapshot time of a current row; absent for archived versions, which are past by definition. */
  reportedAt?: string;
}

const latestReport = (entry: FactObservation, adKey?: string): number => {
  const times = adKey ? [entry.reportedAt?.[adKey]] : Object.values(entry.reportedAt ?? {});
  return Math.max(-Infinity, ...times.filter(isTime).map(time));
};

/** Add every reported value; existing values only widen their observed window. Returns values added. */
export function addFacts(doc: PropertyDocument, context: FactContext, facts: Record<string, unknown>): number {
  let added = 0;
  for (const [path, value] of Object.entries(facts)) {
    const fact = (doc.facts[path] ??= { chosen: value, chosenFrom: { source: context.source, rule: "latest-evidence", observedAt: context.observedAt }, values: [] });
    const canonical = canonicalJson(value);
    const existing = fact.values.find((entry) => entry.source === context.source && canonicalJson(entry.value) === canonical);
    if (existing) {
      insertSorted(existing.adKeys, context.adKey);
      existing.firstObservedAt = earlier(existing.firstObservedAt, context.observedAt);
      existing.lastObservedAt = later(existing.lastObservedAt, context.observedAt);
      if (context.observedBefore) existing.observedBefore = earlier(existing.observedBefore, context.observedBefore) ?? undefined;
      const { reportedAt } = context;
      if (reportedAt && isTime(reportedAt)) {
        // The ad switched (back) to this value: A → B → A must show A again.
        const current = fact.values.reduce<FactObservation | undefined>((best, entry) =>
          latestReport(entry, context.adKey) > (best ? latestReport(best, context.adKey) : -Infinity) ? entry : best, undefined);
        if (current !== existing && time(reportedAt) > latestReport(existing, context.adKey)) {
          existing.reportedAt = { ...existing.reportedAt, [context.adKey]: reportedAt };
        }
      }
      continue;
    }
    fact.values.push({
      value,
      source: context.source,
      adKeys: [context.adKey],
      firstObservedAt: isTime(context.observedAt) ? context.observedAt : null,
      lastObservedAt: isTime(context.observedAt) ? context.observedAt : null,
      ...(context.observedBefore ? { observedBefore: context.observedBefore } : {}),
      firstRecordedAt: context.recordedAt,
      ...(context.reportedAt && isTime(context.reportedAt) ? { reportedAt: { [context.adKey]: context.reportedAt } } : {}),
    });
    added++;
  }
  return added;
}

/** Append an event unless one with the same id exists. Events stay ordered by time. */
export function addEvent(doc: PropertyDocument, event: PropertyEvent): boolean {
  if (doc.events.some((existing) => existing.id === event.id)) return false;
  const key = (e: PropertyEvent) => (isTime(e.at) ? time(e.at) : -Infinity);
  const index = doc.events.findIndex((existing) => key(event) < key(existing));
  if (index === -1) doc.events.push(event);
  else doc.events.splice(index, 0, event);
  return true;
}

/**
 * Fold `absorbed` into `survivor`. The union is lossless: every value,
 * sighting and event keeps its ad key, so the merge can be split by ad later
 * (the `property.merged` event lists the absorbed ads). The absorbed file is
 * kept as a pointer (`mergedInto` plus its aliases) rather than a second full
 * copy. Copied lifecycle.status events are tagged `mergedFrom`: they describe
 * the absorbed document's own history and do not drive the survivor's status.
 */
export function mergePropertyDocuments(survivor: PropertyDocument, absorbed: PropertyDocument, recordedAt: string, data: Record<string, unknown> = {}): void {
  for (const alias of absorbed.aliases) addAlias(survivor, alias);
  for (const [key, ad] of Object.entries(absorbed.ads)) {
    const target = survivor.ads[key];
    if (!target) {
      survivor.ads[key] = structuredClone(ad);
      continue;
    }
    for (const id of ad.ids) insertSorted(target.ids, id);
    for (const url of ad.urls) insertSorted(target.urls, url);
    for (const at of ad.sightings) insertSorted(target.sightings, at, byTime);
    target.firstRecordedAt = earlier(target.firstRecordedAt, ad.firstRecordedAt) ?? target.firstRecordedAt;
  }
  for (const [path, fact] of Object.entries(absorbed.facts)) {
    const target = (survivor.facts[path] ??= structuredClone({ ...fact, values: [] }));
    for (const entry of fact.values) {
      const canonical = canonicalJson(entry.value);
      const match = target.values.find((other) => other.source === entry.source && canonicalJson(other.value) === canonical);
      if (!match) {
        target.values.push(structuredClone(entry));
        continue;
      }
      for (const adKey of entry.adKeys) insertSorted(match.adKeys, adKey);
      match.firstObservedAt = earlier(match.firstObservedAt, entry.firstObservedAt);
      match.lastObservedAt = later(match.lastObservedAt, entry.lastObservedAt);
      if (entry.observedBefore) match.observedBefore = earlier(match.observedBefore, entry.observedBefore) ?? undefined;
      match.firstRecordedAt = earlier(match.firstRecordedAt, entry.firstRecordedAt) ?? match.firstRecordedAt;
      for (const [adKey, at] of Object.entries(entry.reportedAt ?? {})) {
        if (time(at) > latestReport(match, adKey)) match.reportedAt = { ...match.reportedAt, [adKey]: at };
      }
    }
  }
  for (const at of absorbed.seenByBuilds) addBuildSighting(survivor, at);
  for (const event of absorbed.events) {
    const copy = structuredClone(event);
    if (copy.type === "lifecycle.status" && !copy.data?.mergedFrom) copy.data = { ...copy.data, mergedFrom: absorbed.propertyId };
    addEvent(survivor, copy);
  }
  // Fields a newer writer added and this code does not know are kept too.
  for (const [key, value] of Object.entries(absorbed)) {
    if (!(key in survivor) && !["mergedInto"].includes(key)) survivor[key] = structuredClone(value);
  }
  survivor.createdAt = earlier(survivor.createdAt, absorbed.createdAt) ?? survivor.createdAt;
  addEvent(survivor, {
    id: `property.merged|${absorbed.propertyId}`,
    type: "property.merged",
    at: recordedAt,
    recordedAt,
    data: { ...data, absorbed: absorbed.propertyId, absorbedAds: Object.keys(absorbed.ads).sort() },
  });
  absorbed.mergedInto = survivor.propertyId;
  for (const key of Object.keys(absorbed)) {
    if (!["schemaVersion", "propertyId", "createdAt", "mergedInto", "aliases"].includes(key)) delete absorbed[key];
  }
  Object.assign(absorbed, { ads: {}, facts: {}, seenByBuilds: [], events: [], summary: emptySummary() });
}

/** The survivor's own build-status events (not ones copied in by a merge), oldest first. */
export function ownStatusEvents(doc: PropertyDocument): PropertyEvent[] {
  return doc.events.filter((e) => e.type === "lifecycle.status" && !e.data?.mergedFrom);
}

/**
 * Each ad's current value is the one it most recently switched to; archived
 * versions only count when no ad has a current value. Among candidates the
 * freshest evidence wins (last capture or last switch), then the latest
 * capture, then source name.
 */
function chooseFact(fact: PropertyFact): void {
  const current = new Set<FactObservation>();
  const ads = new Set(fact.values.flatMap((entry) => Object.keys(entry.reportedAt ?? {})));
  const captured = (entry: FactObservation) => (isTime(entry.lastObservedAt) ? time(entry.lastObservedAt) : -Infinity);
  for (const adKey of ads) {
    // Same switch time: the later capture, then the later-recorded value, is newer.
    const latest = fact.values.reduce<FactObservation | undefined>((best, entry) => {
      if (!best) return entry.reportedAt?.[adKey] ? entry : undefined;
      const diff = latestReport(entry, adKey) - latestReport(best, adKey);
      return diff > 0 || (diff === 0 && captured(entry) >= captured(best)) ? entry : best;
    }, undefined);
    if (latest) current.add(latest);
  }
  const fresh = (entry: FactObservation) => Math.max(captured(entry), latestReport(entry),
    isTime(entry.observedBefore) ? time(entry.observedBefore) : -Infinity);
  const candidates = current.size ? [...current] : fact.values;
  const best = [...candidates].sort((a, b) => fresh(b) - fresh(a) || captured(b) - captured(a) || a.source.localeCompare(b.source))[0];
  if (!best) return;
  fact.chosen = best.value;
  fact.chosenFrom = { source: best.source, rule: "latest-evidence", observedAt: best.lastObservedAt ?? best.observedBefore ?? null };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const days = (from: string, to: string) => Math.round(((time(to) - time(from)) / DAY_MS) * 10) / 10;

function summarizeAd(key: string, ad: PropertyAd, checks: readonly PropertyEvent[]): PropertyAdSummary {
  // One timeline of evidence: sightings and listed checks say "up", gone checks say "gone".
  const timeline = [
    ...ad.sightings.map((at) => ({ at, up: true })),
    ...checks.filter((e) => e.adKey === key && isTime(e.at)).map((e) => ({ at: e.at as string, up: e.data?.state !== "gone" })),
  ].sort((a, b) => time(a.at) - time(b.at) || Number(a.up) - Number(b.up));
  let lastListedAt: string | null = null;
  let goneSince: string | null = null;
  let relistCount = 0;
  for (const point of timeline) {
    if (point.up) {
      if (goneSince) relistCount++;
      lastListedAt = point.at;
      goneSince = null;
    } else if (!goneSince) goneSince = point.at;
  }
  return {
    source: ad.source,
    firstSeenAt: ad.sightings[0] ?? null,
    lastSeenAt: ad.sightings.at(-1) ?? null,
    lastListedAt,
    goneSince,
    relistCount,
  };
}

/** Recompute `chosen` values and the summary from the document's history. Deterministic. */
export function refreshDerived(doc: PropertyDocument): void {
  // Stable key order keeps stored documents diff-friendly across syncs.
  doc.aliases.sort();
  doc.ads = Object.fromEntries(Object.entries(doc.ads).sort(([a], [b]) => a.localeCompare(b)));
  doc.facts = Object.fromEntries(Object.entries(doc.facts).sort(([a], [b]) => a.localeCompare(b)));
  for (const fact of Object.values(doc.facts)) chooseFact(fact);
  const checks = doc.events.filter((e) => e.type === "ad.checked");
  const ads = Object.fromEntries(Object.entries(doc.ads).map(([key, ad]) => [key, summarizeAd(key, ad, checks)]));

  // First discovery: the earliest sighting, check, or build stamp, with its portal.
  type First = { at: string; source: string | null; adKey: string | null; url: string | null; basis: "sighting" | "check" | "build" };
  const firsts: First[] = [];
  for (const [key, ad] of Object.entries(doc.ads)) {
    if (ad.sightings[0]) firsts.push({ at: ad.sightings[0], source: ad.source, adKey: key, url: ad.urls[0] ?? null, basis: "sighting" });
  }
  for (const event of doc.events) {
    // A "gone" check is not evidence the property was ever seen up.
    const up = event.type === "lifecycle.firstSeen" || (event.type === "ad.checked" && event.data?.state !== "gone");
    if (up && isTime(event.at)) {
      firsts.push({ at: event.at, source: event.source ?? null, adKey: event.adKey ?? null, url: event.url ?? null, basis: event.type === "ad.checked" ? "check" : "build" });
    }
  }
  if (doc.seenByBuilds[0]) firsts.push({ at: doc.seenByBuilds[0], source: null, adKey: null, url: null, basis: "build" });
  // On a tie, portal evidence beats a build stamp.
  const rank = { sighting: 0, check: 1, build: 2 } as const;
  const first = firsts.sort((a, b) => time(a.at) - time(b.at) || rank[a.basis] - rank[b.basis])[0];

  const adSummaries = Object.values(ads);
  const lastSeenAt = [...adSummaries.map((a) => a.lastSeenAt), doc.seenByBuilds.at(-1)].reduce<string | null>(later, null);
  const lastListedAt = [...adSummaries.map((a) => a.lastListedAt), doc.seenByBuilds.at(-1)].reduce<string | null>(later, null);
  // Gone needs a gone check on every ad that was still up when the first ad
  // went: an old, never-checked ad last seen before then (superseded, or
  // replaced by a re-advertisement) does not keep the property listed forever.
  const goneSinces = adSummaries.map((a) => a.goneSince).filter(isTime);
  const firstGone = goneSinces.reduce<string | null>(earlier, null);
  const stillUp = adSummaries.filter((a) => !a.goneSince && firstGone && a.lastListedAt && time(a.lastListedAt) >= time(firstGone));
  const allGone = goneSinces.length > 0 && stillUp.length === 0;
  const goneBy = allGone ? goneSinces.reduce<string | null>(later, null) : null;
  // A build sighting after the last gone check means it is back.
  const offMarket = goneBy && !(lastListedAt && time(lastListedAt) > time(goneBy)) ? { after: lastListedAt, before: goneBy } : null;
  const firstSeenAt = first?.at ?? null;
  const daysOnMarket = offMarket && firstSeenAt
    ? { min: Math.max(0, days(firstSeenAt, offMarket.after ?? firstSeenAt)), max: Math.max(0, days(firstSeenAt, offMarket.before)) }
    : null;

  const statusEvents = ownStatusEvents(doc);
  const lastStatus = statusEvents.at(-1);
  const reactivations = statusEvents.filter((e, i) => i > 0 && e.data?.status === "active" && statusEvents[i - 1].data?.status === "sold").length;
  const buildStatus = lastStatus ? { status: String(lastStatus.data?.status), since: lastStatus.at, reactivations } : null;

  const portalDates = (path: string) => (doc.facts[path]?.values ?? []).map((entry) => String(entry.value)).sort();

  doc.summary = {
    firstSeenAt,
    firstSeenSource: first?.source ?? null,
    firstSeenBasis: first?.basis ?? null,
    firstSeenAdKey: first?.adKey ?? null,
    firstSeenUrl: first?.url ?? null,
    lastSeenAt,
    lastListedAt,
    offMarket,
    daysOnMarket,
    portalPublishedOn: portalDates("portalDates.publishedOn")[0] ?? null,
    portalUpdatedOn: portalDates("portalDates.updatedOn").at(-1) ?? null,
    status: offMarket ? "gone" : buildStatus?.status === "sold" ? "sold" : lastListedAt ? "listed" : "unknown",
    buildStatus,
    relistCount: adSummaries.reduce((sum, a) => sum + a.relistCount, 0),
    sources: [...new Set(Object.values(doc.ads).map((ad) => ad.source))].sort(),
    ads,
    conflicts: Object.entries(doc.facts)
      .filter(([, fact]) => new Set(fact.values.map((entry) => canonicalJson(entry.value))).size > 1)
      .map(([path]) => path)
      .sort(),
  };
}
