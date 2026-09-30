import { describe, expect, it } from "vitest";
import type { RawListing } from "../../src/domain/types";
import { trackingKey } from "../../src/data-layer/lifecycle";
import { sourceObservationBatch } from "./sourceObservationBatch";

const listing = (id: string, changes: Partial<RawListing> = {}): RawListing => ({
  id,
  name: "Building 2F",
  address: "埼玉県草加市西町1-2",
  rent: 80_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2000,
  stationWalkMin: null,
  url: `https://example.test/${id}`,
  source: "fixture",
  ...changes,
});

const matchKeys = (row: RawListing) => [row.id ?? "", `property:${trackingKey(row)}`];

describe("sourceObservationBatch", () => {
  it("converts merged rows to an incremental batch and explicitly retires only aliased replacements", () => {
    const old = listing("old-id");
    const replacement = listing("new-id", { rent: 85_000 });
    const unrelated = listing("unseen-id", { name: "Another building", address: "埼玉県越谷市蒲生" });
    const observedAt = "2026-09-25T00:00:00.000Z";
    const batch = sourceObservationBatch({
      source: "fixture",
      previous: [old, unrelated],
      current: [replacement],
      expectedRevision: "rev-1",
      observedAt,
      observedAtByKey: { [trackingKey(replacement)]: "2026-09-24T23:59:00.000Z" },
      provenance: { capturedBy: "test" },
      matchKeys,
    });

    expect(batch.completeness).toBe("incremental");
    expect(batch.observations).toEqual([expect.objectContaining({
      sourceListingId: "new-id",
      observedAt: "2026-09-24T23:59:00.000Z",
    })]);
    expect(batch.retirements).toEqual([expect.objectContaining({
      id: "old-id",
      reason: expect.stringContaining("matching source aliases"),
    })]);
  });

  it("does not interpret unexplained absence as a retirement", () => {
    const previous = listing("not-in-this-page");
    const current = listing("other", { name: "Different", address: "埼玉県川口市", sizeM2: 43 });
    const batch = sourceObservationBatch({
      source: "fixture",
      previous: [previous],
      current: [current],
      expectedRevision: "rev-1",
      observedAt: "2026-09-25T00:00:00.000Z",
      observedAtByKey: {},
      provenance: {},
      matchKeys,
    });
    expect(batch.retirements).toEqual([]);
  });
});
