import { describe, expect, it } from "vitest";
import type { PropertyDocument } from "../../domain/propertyDocument";
import type { RawListing } from "../../domain/types";
import type { PropertyDocumentStore, PropertyEvidence, PropertyStoreState } from "./contracts";
import { syncPropertyDocuments } from "./service";

class MemoryStore implements PropertyDocumentStore {
  documents = new Map<string, PropertyDocument>();
  async transact<T>(update: (state: PropertyStoreState) => T | Promise<T>): Promise<T> {
    const documents = structuredClone(this.documents);
    const result = await update({ documents });
    this.documents = documents;
    return result;
  }
  live = () => [...this.documents.values()].filter((doc) => !doc.mergedInto);
}

const SUUMO_URL = "https://suumo.jp/chintai/jnc_000111111111/?bc=1";
const ATHOME_URL = "https://www.athome.co.jp/chintai/1222222222/";
const listing = (overrides: Partial<RawListing> = {}): RawListing => ({
  id: "suumo-1", name: "グランハイツ", address: "埼玉県草加市松原1丁目", rent: 100000, layout: "2LDK", sizeM2: 55,
  builtYear: 2001, stationWalkMin: 8, url: SUUMO_URL, source: "suumo", ...overrides,
});
const athome = (overrides: Partial<RawListing> = {}) =>
  listing({ id: "athome-1222222222", url: ATHOME_URL, source: "athome", rent: 102000, ...overrides });

const evidence = (overrides: Partial<PropertyEvidence>): PropertyEvidence => ({ recordedAt: "2026-10-01T00:00:00.000Z", via: "test", ...overrides });

