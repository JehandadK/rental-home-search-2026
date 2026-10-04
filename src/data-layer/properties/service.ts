/**
 * Folds evidence into property documents. Additive and idempotent: syncing the
 * same evidence twice changes nothing, and nothing already recorded is ever
 * removed, so old snapshots can be replayed (backfill).
 *
 * Identity: a portal ad (`ad:<adKey>`, from its URL or a row id that embeds
 * the portal's ad id) always resolves to the property that first claimed it.
 * Content-derived row ids (SUUMO) are never identity: two rooms can share one.
 * A SUUMO room re-posted under a new `bc` code keeps its `jnc` page, layout
 * and floor area; that room key (`room:`) joins the new ad to the property
 * holding the old one, when exactly one property has it.
 * The tracking key (name, address, area) is only a fallback for a merged row
 * none of whose ads is known yet, e.g. a room re-advertised under a new ad id,
 * and never takes a property another row of the same build already resolved
 * to. When the current build groups ads from different documents, those
 * documents are merged (the absorbed one is kept, marked). A historical
 * build (`groupingAuthoritative: false`) groups nothing: older deduplication
 * rules may have joined rooms today's build keeps apart, so each of its ads
 * only reaches its own document and the row's lifecycle goes to the
 * document of its preferred ad.
 */
import { adKey, adKeyFromRowId, listingAdKey } from "../../domain/availability";
import { canonicalJson } from "../../domain/canonicalJson";
import { trackingKey } from "../../domain/listingIdentity";
import { sourceListings } from "../../domain/listingDedup";
import { portalListingDatesFrom } from "../../domain/portalDates";
import {
  addAd, addAlias, addBuildSighting, addEvent, addFacts, addSighting, listingFacts, mergePropertyDocuments,
  newPropertyDocument, ownStatusEvents, propertyIdFor, refreshDerived, type PropertyDocument,
} from "../../domain/propertyDocument";
import type { RawListing } from "../../domain/types";
import type { PropertyDocumentStore, PropertyEvidence, PropertySyncReport } from "./contracts";

const AD = "ad:";
const KEY = "key:";
const ROOM = "room:";
/**
 * SUUMO's re-posting continuity: same jnc page, layout and exact floor area.
 * Not rounded: 34.7 and 35 m² on one jnc can be two rooms the build keeps apart.
 */
const roomAlias = (ad: { source: string; url?: string | null; layout?: string | null; sizeM2?: number | null }): string | undefined => {
  const jnc = ad.source === "suumo" ? /jnc_\d+/.exec(ad.url ?? "")?.[0] : undefined;
  return jnc && ad.layout && ad.sizeM2 ? `${ROOM}suumo|${jnc}|${ad.layout}|${ad.sizeM2.toFixed(2)}` : undefined;
};
const keyOf = (ad: { source: string; id?: string | null; url?: string | null }) => listingAdKey(ad.source, ad.url, ad.id);
const later = (a: string, b: string | null | undefined) => (b && Date.parse(b) > Date.parse(a) ? b : a);

/** Every portal-reported field, plus the portal's own listing dates found in its text. */
export function observedFacts(listing: RawListing): Record<string, unknown> {
  const dates = portalListingDatesFrom(listing.sourceDetails, listing.notes);
  return {
    ...listingFacts(listing),
    ...Object.fromEntries(Object.entries(dates).map(([field, value]) => [`portalDates.${field}`, value])),
  };
}

