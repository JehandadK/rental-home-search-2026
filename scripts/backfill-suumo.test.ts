import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../src/domain/types";
import type { SourceCorrectionJournal, SourceCorrectionRequest } from "../src/data-layer/corrections/contracts";
import { InvalidSourceCorrectionError, SourceCorrectionReplayConflictError, SourceCorrectionService } from "../src/data-layer/corrections/service";
import { backfillSuumoNotes } from "../src/data-layer/corrections/suumoNotes";
import { RevisionConflictError } from "../src/data-layer/errors";
import { DATA_DIR, JsonSourceStore, type SourceFile } from "./lib/dataStore";
import { JsonListingRepository } from "./lib/jsonListingRepository";
import { runSuumoBackfill } from "./backfill-suumo";

const sourceAt = "2026-09-24T00:00:00.000Z", appliedAt = "2026-09-25T00:00:00.000Z";
const row = (id = "one", changes: Partial<RawListing> = {}): RawListing => ({ id, source: "suumo", name: id,
  address: `埼玉県草加市${id}`, url: `https://suumo.jp/chintai/${id}/`, rent: 80000, layout: "2LDK", sizeM2: 50,
  builtYear: 2010, stationWalkMin: 5, notes: "築5年・1階・管理費込", ...changes });
const request = (operationId = "operation-1"): SourceCorrectionRequest => ({ schemaVersion: 1, source: "suumo",
  rule: { name: "suumo-notes-backfill", version: "1" }, operationId, actor: "fixture operator", reason: "Recover structured fields from stored notes" });

/** Independent copy of the old script's transformation, including floor parsing. */
function legacyBackfill(listing: RawListing): RawListing {
  const segment = listing.notes?.split("・").find((part) => /階/.test(part) && !/階建/.test(part));
  const floor = listing.building?.floor ?? (segment?.trim() || null);
  const parts = (floor ?? "").normalize("NFKC").replace(/[，、]/g, ",").replace(/[／]/g, "/").replace(/[　]/g, " ").trim().split("/");
  const total = (parts[1] ?? parts[0]).match(/(?:地上)?(\d+)\s*階建/);
  const totalFloors = total ? parseInt(total[1], 10) : null;
  return { ...listing,
    ...(floor ? { building: { ...listing.building, floor, ...(totalFloors ? { totalFloors } : {}) } } : {}),
    ...(listing.notes?.includes("管理費込") && listing.costs?.adminFeeYen === undefined ? { costs: { ...listing.costs, adminFeeYen: null } } : {}),
  };
}

describe("SUUMO notes rule v1", () => {
  it.each([
    row(), row("null-floor", { building: { floor: null, features: ["都市ガス"] } }),
    row("known", { building: { floor: "4階/8階建", totalFloors: 9 }, costs: { adminFeeYen: 5000 } }),
    row("full-width", { building: { floor: "４階／地上８階建" } }),
    row("whole-building", { notes: "築5年・3階建・管理費込" }),
    row("unknown", { notes: null }), row("no-fee", { notes: "築5年・2階" }),
    row("empty-floor", { building: { floor: "" }, costs: { adminFeeYen: 0 } }),
    row("known-unknown", { costs: { adminFeeYen: null, cleaningFeeYen: 40000 } }),
  ])("matches the legacy rule without mutating $id", (listing) => {
    const original = JSON.stringify(listing);
    expect(backfillSuumoNotes(listing)).toEqual(legacyBackfill(listing));
    expect(JSON.stringify(listing)).toBe(original);
    expect(backfillSuumoNotes(backfillSuumoNotes(listing))).toEqual(backfillSuumoNotes(listing));
  });
});