describe("syncPropertyDocuments", () => {
  it("keeps one document per property with every portal's values, and is idempotent", async () => {
    const store = new MemoryStore();
    const canonicalRow = { ...listing(), sourceListings: [{ source: "suumo", id: "suumo-1", url: SUUMO_URL }, { source: "athome", id: "athome-1222222222", url: ATHOME_URL }], firstSeenAt: "2026-09-20T00:00:00.000Z", lastSeenAt: "2026-09-30T00:00:00.000Z", status: "active" as const };
    const input = evidence({
      canonical: { builtAt: "2026-09-30T01:00:00.000Z", rows: [canonicalRow] },
      sources: [
        { source: "suumo", rows: [{ listing: listing(), observedAt: "2026-09-21T00:00:00.000Z" }], archived: [], sightings: [{ sourceListingId: SUUMO_URL, observedAt: "2026-09-25T00:00:00.000Z" }] },
        { source: "athome", rows: [{ listing: athome(), observedAt: "2026-09-22T00:00:00.000Z" }], archived: [], sightings: [] },
      ],
    });
    const first = await syncPropertyDocuments(store, input);
    expect(first).toMatchObject({ documents: 1, created: 1 });
    const [doc] = store.live();
    expect(Object.keys(doc.ads)).toEqual(["athome|1222222222", "suumo|jnc_000111111111|bc_1"]);
    // Conflicting rents are both kept; the latest observation is shown.
    expect(doc.facts.rent.values.map((v) => [v.source, v.value])).toEqual([["suumo", 100000], ["athome", 102000]]);
    expect(doc.facts.rent.chosen).toBe(102000);
    expect(doc.summary.conflicts).toContain("rent");
    expect(doc.summary).toMatchObject({ firstSeenAt: "2026-09-20T00:00:00.000Z", firstSeenSource: "suumo", status: "listed" });
    expect(doc.ads["suumo|jnc_000111111111|bc_1"].sightings).toEqual(["2026-09-21T00:00:00.000Z", "2026-09-25T00:00:00.000Z"]);

    const again = await syncPropertyDocuments(store, { ...input, recordedAt: "2026-10-02T00:00:00.000Z" });
    expect(again).toMatchObject({ created: 0, changed: 0, factValuesAdded: 0, sightingsAdded: 0, eventsAdded: 0 });
  });

  it("never loses an earlier value, sold time, or first gone check when later data changes", async () => {
    const store = new MemoryStore();
    const row = (status: "active" | "sold", extra: Partial<RawListing>) => ({ ...listing(), firstSeenAt: "2026-09-01T00:00:00.000Z", status, ...extra });
    await syncPropertyDocuments(store, evidence({
      canonical: { builtAt: "2026-09-02T00:00:00.000Z", rows: [row("active", { lastSeenAt: "2026-09-02T00:00:00.000Z" })] },
      sources: [{ source: "suumo", rows: [{ listing: listing(), observedAt: "2026-09-02T00:00:00.000Z" }], archived: [], sightings: [] }],
    }));
    await syncPropertyDocuments(store, evidence({
      canonical: { builtAt: "2026-09-10T00:00:00.000Z", rows: [row("sold", { soldAt: "2026-09-10T00:00:00.000Z", lastSeenAt: "2026-09-02T00:00:00.000Z" })] },
      availability: [
        { key: "suumo|jnc_000111111111", source: "suumo", url: SUUMO_URL, state: "gone", checkedAt: "2026-09-09T00:00:00.000Z", evidence: "HTTP 404", method: "probe" },
        { key: "suumo|jnc_000111111111", source: "suumo", url: SUUMO_URL, state: "gone", checkedAt: "2026-09-12T00:00:00.000Z", evidence: "HTTP 404", method: "probe" },
      ],
    }));
    let [doc] = store.live();
    expect(doc.summary).toMatchObject({ status: "gone", offMarket: { after: "2026-09-02T00:00:00.000Z", before: "2026-09-09T00:00:00.000Z" }, daysOnMarket: { min: 1, max: 8 } });

    // Re-listed at a new rent: the build clears soldAt, the document keeps it.
    await syncPropertyDocuments(store, evidence({
      canonical: { builtAt: "2026-09-20T00:00:00.000Z", rows: [row("active", { rent: 95000, soldAt: null, lastSeenAt: "2026-09-20T00:00:00.000Z" })] },
      sources: [{ source: "suumo", rows: [{ listing: listing({ rent: 95000 }), observedAt: "2026-09-20T00:00:00.000Z" }], archived: [], sightings: [] }],
    }));
    [doc] = store.live();
    expect(doc.events.filter((e) => e.type === "lifecycle.status").map((e) => [e.at, e.data?.status])).toEqual([
      ["2026-09-01T00:00:00.000Z", "active"], ["2026-09-10T00:00:00.000Z", "sold"], ["2026-09-20T00:00:00.000Z", "active"],
    ]);
    expect(doc.events.filter((e) => e.type === "ad.checked").map((e) => e.at)).toEqual(["2026-09-09T00:00:00.000Z", "2026-09-12T00:00:00.000Z"]);
    expect(doc.facts.rent.values.map((v) => v.value)).toEqual([100000, 95000]);
    expect(doc.facts.rent.chosen).toBe(95000);
    expect(doc.summary).toMatchObject({ status: "listed", relistCount: 1, offMarket: null, buildStatus: { status: "active", reactivations: 1 } });
  });

  it("joins a re-advertised room to its property by tracking key, but keeps two same-key rooms apart", async () => {
    const store = new MemoryStore();
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [listing()] } }));
    const newAd = listing({ id: "suumo-2", url: "https://suumo.jp/chintai/jnc_000999999999/" });
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [newAd] } }));
    expect(store.live()).toHaveLength(1);
    expect(Object.keys(store.live()[0].ads)).toHaveLength(2);

    const twin = listing({ id: "suumo-3", url: "https://suumo.jp/chintai/jnc_000888888888/" });
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [newAd, twin] } }));
    expect(store.live()).toHaveLength(2);
  });

  it("merges documents when the build groups their ads, leaving a pointer behind", async () => {
    const store = new MemoryStore();
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [listing(), athome({ name: "別名", address: "埼玉県草加市" })] } }));
    expect(store.live()).toHaveLength(2);
    const merged = { ...listing(), sourceListings: [{ source: "suumo", id: "suumo-1", url: SUUMO_URL }, { source: "athome", id: "athome-1222222222", url: ATHOME_URL }] };
    const report = await syncPropertyDocuments(store, evidence({ recordedAt: "2026-10-05T00:00:00.000Z", canonical: { builtAt: null, rows: [merged] } }));
    expect(report.merged).toBe(1);
    expect(store.live()).toHaveLength(1);
    const absorbed = [...store.documents.values()].find((doc) => doc.mergedInto)!;
    expect(absorbed.mergedInto).toBe(store.live()[0].propertyId);
    expect(store.live()[0].events.some((e) => e.type === "property.merged")).toBe(true);
  });

  it("records portal listing dates found in captured details", async () => {
    const store = new MemoryStore();
    const withDates = listing({ sourceDetails: { 情報更新日: "2026/9/28", 次回更新日: "随時" }, notes: "情報公開日：2026/08/29" });
    await syncPropertyDocuments(store, evidence({ sources: [{ source: "suumo", rows: [{ listing: withDates, observedAt: "2026-09-29T00:00:00.000Z" }], archived: [], sightings: [] }] }));
    const [doc] = store.live();
    expect(doc.facts["sourceDetails.情報更新日"].chosen).toBe("2026/9/28");
    expect(doc.summary).toMatchObject({ portalPublishedOn: "2026-08-29", portalUpdatedOn: "2026-09-28" });
  });

  it("keeps sightings of rows no file holds any more on their own document", async () => {
    const store = new MemoryStore();
    const report = await syncPropertyDocuments(store, evidence({ sources: [{ source: "athome", rows: [], archived: [], sightings: [{ sourceListingId: "athome-1222222222", observedAt: "2026-09-01T00:00:00.000Z" }] }] }));
    expect(report.orphanSightings).toBe(1);
    expect(store.live()[0].summary.lastSeenAt).toBe("2026-09-01T00:00:00.000Z");
    // The row later shows up: it joins the same document and the same ad.
    await syncPropertyDocuments(store, evidence({ sources: [{ source: "athome", rows: [{ listing: athome(), observedAt: "2026-09-05T00:00:00.000Z" }], archived: [], sightings: [] }] }));
    expect(store.live()).toHaveLength(1);
    expect(Object.keys(store.live()[0].ads)).toEqual(["athome|1222222222"]);
  });

  it("never treats a content-derived SUUMO row id as identity", async () => {
    const store = new MemoryStore();
    // Two rooms, same building/layout/rent: SUUMO gives both the same row id.
    const roomA = listing({ id: "suumo-サンハイツ-2K-46000", url: "https://suumo.jp/chintai/jnc_000071956655/", sizeM2: 30 });
    const roomB = listing({ id: "suumo-サンハイツ-2K-46000", url: "https://suumo.jp/chintai/jnc_000074335627/", sizeM2: 31 });
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [roomA, roomB] } }));
    await syncPropertyDocuments(store, evidence({ sources: [{ source: "suumo", rows: [{ listing: roomA, observedAt: null }, { listing: roomB, observedAt: null }], archived: [], sightings: [] }] }));
    expect(store.live()).toHaveLength(2);
  });

  it("keeps a same-key twin apart even when it comes before the known room", async () => {
    const store = new MemoryStore();
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [listing()] } }));
    const twin = listing({ id: "suumo-3", url: "https://suumo.jp/chintai/jnc_000888888888/" });
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [twin, listing()] } }));
    expect(store.live()).toHaveLength(2);
  });

  it("does not merge on a historical build's grouping", async () => {
    const store = new MemoryStore();
    await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [listing(), athome({ name: "別名", address: "埼玉県草加市" })] } }));
    const grouped = { ...listing(), sourceListings: [{ source: "suumo", id: "suumo-1", url: SUUMO_URL }, { source: "athome", id: "athome-1222222222", url: ATHOME_URL }] };
    const report = await syncPropertyDocuments(store, evidence({ canonical: { builtAt: null, rows: [grouped], groupingAuthoritative: false } }));
    expect(report.merged).toBe(0);
    expect(store.live()).toHaveLength(2);
  });

  it("shows the value each ad most recently switched to, even without capture times", async () => {
    const store = new MemoryStore();
    const at = (asOf: string, rent: number) => evidence({ asOf, sources: [{ source: "suumo", rows: [{ listing: listing({ rent }), observedAt: null }], archived: [], sightings: [] }] });
    await syncPropertyDocuments(store, at("2026-09-01T00:00:00.000Z", 100000));
    await syncPropertyDocuments(store, at("2026-09-05T00:00:00.000Z", 95000));
    expect(store.live()[0].facts.rent.chosen).toBe(95000);
    await syncPropertyDocuments(store, at("2026-09-09T00:00:00.000Z", 100000));
    expect(store.live()[0].facts.rent.chosen).toBe(100000);
    // Re-reporting the unchanged value rewrites nothing.
    expect(await syncPropertyDocuments(store, at("2026-09-10T00:00:00.000Z", 100000))).toMatchObject({ changed: 0 });
    // An archived version never beats the current row.
    await syncPropertyDocuments(store, evidence({ asOf: "2026-09-11T00:00:00.000Z", sources: [{ source: "suumo", rows: [{ listing: listing({ rent: 100000 }), observedAt: null }], archived: [{ listing: listing({ rent: 90000 }), retiredAt: "2026-09-10T12:00:00.000Z", reason: "superseded" }], sightings: [] }] }));
    expect(store.live()[0].facts.rent.chosen).toBe(100000);
  });

  it("counts an old, unchecked ad last seen before the others went gone as off the market", async () => {
    const store = new MemoryStore();
    const oldAd = listing({ id: "suumo-old", url: "https://suumo.jp/chintai/jnc_000000000001/" });
    await syncPropertyDocuments(store, evidence({ sources: [{ source: "suumo", rows: [{ listing: oldAd, observedAt: "2026-08-01T00:00:00.000Z" }], archived: [], sightings: [] }] }));
    const grouped = { ...listing(), sourceListings: [{ source: "suumo", id: "suumo-old", url: oldAd.url }, { source: "suumo", id: "suumo-1", url: SUUMO_URL }] };
    await syncPropertyDocuments(store, evidence({
      canonical: { builtAt: null, rows: [grouped] },
      sources: [{ source: "suumo", rows: [{ listing: listing(), observedAt: "2026-09-01T00:00:00.000Z" }], archived: [], sightings: [] }],
      availability: [{ key: "suumo|jnc_000111111111", source: "suumo", url: SUUMO_URL, state: "gone", checkedAt: "2026-09-10T00:00:00.000Z", evidence: "HTTP 404", method: "probe" }],
    }));
    expect(store.live()[0].summary).toMatchObject({ status: "gone", offMarket: { after: "2026-09-01T00:00:00.000Z", before: "2026-09-10T00:00:00.000Z" } });
  });

  it("does not flip-flop when a file holds two rows for one ad", async () => {
    const store = new MemoryStore();
    const twoRows = (asOf: string) => evidence({ asOf, recordedAt: asOf, sources: [{ source: "suumo", archived: [], sightings: [], rows: [
      { listing: listing({ sizeM2: 70.01 }), observedAt: null },
      { listing: listing({ url: `${SUUMO_URL}&bc=2`, sizeM2: 74.15 }), observedAt: null },
    ] }] });
    await syncPropertyDocuments(store, twoRows("2026-09-01T00:00:00.000Z"));
    expect(store.live()[0].facts.sizeM2.values.map((v) => v.value)).toEqual([70.01, 74.15]);
    expect(await syncPropertyDocuments(store, twoRows("2026-09-02T00:00:00.000Z"))).toMatchObject({ changed: 0 });
  });

  it("keeps SUUMO ads apart by bc, and attributes each check to the bc it looked at", async () => {
    const store = new MemoryStore();
    const jnc = "https://suumo.jp/chintai/jnc_000107662512/";
    const live = listing({ url: `${jnc}?bc=100518201426`, sizeM2: 70.01 });
    const ended = listing({ url: `${jnc}?bc=100508329517`, sizeM2: 74.15, name: "別の部屋" });
    await syncPropertyDocuments(store, evidence({
      canonical: { builtAt: null, rows: [live, ended] },
      availability: [{ key: "suumo|jnc_000107662512", source: "suumo", url: ended.url!, state: "gone", checkedAt: "2026-10-03T00:00:00.000Z", evidence: "redirected", method: "probe" }],
    }));
    const docs = store.live();
    expect(docs).toHaveLength(2);
    const endedDoc = docs.find((doc) => doc.ads["suumo|jnc_000107662512|bc_100508329517"])!;
    expect(endedDoc.events.filter((e) => e.type === "ad.checked")).toHaveLength(1);
    expect(docs.find((doc) => doc !== endedDoc)!.events.some((e) => e.type === "ad.checked")).toBe(false);
  });

  it("joins a SUUMO room re-posted under a new bc, but not a different room on the same jnc", async () => {
    const store = new MemoryStore();
    const jnc = "https://suumo.jp/chintai/jnc_000108148800/";
    const first = listing({ url: `${jnc}?bc=100517801810`, layout: "2K", sizeM2: 29.49 });
    await syncPropertyDocuments(store, evidence({ sources: [{ source: "suumo", rows: [{ listing: first, observedAt: "2026-09-28T00:00:00.000Z" }], archived: [], sightings: [] }] }));
    const reposted = listing({ url: `${jnc}?bc=100517536456`, layout: "2K", sizeM2: 29.49 });
    const otherRoom = listing({ url: `${jnc}?bc=100514348667`, layout: "2K", sizeM2: 29.75 });
    await syncPropertyDocuments(store, evidence({ sources: [{ source: "suumo", rows: [{ listing: reposted, observedAt: "2026-10-02T00:00:00.000Z" }, { listing: otherRoom, observedAt: "2026-10-02T00:00:00.000Z" }], archived: [], sightings: [] }] }));
    const docs = store.live();
    expect(docs).toHaveLength(2);
    expect(Object.keys(docs.find((doc) => doc.ads["suumo|jnc_000108148800|bc_100517801810"])!.ads)).toEqual([
      "suumo|jnc_000108148800|bc_100517536456", "suumo|jnc_000108148800|bc_100517801810",
    ]);
  });
});