export async function syncPropertyDocuments(store: PropertyDocumentStore, evidence: PropertyEvidence): Promise<PropertySyncReport> {
  return store.transact(({ documents }) => {
    const { recordedAt, via } = evidence;
    const asOf = evidence.asOf ?? recordedAt;
    const before = new Map([...documents].map(([id, doc]) => [id, canonicalJson(doc)]));
    const report: PropertySyncReport = {
      via, documents: 0, created: 0, merged: 0, changed: 0,
      factValuesAdded: 0, sightingsAdded: 0, eventsAdded: 0, orphanSightings: 0, unresolvedChecks: 0,
    };

    const index = new Map<string, Set<string>>();
    const link = (alias: string, doc: PropertyDocument) => {
      addAlias(doc, alias);
      let ids = index.get(alias);
      if (!ids) index.set(alias, (ids = new Set()));
      ids.add(doc.propertyId);
    };
    for (const doc of documents.values()) {
      if (doc.mergedInto) continue;
      for (const alias of doc.aliases) if (alias.startsWith(AD) || alias.startsWith(KEY) || alias.startsWith(ROOM)) link(alias, doc);
    }
    const oldestFirst = (a: PropertyDocument, b: PropertyDocument) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.propertyId.localeCompare(b.propertyId);
    const lookup = (aliases: readonly string[]) =>
      [...new Set(aliases.flatMap((alias) => [...(index.get(alias) ?? [])]))].map((id) => documents.get(id)!).sort(oldestFirst);
    const live = (doc: PropertyDocument): PropertyDocument => (doc.mergedInto ? live(documents.get(doc.mergedInto)!) : doc);
    const create = (seed: string): PropertyDocument => {
      let id = propertyIdFor(seed);
      for (let n = 2; documents.has(id); n++) id = propertyIdFor(`${seed}#${n}`);
      const doc = newPropertyDocument(id, recordedAt);
      documents.set(id, doc);
      report.created++;
      return doc;
    };
    /** The property of a re-posted SUUMO room, when exactly one holds its room key. */
    const byRoom = (room: string | undefined) => {
      const docs = room ? lookup([room]) : [];
      return docs.length === 1 ? docs[0] : undefined;
    };
    const ensureAd = (key: string, ad: { source: string; id?: string | null; url?: string | null; layout?: string | null; sizeM2?: number | null }): PropertyDocument => {
      const room = roomAlias(ad);
      const doc = lookup([AD + key])[0] ?? byRoom(room) ?? create(AD + key);
      link(AD + key, doc);
      if (room) link(room, doc);
      addAd(doc, key, ad, recordedAt);
      return doc;
    };
    const event = (doc: PropertyDocument, value: Parameters<typeof addEvent>[1]) => {
      if (addEvent(doc, value)) report.eventsAdded++;
    };

    // 1. The merged dataset decides which ads are one property, and carries build lifecycle.
    const canonical = evidence.canonical;
    if (canonical) {
      const authoritative = canonical.groupingAuthoritative !== false;
      const builtAt = canonical.builtAt ?? asOf;
      const rows = canonical.rows.map((row) => {
        const ads = sourceListings(row);
        return { row, ads, keys: [...new Set(ads.map(keyOf))], primary: keyOf(row) };
      });
      const resolved: PropertyDocument[] = [];
      const claimed = new Set<string>();
      if (!authoritative) {
        rows.forEach(({ row, ads, primary }, i) => {
          // The row's room facts describe each of its ads (that is why they were grouped).
          for (const ad of ads) ensureAd(keyOf(ad), { ...ad, layout: row.layout, sizeM2: row.sizeM2 });
          resolved[i] = live(lookup([AD + primary])[0] ?? ensureAd(primary, row));
        });
      }
      // a. Rows with a known ad: their property is certain.
      rows.forEach(({ keys, primary }, i) => {
        if (resolved[i]) return;
        const docs = lookup(keys.map((key) => AD + key));
        if (!docs.length) return;
        const doc = docs[0];
        for (const absorbed of docs.slice(1)) {
          mergePropertyDocuments(doc, absorbed, recordedAt, { via, groupedBy: primary });
          for (const alias of absorbed.aliases) {
            index.get(alias)?.delete(absorbed.propertyId);
            link(alias, doc);
          }
          report.merged++;
        }
        resolved[i] = doc;
        claimed.add(doc.propertyId);
      });
      // b. Rows with only new ads: a re-advertisement joins its room by tracking key,
      //    unless that property already belongs to another row of this build.
      rows.forEach(({ row, keys }, i) => {
        if (resolved[i]) return;
        const room = rows[i].ads.map((ad) => byRoom(roomAlias({ ...ad, layout: row.layout, sizeM2: row.sizeM2 }))).find(Boolean);
        const candidates = lookup([KEY + trackingKey(row)]).filter((doc) => !claimed.has(live(doc).propertyId));
        const doc = room && !claimed.has(live(room).propertyId) ? live(room)
          : candidates.length === 1 ? live(candidates[0]) : create(AD + (keys[0] ?? trackingKey(row)));
        resolved[i] = doc;
        claimed.add(doc.propertyId);
      });

      rows.forEach(({ row, ads, primary }, i) => {
        const doc = live(resolved[i]);
        const room = roomAlias(row);
        if (room) link(room, doc);
        if (authoritative) {
          link(KEY + trackingKey(row), doc);
          for (const ad of ads) {
            link(AD + keyOf(ad), doc);
            const adRoom = roomAlias({ ...ad, layout: row.layout, sizeM2: row.sizeM2 });
            if (adRoom) link(adRoom, doc);
            addAd(doc, keyOf(ad), ad, recordedAt);
          }
        }
        if (row.firstSeenAt) {
          // One stamp per time: the first build to record it names the portal it credited.
          event(doc, {
            id: `lifecycle.firstSeen|${row.firstSeenAt}`, type: "lifecycle.firstSeen", at: row.firstSeenAt,
            recordedAt, source: row.source, adKey: primary, url: row.url, data: { via, basis: "build stamp; portal is the merged row's preferred ad" },
          });
        }
        if (row.lastSeenAt && addBuildSighting(doc, row.lastSeenAt)) report.sightingsAdded++;
        const status = row.status ?? "active";
        const last = ownStatusEvents(doc).at(-1);
        if (last?.data?.status !== status) {
          const candidate = status === "sold" ? row.soldAt ?? builtAt : last ? row.lastSeenAt ?? builtAt : row.firstSeenAt ?? builtAt;
          // Never date a change before the status it replaces.
          const at = last?.at ? later(candidate, last.at) : candidate;
          event(doc, { id: `lifecycle.status|${status}|${at}`, type: "lifecycle.status", at, recordedAt, data: { status, via } });
        }
      });
    }

    // 2. Every source row and archived version: what each portal said, and when.
    for (const source of evidence.sources ?? []) {
      const rowKeys = new Map<string, string>();
      const observe = (listing: RawListing, observedAt: string | null, options: { observedBefore?: string; reportedAt?: string }) => {
        const ad = { ...listing, source: listing.source ?? source.source };
        const key = keyOf(ad);
        if (ad.id) rowKeys.set(ad.id, key);
        const doc = ensureAd(key, ad);
        report.factValuesAdded += addFacts(doc, { source: ad.source, adKey: key, observedAt, recordedAt, ...options }, observedFacts(listing));
        if (observedAt && addSighting(doc, key, observedAt)) report.sightingsAdded++;
        return { doc, key };
      };
      // A file can hold two rows for one ad (e.g. a SUUMO ad under two tracking
      // URLs). Both are recorded; only the first sets what the ad currently shows,
      // or the two would take turns on every sync.
      const reported = new Set<string>();
      for (const { listing, observedAt } of source.rows) {
        const key = keyOf({ ...listing, source: listing.source ?? source.source });
        observe(listing, observedAt, reported.has(key) ? {} : { reportedAt: asOf });
        reported.add(key);
      }
      for (const { listing, retiredAt, reason } of source.archived) {
        const { doc, key } = observe(listing, null, { observedBefore: retiredAt });
        event(doc, { id: `ad.superseded|${key}|${retiredAt}`, type: "ad.superseded", at: retiredAt, recordedAt, source: source.source, adKey: key, url: listing.url, data: { reason } });
      }
      for (const sighting of source.sightings) {
        // Journals name an ad by its URL (SUUMO) or by its row id.
        const id = sighting.sourceListingId;
        const isUrl = /^https?:\/\//.test(id);
        const derived = isUrl ? listingAdKey(source.source, id) : adKeyFromRowId(source.source, id) ?? rowKeys.get(id);
        const key = derived ?? adKey(source.source, null, id);
        if (!lookup([AD + key]).length) report.orphanSightings++;
        // A sighting of a row no file still holds stays on its own document
        // rather than being dropped; the ad joins its property when seen again.
        const doc = ensureAd(key, isUrl ? { source: source.source, url: id } : { source: source.source, id });
        if (addSighting(doc, key, sighting.observedAt)) report.sightingsAdded++;
      }
    }

    // 3. Ad-page checks: every one is an event, so the first "gone" is never overwritten.
    for (const check of evidence.availability ?? []) {
      // The checked URL names the exact ad; the file's own key can be coarser (SUUMO jnc).
      const key = listingAdKey(check.source, check.url);
      const doc = lookup([AD + key])[0];
      if (!doc) {
        report.unresolvedChecks++;
        continue;
      }
      addAd(doc, key, { source: check.source, url: check.url }, recordedAt);
      event(doc, {
        id: `ad.checked|${key}|${check.checkedAt}|${check.state}|${check.method}`, type: "ad.checked", at: check.checkedAt,
        recordedAt, source: check.source, adKey: key, url: check.url,
        data: { state: check.state, evidence: check.evidence, method: check.method },
      });
    }

    for (const doc of documents.values()) {
      refreshDerived(doc);
      const previous = before.get(doc.propertyId);
      if (previous !== undefined && previous !== canonicalJson(doc)) report.changed++;
    }
    report.documents = [...documents.values()].filter((doc) => !doc.mergedInto).length;
    return report;
  });
}

/** One-line summary for CLI output. */
export function describePropertySync(report: PropertySyncReport): string {
  return `Property documents (${report.via}): ${report.documents} properties, ${report.created} new, ${report.merged} merged, ${report.changed} updated` +
    ` · +${report.factValuesAdded} values, +${report.sightingsAdded} sightings, +${report.eventsAdded} events` +
    (report.orphanSightings ? ` · ${report.orphanSightings} sightings of rows no file still holds (kept)` : "") +
    (report.unresolvedChecks ? ` · ${report.unresolvedChecks} checks matched no property` : "");
}
