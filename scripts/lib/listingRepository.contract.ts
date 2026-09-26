import { describe, expect, it } from "vitest";
import type { ListingObservationBatch, ListingRepository } from "../../src/data-layer/contracts";
import type { RawListing } from "../../src/types";
import { RevisionConflictError } from "../../src/data-layer/errors";

export interface ListingRepositoryHarness {
  repository: ListingRepository;
  cleanup(): Promise<void>;
}

export type CreateListingRepositoryHarness = () => Promise<ListingRepositoryHarness>;

/**
 * Reusable semantic contract for storage adapters. Invoke this suite once per
 * implementation (JSON now, any database adapter later) with an isolated store.
 */
export function defineListingRepositoryContract(
  implementationName: string,
  createHarness: CreateListingRepositoryHarness,
): void {
  describe(`${implementationName} ListingRepository contract`, () => {
    it("initializes historical rows verbatim without IDs, deduplication or new observation evidence", async () => {
      const harness = await createHarness();
      try {
        const importedAt = "2026-09-25T00:00:00.000Z";
        const rows = [listing("shared"), { ...listing("shared"), url: "https://example.test/second", rent: 91000 },
          { name: "Old row", address: "", rent: 0, source: "fixture", futureField: { retained: true } }];
        await harness.repository.initializeHistoricalSource({ source: "fixture", importedAt, listings: rows,
          provenance: { migratedFrom: "fixture history", observedTrackingKeys: ["not-evidence"], observedAtByKey: { "not-evidence": importedAt } },
        }, { expectedRevision: null });
        const saved = (await harness.repository.readSource("fixture"))!;
        expect(saved.listings).toEqual(rows);
        expect(saved).toMatchObject({ scrapedAt: importedAt, completeSnapshot: false,
          provenance: { migratedFrom: "fixture history", observedTrackingKeys: [], observedAtByKey: {} } });
        await expect(harness.repository.initializeHistoricalSource({ source: "fixture", importedAt, listings: [], provenance: {} }, { expectedRevision: null })).rejects.toBeInstanceOf(RevisionConflictError);
        await expect(harness.repository.readSource("fixture")).resolves.toEqual(saved);
      } finally { await harness.cleanup(); }
    });

    it("does not normalize missing source fields when initializing the unknown historical group", async () => {
      const harness = await createHarness();
      try {
        const rows = [{ name: "Unattributed", address: "", rent: 0 },
          { name: "Empty", address: "", rent: 0, source: "" }, { name: "Null", address: "", rent: 0, source: null }];
        await harness.repository.initializeHistoricalSource({ source: "unknown", importedAt: "2026-09-25T00:00:00.000Z", listings: rows, provenance: {} }, { expectedRevision: null });
        expect((await harness.repository.readSource("unknown"))!.listings).toEqual(rows);
      } finally { await harness.cleanup(); }
    });

    it("only permits create-only, source-owned historical initialization", async () => {
      const harness = await createHarness();
      try {
        const seed = { source: "fixture", importedAt: "2026-09-25T00:00:00.000Z", listings: [listing("one")], provenance: {} };
        await expect(harness.repository.initializeHistoricalSource(seed, { expectedRevision: "stale" as unknown as null })).rejects.toThrow();
        await expect(harness.repository.initializeHistoricalSource({ ...seed, source: "other" }, { expectedRevision: null })).rejects.toThrow();
        await expect(harness.repository.initializeHistoricalSource({ ...seed, source: "../escape" }, { expectedRevision: null })).rejects.toThrow();
        await expect(harness.repository.listSources()).resolves.toEqual([]);
      } finally { await harness.cleanup(); }
    });

    it("allows only one concurrent historical initializer with expectedRevision null", async () => {
      const harness = await createHarness();
      try {
        const seed = { source: "fixture", importedAt: "2026-09-25T00:00:00.000Z", listings: [listing("one")], provenance: {} };
        const results = await Promise.allSettled([
          harness.repository.initializeHistoricalSource(seed, { expectedRevision: null }),
          harness.repository.initializeHistoricalSource({ ...seed, listings: [listing("two")] }, { expectedRevision: null }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
        expect((await harness.repository.readSource("fixture"))!.listings).toHaveLength(1);
      } finally { await harness.cleanup(); }
    });

    it("reconciles exact ID/URL pairs without collapsing generated-ID collisions", async () => {
      const harness = await createHarness();
      try {
        const first = listing("shared"), second = { ...listing("shared", 90000), url: "https://example.test/second" };
        const initial = await harness.repository.initializeHistoricalSource({ source: "fixture", importedAt: "2026-09-25T00:00:00.000Z", listings: [first, second], provenance: {} }, { expectedRevision: null });
        const batch = { source: "fixture", expectedRevision: initial.revision, observedAt: "2026-09-25T01:00:00.000Z", listings: [{ ...first, rent: 81000 }, second], retirements: [] };
        const result = await harness.repository.reconcileSource(batch);
        expect(result).toMatchObject({ accepted: 1, unchanged: 1, retired: 0 });
        expect((await harness.repository.readSource("fixture"))!.listings).toEqual(batch.listings);
        expect(await harness.repository.reconcileSource({ ...batch, expectedRevision: result.revision })).toMatchObject({ revision: result.revision, accepted: 0 });
      } finally { await harness.cleanup(); }
    });

    it("rejects unexplained omissions and archives only explicitly retired exact pairs", async () => {
      const harness = await createHarness();
      try {
        const first = listing("shared"), second = { ...listing("shared", 90000), url: "https://example.test/second" };
        const initial = await harness.repository.initializeHistoricalSource({ source: "fixture", importedAt: "2026-09-25T00:00:00.000Z", listings: [first, second], provenance: {} }, { expectedRevision: null });
        const batch = { source: "fixture", expectedRevision: initial.revision, observedAt: "2026-09-25T01:00:00.000Z", listings: [first], retirements: [] };
        const previous = await harness.repository.readSource("fixture");
        await expect(harness.repository.reconcileSource(batch)).rejects.toThrow("explicit retirement");
        const retirement = { sourceListingId: "shared", targetUrl: second.url, effectiveAt: batch.observedAt, reason: "Superseded source alias" };
        await expect(harness.repository.reconcileSource({ ...batch, retirements: [{ ...retirement, targetUrl: first.url }] })).rejects.toThrow();
        await expect(harness.repository.reconcileSource({ ...batch, listings: [{ ...first, source: "other" }], retirements: [retirement] })).rejects.toThrow();
        await expect(harness.repository.readSource("fixture")).resolves.toEqual(previous);
        await harness.repository.reconcileSource({ ...batch, retirements: [retirement] });
        expect(await harness.repository.readSource("fixture")).toMatchObject({ listings: [first], completeSnapshot: false,
          archivedListings: [{ sourceListingId: "shared", listing: second, reason: retirement.reason }] });
      } finally { await harness.cleanup(); }
    });

    it("permits only one concurrent exact-row reconciliation", async () => {
      const harness = await createHarness();
      try {
        const first = listing("one");
        const initial = await harness.repository.initializeHistoricalSource({ source: "fixture", importedAt: "2026-09-25T00:00:00.000Z", listings: [first], provenance: {} }, { expectedRevision: null });
        const batch = { source: "fixture", expectedRevision: initial.revision, observedAt: "2026-09-25T01:00:00.000Z", listings: [first], retirements: [] };
        const results = await Promise.allSettled([
          harness.repository.reconcileSource({ ...batch, listings: [{ ...first, rent: 81000 }] }),
          harness.repository.reconcileSource({ ...batch, listings: [{ ...first, rent: 82000 }] }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
      } finally { await harness.cleanup(); }
    });

    it("ingests a source observation idempotently", async () => {
      const harness = await createHarness();
      try {
        const batch = makeBatch(null, "incremental", [listing("listing-1", 80_000)], "2026-09-25T00:00:00.000Z");
        const first = await harness.repository.ingest(batch);
        const second = await harness.repository.ingest({ ...batch, expectedRevision: first.revision });

        expect(first.accepted).toBe(1);
        expect(second.accepted).toBe(0);
        expect(second.unchanged).toBe(1);
        expect(second.revision).toBe(first.revision);
        await expect(harness.repository.readSource("fixture")).resolves.toMatchObject({
          listings: [{ id: "listing-1" }],
        });
      } finally {
        await harness.cleanup();
      }
    });

    it("preserves unseen listings in incremental batches", async () => {
      const harness = await createHarness();
      try {
        const first = await harness.repository.ingest(
          makeBatch(null, "incremental", [listing("one"), listing("two")], "2026-09-25T00:00:00.000Z"),
        );
        const next = await harness.repository.ingest(
          makeBatch(first.revision, "incremental", [listing("one", 81_000)], "2026-09-25T00:01:00.000Z"),
        );

        expect(next.retired).toBe(0);
        await expect(harness.repository.readSource("fixture")).resolves.toMatchObject({
          listings: expect.arrayContaining([
            expect.objectContaining({ id: "one", rent: 81_000 }),
            expect.objectContaining({ id: "two" }),
          ]),
          archivedListings: [],
        });
      } finally {
        await harness.cleanup();
      }
    });

    it("allows explicit incremental retirement without treating other absences as deletion", async () => {
      const harness = await createHarness();
      try {
        const initial = await harness.repository.ingest(
          makeBatch(null, "incremental", [listing("one"), listing("two"), listing("three")], "2026-09-25T00:00:00.000Z"),
        );
        const retired = await harness.repository.ingest({
          ...makeBatch(initial.revision, "incremental", [listing("one")], "2026-09-25T00:01:00.000Z"),
          retirements: [{ id: "two", effectiveAt: "2026-09-25T00:01:00.000Z", reason: "Superseded duplicate" }],
        });
        const snapshot = await harness.repository.readSource("fixture");

        expect(retired.retired).toBe(1);
        expect(snapshot?.listings.map((row) => row.id)).toEqual(["one", "three"]);
        expect(snapshot?.archivedListings).toContainEqual(
          expect.objectContaining({ sourceListingId: "two", reason: "Superseded duplicate" }),
        );
      } finally {
        await harness.cleanup();
      }
    });

    it("archives records absent from a complete snapshot instead of deleting them", async () => {
      const harness = await createHarness();
      try {
        const initial = await harness.repository.ingest(
          makeBatch(null, "incremental", [listing("one"), listing("two")], "2026-09-25T00:00:00.000Z"),
        );
        const complete = makeBatch(initial.revision, "complete", [listing("one")], "2026-09-25T00:01:00.000Z");
        const retired = await harness.repository.ingest(complete);
        const snapshot = await harness.repository.readSource("fixture");

        expect(retired.retired).toBe(1);
        expect(snapshot?.listings.map((row) => row.id)).toEqual(["one"]);
        expect(snapshot?.archivedListings).toContainEqual(
          expect.objectContaining({
            sourceListingId: "two",
            reason: expect.stringContaining("complete source snapshot"),
            listing: expect.objectContaining({ id: "two" }),
          }),
        );

        const repeated = await harness.repository.ingest({ ...complete, expectedRevision: retired.revision });
        expect(repeated.retired).toBe(0);
        expect(repeated.revision).toBe(retired.revision);
      } finally {
        await harness.cleanup();
      }
    });

    it("retains application replay metadata when a compatibility collector replaces capture provenance", async () => {
      const harness = await createHarness();
      try {
        const managed = { ingestionJournal: { schemaVersion: 1, batches: [] }, correctionJournal: { schemaVersion: 1, operations: [] }, bootstrapAudit: { importedAt: "2026-09-24T00:00:00.000Z" }, detailObservedAtByUrl: { "https://example.test/one": "2026-09-24T00:00:00.000Z" } };
        const initial = await harness.repository.ingest({
          ...makeBatch(null, "incremental", [listing("one")], "2026-09-25T00:00:00.000Z"),
          provenance: { ...managed, newListingIds: ["one"], capturedBy: "original" },
        });
        await harness.repository.ingest({
          ...makeBatch(initial.revision, "incremental", [listing("one", 81_000)], "2026-09-25T01:00:00.000Z"),
          provenance: { capturedBy: "compatibility collector" },
        });
        expect((await harness.repository.readSource("fixture"))!.provenance).toEqual({ ...managed, capturedBy: "compatibility collector" });
      } finally { await harness.cleanup(); }
    });

    it("preserves snapshot completeness, capture time and unseen history during enrichment", async () => {
      const harness = await createHarness();
      try {
        const initialAt = "2026-09-25T00:00:00.000Z";
        const initial = await harness.repository.ingest(makeBatch(null, "complete", [listing("one"), listing("two")], initialAt));
        const result = await harness.repository.ingest({
          ...makeBatch(initial.revision, "incremental", [listing("one", 81_000)], "2026-09-25T01:00:00.000Z"),
          completeness: "preserve",
        });
        expect(result.retired).toBe(0);
        await expect(harness.repository.readSource("fixture")).resolves.toMatchObject({
          completeSnapshot: true, scrapedAt: initialAt, archivedListings: [],
          listings: [expect.objectContaining({ id: "one", rent: 81_000 }), expect.objectContaining({ id: "two" })],
        });
      } finally { await harness.cleanup(); }
    });

    it("does not allow preserving enrichment to create sources/IDs or retire rows", async () => {
      const harness = await createHarness();
      try {
        const batch = { ...makeBatch(null, "incremental", [listing("one")], "2026-09-25T00:00:00.000Z"), completeness: "preserve" as const };
        await expect(harness.repository.ingest(batch)).rejects.toThrow("existing source");
        const initial = await harness.repository.ingest({ ...batch, completeness: "incremental" });
        const previous = await harness.repository.readSource("fixture");
        await expect(harness.repository.ingest({ ...batch, expectedRevision: initial.revision,
          observations: [{ ...batch.observations[0], sourceListingId: "unknown", listing: listing("unknown") }],
        })).rejects.toThrow("cannot add");
        await expect(harness.repository.ingest({ ...batch, expectedRevision: initial.revision, observations: [],
          retirements: [{ id: "one", reason: "not an enrichment", effectiveAt: batch.observedAt }],
        })).rejects.toThrow("cannot retire");
        await expect(harness.repository.readSource("fixture")).resolves.toEqual(previous);
      } finally { await harness.cleanup(); }
    });

    it("allows only one concurrent write from a shared expected revision", async () => {
      const harness = await createHarness();
      try {
        const initial = await harness.repository.ingest(
          makeBatch(null, "incremental", [listing("one")], "2026-09-25T00:00:00.000Z"),
        );
        const expectedRevision = initial.revision;
        const writes = await Promise.allSettled([
          harness.repository.ingest(
            makeBatch(expectedRevision, "incremental", [listing("one", 82_000)], "2026-09-25T00:01:00.000Z"),
          ),
          harness.repository.ingest(
            makeBatch(expectedRevision, "incremental", [listing("one", 83_000)], "2026-09-25T00:02:00.000Z"),
          ),
        ]);

        expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
        const rejected = writes.find((write) => write.status === "rejected");
        expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(RevisionConflictError);
      } finally {
        await harness.cleanup();
      }
    });

    it("rejects malformed or cross-source batches without writing", async () => {
      const harness = await createHarness();
      try {
        await expect(
          harness.repository.ingest({
            ...makeBatch(null, "incremental", [listing("one")], "2026-09-25T00:00:00.000Z"),
            observations: [{
              source: "another-source",
              sourceListingId: "one",
              observedAt: "2026-09-25T00:00:00.000Z",
              listing: listing("one"),
            }],
          }),
        ).rejects.toThrow("does not match batch");
        await expect(harness.repository.readSource("fixture")).resolves.toBeNull();
      } finally {
        await harness.cleanup();
      }
    });
  });
}

function listing(id: string, rent = 80_000): RawListing {
  return {
    id,
    name: `Unit ${id}`,
    address: "埼玉県草加市",
    rent,
    layout: "2LDK",
    sizeM2: 50,
    builtYear: 2000,
    stationWalkMin: null,
    url: `https://example.test/${id}`,
    source: "fixture",
  };
}

function makeBatch(
  expectedRevision: string | null,
  completeness: "incremental" | "complete",
  listings: RawListing[],
  observedAt: string,
): ListingObservationBatch {
  return {
    source: "fixture",
    expectedRevision,
    observedAt,
    completeness,
    observations: listings.map((row) => ({
      source: "fixture",
      sourceListingId: row.id!,
      observedAt,
      listing: row,
    })),
  };
}