describe("audited SUUMO source correction", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, service: SourceCorrectionService;
  let clock: ReturnType<typeof vi.fn<() => Date>>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "suumo-notes-correction-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store);
    clock = vi.fn(() => new Date(appliedAt)); service = new SourceCorrectionService(repository, clock);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  async function seed(listings = [row()], completeSnapshot?: boolean) {
    const input = { source: "suumo", scrapedAt: sourceAt, completeSnapshot, listings,
      futureEnvelope: { retained: true },
      provenance: { mode: "captured list", observedTrackingKeys: ["old-key"], observedAtByKey: { "old-key": sourceAt },
        ingestionJournal: { schemaVersion: 1, batches: [] }, detailObservedAtByUrl: { [row().url!]: sourceAt } },
      archivedListings: [{ sourceListingId: "retired", listing: row("retired"), retiredAt: sourceAt, reason: "fixture" }],
    };
    await store.writeSource(input, { expectedRevision: null });
    return (await store.readSource("suumo"))!;
  }

  it.each([undefined, false, true])("commits an atomic field audit while preserving completeness (%s) and all ownership boundaries", async (complete) => {
    const primary = { ...row(), status: "sold" as const, firstSeenAt: sourceAt, soldAt: sourceAt, lastSeenAt: sourceAt, futureRow: "retained" };
    const otherAd = row("one", { url: row("other-ad").url, notes: "築5年・2階・管理費込", rent: 91000 });
    const existing = row("existing", { notes: null, building: { floor: "4階/8階建", totalFloors: 9 }, costs: { adminFeeYen: 5000 } });
    const untouched = row("untouched", { notes: null });
    const previous = await seed([primary, otherAd, existing, untouched], complete);
    const beforeBytes = await readFile(store.sourcePath("suumo"), "utf8");
    await store.writeSource({ source: "yahoo", scrapedAt: sourceAt, listings: [{ ...primary, source: "yahoo" }] }, { expectedRevision: null });
    const otherBytes = await readFile(store.sourcePath("yahoo"), "utf8");
    const userPath = join(root, "user.json"), canonicalPath = join(root, "listings_raw.json");
    await writeFile(userPath, '{"marks":{"one":"favorite"}}'); await writeFile(canonicalPath, JSON.stringify(previous.listings));
    const userBytes = await readFile(userPath, "utf8"), canonicalBytes = await readFile(canonicalPath, "utf8");
    const result = await service.applyCorrection(request());
    expect(result).toMatchObject({ status: "applied", count: 4, withFloor: 3, updated: 3 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings).toEqual(previous.listings.map(legacyBackfill));
    expect(saved.scrapedAt).toBe(sourceAt); expect(saved.completeSnapshot).toBe(complete);
    expect(saved.archivedListings).toEqual(previous.archivedListings);
    expect(saved).toMatchObject({ futureEnvelope: { retained: true } });
    expect(saved.provenance).toMatchObject({ ...previous.provenance, backfilledAt: appliedAt });
    const journal = saved.provenance!.correctionJournal as SourceCorrectionJournal;
    expect(journal).toMatchObject({ schemaVersion: 1, operations: [{ operationId: "operation-1", request: request(), appliedAt,
      basedOnRevision: previous.revision, rows: [
        { sourceListingId: "one", targetUrl: primary.url, evidence: { notes: primary.notes, priorFloor: null }, changes: [
          { field: "building.floor", after: "1階" }, { field: "costs.adminFeeYen", after: null },
        ] },
        { sourceListingId: "one", targetUrl: otherAd.url, changes: [{ field: "building.floor", after: "2階" }, { field: "costs.adminFeeYen", after: null }] },
        { sourceListingId: "existing", changes: [{ field: "building.totalFloors", before: 9, after: 8 }] },
      ],
    }] });
    expect(journal.operations[0].rows[0].changes[1]).not.toHaveProperty("before");
    const backups = await readdir(store.backupDir);
    expect(backups).toHaveLength(1);
    expect(await readFile(join(store.backupDir, backups[0]), "utf8")).toBe(beforeBytes);
    expect(await readFile(store.sourcePath("yahoo"), "utf8")).toBe(otherBytes);
    expect(await readFile(userPath, "utf8")).toBe(userBytes); expect(await readFile(canonicalPath, "utf8")).toBe(canonicalBytes);
  });

  it("makes repeated CLI invocations true no-ops with stable revision, time and backups", async () => {
    await seed();
    const log = vi.fn(); const submit = vi.spyOn(service, "applyCorrection");
    const first = await runSuumoBackfill(service, log);
    expect(submit.mock.calls[0][0]).toMatchObject({ actor: "scripts/backfill-suumo.ts", rule: { name: "suumo-notes-backfill", version: "1" }, reason: expect.any(String), operationId: expect.any(String) });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "Backfilled 1 suumo listings: 1 now carry a structured floor.", "Admin fee stays unknown until the next `npm run scrape`.", "\nNext: npm run data:build && npm run enrich",
    ]);
    const bytes = await readFile(store.sourcePath("suumo"), "utf8"), backups = await readdir(store.backupDir);
    clock.mockReturnValue(new Date("2026-10-01T00:00:00.000Z"));
    expect(await runSuumoBackfill(service, vi.fn())).toMatchObject({ status: "unchanged", updated: 0, revision: first.revision });
    expect(submit.mock.calls[1][0].operationId).not.toBe(submit.mock.calls[0][0].operationId);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes); expect(await readdir(store.backupDir)).toEqual(backups);
  });

  it("retains committed replay identity after restart and a compatibility writer's provenance replacement", async () => {
    await seed(); await service.applyCorrection(request());
    const prior = (await store.readSource("suumo"))!;
    await store.writeSource({ ...prior, provenance: { mode: "later collector" }, listings: [...prior.listings, row("new")] }, { expectedRevision: prior.revision! });
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    const restarted = new SourceCorrectionService(new JsonListingRepository(store));
    expect(await restarted.applyCorrection(request())).toMatchObject({ status: "replayed", count: 2, withFloor: 1, updated: 0 });
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    await expect(restarted.applyCorrection({ ...request(), reason: "different metadata" })).rejects.toBeInstanceOf(SourceCorrectionReplayConflictError);
    expect(await service.applyCorrection(request("operation-2"))).toMatchObject({ status: "applied", updated: 1, withFloor: 2 });
  });

  it("does not write audit records for missing sources or unchanged/empty datasets", async () => {
    const ingest = vi.spyOn(repository, "ingest"), log = vi.fn();
    expect(await runSuumoBackfill(service, log)).toMatchObject({ status: "missing", revision: null });
    expect(log).toHaveBeenCalledWith("No suumo source file — run `npm run scrape` first.");
    await seed([]);
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    expect(await service.applyCorrection(request())).toMatchObject({ status: "unchanged", count: 0 });
    expect(ingest).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    await expect(readdir(store.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports ID-less URL identities and rejects unidentifiable or ambiguous changed rows atomically", async () => {
    await seed([row("one", { id: null, building: { floor: null }, costs: { adminFeeYen: null } }), row("two", { url: null })]);
    expect(await service.applyCorrection(request())).toMatchObject({ status: "applied", updated: 2 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings.map((listing) => listing.id)).toEqual([null, "two"]);
    expect((saved.provenance!.correctionJournal as SourceCorrectionJournal).operations[0].rows[0].changes).toEqual([
      { field: "building.floor", before: null, after: "1階" },
    ]);
    for (const listings of [[row(), row("bad", { id: null, url: null })], [row(), row()]]) {
      const previous = (await store.readSource("suumo"))!;
      await store.writeSource({ ...previous, listings }, { expectedRevision: previous.revision! });
      const bytes = await readFile(store.sourcePath("suumo"), "utf8");
      await expect(service.applyCorrection(request("invalid-row"))).rejects.toThrow();
      expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    }
  });

  it.each([
    ["future schema", { schemaVersion: 2 }], ["wrong source", { source: "athome" }],
    ["unknown rule", { rule: { name: "rewrite-rent", version: "1" } }], ["future rule", { rule: { name: "suumo-notes-backfill", version: "2" } }],
    ["missing actor", { actor: "" }], ["missing reason", { reason: " " }], ["missing ID", { operationId: "" }],
    ["replacement rows", { listings: [] }], ["caller patches", { patch: { rent: 1 } }], ["forged provenance", { provenance: { correctionJournal: {} } }],
  ])("rejects %s before accessing storage", async (_, changes) => {
    const read = vi.spyOn(repository, "readSource");
    await expect(service.applyCorrection({ ...request(), ...changes } as SourceCorrectionRequest)).rejects.toBeInstanceOf(InvalidSourceCorrectionError);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{ schemaVersion: 2, operations: [] }, { schemaVersion: 1, operations: [{}] }])("fails closed on an invalid/future correction journal", async (correctionJournal) => {
    const previous = await seed();
    await store.writeSource({ ...previous, provenance: { ...previous.provenance, correctionJournal } }, { expectedRevision: previous.revision! });
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    await expect(service.applyCorrection(request())).rejects.toBeInstanceOf(InvalidSourceCorrectionError);
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
  });

  it("rejects unrepresentable derived values before serializing a misleading correction audit", async () => {
    await seed([row("overflow", { building: { floor: `1階/${"9".repeat(400)}階建` } })]);
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    await expect(service.applyCorrection(request())).rejects.toBeInstanceOf(InvalidSourceCorrectionError);
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
  });

  it("leaves no correction receipt or partial rows after a failed write", async () => {
    await seed(); const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    vi.spyOn(store, "writeSource").mockRejectedValueOnce(new Error("simulated disk failure"));
    await expect(service.applyCorrection(request())).rejects.toThrow("simulated disk failure");
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(await service.applyCorrection(request())).toMatchObject({ status: "applied", updated: 1 });
  });

  it("rejects a stale write without retrying and preserves concurrent price updates on explicit retry", async () => {
    await seed(); const actualIngest = repository.ingest.bind(repository);
    const ingest = vi.spyOn(repository, "ingest").mockImplementationOnce(async (batch) => {
      const previous = (await store.readSource("suumo"))!;
      await store.writeSource({ ...previous, listings: previous.listings.map((listing) => ({ ...listing, rent: 99000 })) }, { expectedRevision: previous.revision! });
      return actualIngest(batch);
    });
    await expect(service.applyCorrection(request())).rejects.toBeInstanceOf(RevisionConflictError);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect((await store.readSource("suumo"))!.provenance).not.toHaveProperty("correctionJournal");
    expect(await service.applyCorrection(request())).toMatchObject({ status: "applied" });
    expect((await store.readSource("suumo"))!.listings[0]).toMatchObject({ rent: 99000, building: { floor: "1階" } });
  });

  it("allows only one concurrent correction from a shared source revision", async () => {
    await seed(); const read = repository.readSource.bind(repository);
    let release!: () => void, reads = 0;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(repository, "readSource").mockImplementation(async (source) => {
      const snapshot = await read(source); if (++reads === 2) release(); await barrier; return snapshot;
    });
    const results = await Promise.allSettled([service.applyCorrection(request("a")), service.applyCorrection(request("b"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    expect(reads).toBe(2);
    expect(((await read("suumo"))!.provenance!.correctionJournal as SourceCorrectionJournal).operations).toHaveLength(1);
  });

  it("matches the old backfill on an isolated copy of every checked-in SUUMO row", async () => {
    const path = join(DATA_DIR, "sources", "suumo.json"), bytes = await readFile(path, "utf8");
    const previous = JSON.parse(bytes) as SourceFile;
    await store.writeSource(previous, { expectedRevision: null });
    const expected = previous.listings.map(legacyBackfill);
    const result = await service.applyCorrection(request("full-source-parity"));
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings).toEqual(expected); expect(saved.count).toBe(previous.count);
    expect(saved.scrapedAt).toBe(previous.scrapedAt); expect(saved.completeSnapshot).toBe(previous.completeSnapshot);
    expect(saved.archivedListings).toEqual(previous.archivedListings);
    expect(result.withFloor).toBe(expected.filter((listing) => listing.building?.floor).length);
    expect(await service.applyCorrection(request("new-noop"))).toMatchObject({ status: "unchanged", revision: result.revision });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});
