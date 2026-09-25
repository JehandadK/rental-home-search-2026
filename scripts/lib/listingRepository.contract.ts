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
