import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../src/domain/types";
import type { LegacyListing } from "../src/data-layer/contracts";
import type { SourceBootstrapAudit, SourceBootstrapRequest } from "../src/data-layer/bootstrap/contracts";
import { InvalidSourceBootstrapError, SourceBootstrapService } from "../src/data-layer/bootstrap/service";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import type { ScrapeBatch } from "../src/data-layer/ingestion/contracts";
import { contentFingerprint } from "../src/data-layer/contentIdentity";
import { RevisionConflictError } from "../src/data-layer/errors";
import { sourceObservationFallbackTime, sourceSnapshotCaptureTime } from "../src/data-layer/sourceObservationTime";
import { DATA_DIR, JsonSourceStore } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { reconcileLifecycle } from "../src/data-layer/lifecycle";
import { restoreObservedLifecycle } from "../src/storage/json/observations";
import { runSourceMigration } from "./migrate-sources";

const importedAt = "2026-09-25T00:00:00.000Z", oldAt = "2026-08-01T00:00:00.000Z";
const row = (id = "one", source = "suumo", changes: Partial<RawListing> = {}): RawListing => ({ id, source, name: id,
  address: `埼玉県草加市${id}`, url: `https://example.test/${id}`, rent: 80000, layout: "2LDK", sizeM2: 50,
  builtYear: 2010, stationWalkMin: 5, ...changes });
const request = (records: readonly LegacyListing[] = [row()]): SourceBootstrapRequest => ({ schemaVersion: 1,
  migration: { name: "legacy-source-split", version: "1" }, operationId: "operation-1", actor: "fixture operator",
  reason: "Preserve legacy source history", input: { datasetId: "listings_raw.json", records } });

describe("audited historical source bootstrap", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, service: SourceBootstrapService;
  let clock: ReturnType<typeof vi.fn<() => Date>>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "source-bootstrap-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store); clock = vi.fn(() => new Date(importedAt));
    service = new SourceBootstrapService(repository, clock);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("preserves all legacy shapes, duplicate rows/IDs, order, lifecycle and provenance evidence", async () => {
    const sold = row("same", "suumo", { status: "sold", firstSeenAt: oldAt, lastSeenAt: oldAt, soldAt: "2026-09-01T00:00:00.000Z" });
    const sibling = { ...row("same"), url: "https://example.test/other-ad", rent: 91000, futureField: { retained: [null, false, 0] } };
    const unknown = { name: "Missing source/ID/URL", address: "", rent: 0, future: "kept" };
    const legacy: LegacyListing[] = [sold, row("n1", "nifty"), sibling, unknown, sold,
      { ...unknown, source: null }, { ...unknown, source: "" }, { ...unknown, source: "unknown" },
      row("new", "agency-2027", { layout: "1K", id: null, url: null })];
    const canonicalPath = join(root, "listings_raw.json"), userPath = join(root, "user.json");
    await writeFile(canonicalPath, JSON.stringify(legacy)); await writeFile(userPath, '{"marks":{"same":"favorite"}}');
    const inputBytes = await readFile(canonicalPath, "utf8"), userBytes = await readFile(userPath, "utf8");
    const submit = vi.spyOn(repository, "initializeHistoricalSource"), progress = vi.fn();
    const results = await service.bootstrapSources(request(legacy), progress);
    expect(results.map(({ source, count, status }) => ({ source, count, status }))).toEqual([
      { source: "suumo", count: 3, status: "created" }, { source: "nifty", count: 1, status: "created" },
      { source: "unknown", count: 4, status: "created" }, { source: "agency-2027", count: 1, status: "created" },
    ]);
    for (const result of results) {
      const expected = legacy.filter((listing) => (listing.source || "unknown") === result.source);
      const saved = (await store.readSource(result.source))!;
      expect(saved.listings).toEqual(expected); expect(saved.count).toBe(expected.length);
      expect(saved.completeSnapshot).toBe(false);
      expect(saved.provenance).toMatchObject({ migratedFrom: "listings_raw.json", observedTrackingKeys: [], observedAtByKey: {} });
      expect(saved.provenance!.bootstrapAudit).toEqual({ schemaVersion: 1, migration: request().migration,
        operationId: "operation-1", actor: "fixture operator", reason: request().reason, importedAt,
        captureSemantics: "historical-only", source: result.source, recordCount: expected.length,
        recordsFingerprint: await contentFingerprint(expected),
        input: { datasetId: "listings_raw.json", recordCount: legacy.length, fingerprint: await contentFingerprint(legacy) },
      });
      expect(sourceSnapshotCaptureTime(saved)).toBeUndefined();
      expect(sourceObservationFallbackTime(saved)).toBeUndefined();
    }
    expect(submit.mock.calls.every(([, options]) => options.expectedRevision === null)).toBe(true);
    expect(progress.mock.calls.map(([result]) => result)).toEqual(results);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(await readFile(canonicalPath, "utf8")).toBe(inputBytes); expect(await readFile(userPath, "utf8")).toBe(userBytes);
    await expect(readdir(store.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
    // Simulate the existing derived reconciliation, not a production data:build.
    const current = reconcileLifecycle([sold], [sold], importedAt).listings;
    restoreObservedLifecycle(current, [sold], [(await store.readSource("suumo"))!]);
    expect(current[0]).toMatchObject({ status: "sold", firstSeenAt: oldAt, lastSeenAt: oldAt, soldAt: sold.soldAt });
  });

  it("skips existing sources unconditionally, even when the input changes, without new backups or clock reads", async () => {
    await service.bootstrapSources(request());
    const previous = (await store.readSource("suumo"))!;
    await store.writeSource({ ...previous, provenance: { mode: "later collector" }, listings: [row("newer")] }, { expectedRevision: previous.revision! });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.provenance).toHaveProperty("bootstrapAudit");
    const bytes = await readFile(store.sourcePath("suumo"), "utf8"), backups = await readdir(store.backupDir);
    const readClock = vi.fn(() => new Date()); const restarted = new SourceBootstrapService(new JsonListingRepository(store), readClock);
    const changedInput = { ...request([row("different")]), reason: "different input/metadata must never replace an existing source" };
    expect(await restarted.bootstrapSources(changedInput)).toEqual([{ source: "suumo", status: "skipped", count: 1, revision: saved.revision }]);
    expect(readClock).not.toHaveBeenCalled(); expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(await readdir(store.backupDir)).toEqual(backups);
  });

  it("does not retrofit bootstrap audit metadata onto an existing live source or touch unrelated sources", async () => {
    const live = { source: "suumo", scrapedAt: oldAt, completeSnapshot: true, listings: [row("live")],
      provenance: { capturedBy: "live collector", custom: "retained" },
      archivedListings: [{ sourceListingId: "archived", listing: row("archived"), retiredAt: oldAt, reason: "fixture" }],
    };
    await store.writeSource(live, { expectedRevision: null });
    await store.writeSource({ source: "yahoo", scrapedAt: oldAt, listings: [row("unrelated", "yahoo")] }, { expectedRevision: null });
    const liveBytes = await readFile(store.sourcePath("suumo"), "utf8"), unrelatedBytes = await readFile(store.sourcePath("yahoo"), "utf8");
    expect(await service.bootstrapSources(request())).toMatchObject([{ status: "skipped" }]);
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(liveBytes);
    expect(await readFile(store.sourcePath("yahoo"), "utf8")).toBe(unrelatedBytes);
    expect(clock).not.toHaveBeenCalled();
    await expect(readdir(store.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains per-source commits/progress after failure and resumes by skipping only existing sources", async () => {
    const inputPath = join(root, "listings_raw.json"), records = [row("a", "athome"), row("b", "suumo")];
    await writeFile(inputPath, JSON.stringify(records)); const log = vi.fn();
    const write = store.writeSource.bind(store);
    vi.spyOn(store, "writeSource").mockImplementationOnce(write).mockRejectedValueOnce(new Error("simulated disk failure"));
    await expect(runSourceMigration(inputPath, service, log)).rejects.toThrow("simulated disk failure");
    expect(log.mock.calls.map(([line]) => line)).toEqual(["  athome: 1 listings → data/sources/athome.json"]);
    expect(await store.readSource("suumo")).toBeNull();
    const firstBytes = await readFile(store.sourcePath("athome"), "utf8"); log.mockClear();
    expect(await runSourceMigration(inputPath, service, log)).toMatchObject([{ source: "athome", status: "skipped" }, { source: "suumo", status: "created" }]);
    expect(log.mock.calls.map(([line]) => line)).toEqual(["  athome: source file already exists, skipped", "  suumo: 1 listings → data/sources/suumo.json", "\nNext: npm run data:build"]);
    expect(await readFile(store.sourcePath("athome"), "utf8")).toBe(firstBytes);
    expect((await store.readSource("suumo"))!.listings).toEqual([records[1]]);
    expect(JSON.parse(await readFile(inputPath, "utf8"))).toEqual(records);
  });

  it("preserves missing/empty/invalid input CLI behavior without production side effects", async () => {
    const inputPath = join(root, "listings_raw.json"), log = vi.fn(); const submit = vi.spyOn(service, "bootstrapSources");
    expect(await runSourceMigration(inputPath, service, log)).toBeNull();
    expect(log).toHaveBeenCalledWith("No listings_raw.json to migrate."); expect(submit).not.toHaveBeenCalled();
    await writeFile(inputPath, "[]"); log.mockClear();
    expect(await runSourceMigration(inputPath, service, log)).toEqual([]); expect(log).toHaveBeenCalledWith("\nNext: npm run data:build");
    expect(clock).not.toHaveBeenCalled(); expect(await store.listSources()).toEqual([]);
    await writeFile(inputPath, "not json"); await expect(runSourceMigration(inputPath, service, log)).rejects.toThrow();
    expect(await store.listSources()).toEqual([]);
  });

  it.each([
    ["future schema", { schemaVersion: 2 }], ["unknown migration", { migration: { name: "replace-sources", version: "1" } }],
    ["future migration", { migration: { name: "legacy-source-split", version: "2" } }], ["empty actor", { actor: "" }],
    ["empty reason", { reason: " " }], ["empty operation", { operationId: "" }],
    ["missing dataset ID", { input: { datasetId: "", records: [] } }], ["invalid records", { input: { datasetId: "history", records: {} } }],
    ["forged provenance", { provenance: { observedAtByKey: { any: importedAt } } }],
  ])("rejects %s before touching target sources", async (_, changes) => {
    const read = vi.spyOn(repository, "readSource"), write = vi.spyOn(repository, "initializeHistoricalSource");
    await expect(service.bootstrapSources({ ...request(), ...changes } as SourceBootstrapRequest)).rejects.toBeInstanceOf(InvalidSourceBootstrapError);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it.each(["../escape", "/absolute", "_manifest", "SUUMO", "a/b", "a\\b", " ", "nul", "a".repeat(129)])("rejects unsafe/ambiguous source ID %s before any group is committed", async (source) => {
    const read = vi.spyOn(repository, "readSource");
    await expect(service.bootstrapSources(request([row("valid"), row("invalid", source)]))).rejects.toBeInstanceOf(InvalidSourceBootstrapError);
    expect(read).not.toHaveBeenCalled(); expect(await store.listSources()).toEqual([]);
  });

  it("fails closed on malformed rows and lossy non-JSON values anywhere in the input", async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const invalidRows = [{ source: "nifty" }, null, { ...row(), rent: NaN }, { ...row(), source: 123 },
      { ...row(), id: 123 }, { ...row(), future: undefined }, { ...row(), future: new Date() }, { ...row(), future: cycle }];
    const read = vi.spyOn(repository, "readSource");
    for (const invalid of invalidRows) {
      await expect(service.bootstrapSources(request([row("valid", "athome"), invalid] as LegacyListing[]))).rejects.toBeInstanceOf(InvalidSourceBootstrapError);
    }
    expect(read).not.toHaveBeenCalled(); expect(await store.listSources()).toEqual([]);
  });

  it("surfaces a racing creator as a conflict without retry or overwrite", async () => {
    const read = repository.readSource.bind(repository); let reads = 0, release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(repository, "readSource").mockImplementation(async (source) => {
      const previous = await read(source); if (++reads === 2) release(); await barrier; return previous;
    });
    const create = vi.spyOn(repository, "initializeHistoricalSource");
    const results = await Promise.allSettled([service.bootstrapSources(request([row("a")])), service.bootstrapSources(request([row("b")]))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    expect(reads).toBe(2); expect(create).toHaveBeenCalledTimes(2);
    expect((await store.readSource("suumo"))!.count).toBe(1);
    await expect(readdir(store.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("owns a copy of the input across asynchronous reads", async () => {
    const input = request([row()]); const original = JSON.parse(JSON.stringify(input.input.records));
    vi.spyOn(repository, "readSource").mockImplementationOnce(async () => { input.input.records[0].rent = 1; return null; });
    await service.bootstrapSources(input);
    expect((await store.readSource("suumo"))!.listings).toEqual(original);
  });

  it("does not mistake import time for a freshness barrier for real Nifty or native-browser captures", async () => {
    const old = row("nifty-aabbcc", "nifty", { url: "https://myhome.nifty.com/rent/detail_aabbcc/" });
    const other = row("nifty-ddeeff", "nifty", { url: "https://myhome.nifty.com/rent/detail_ddeeff/" });
    await service.bootstrapSources(request([old, other]));
    const fresh = { ...old, rent: 91000 }; const at = "2026-09-20T00:00:00.000Z";
    const scrape = (listing: RawListing, capturedAt: string, batchId: string): ScrapeBatch => ({ schemaVersion: 1, source: "nifty",
      scraper: { name: "nifty-list", version: "1", parserVersion: "1" }, runId: "capture-run", batchId, mode: "discovery", capturedAt,
      scope: { urls: [listing.url!], cities: ["Soka"], filters: {} }, observations: [{ sourceListingId: listing.id!, observedAt: capturedAt,
        evidence: { url: listing.url!, captureId: batchId }, listing }] });
    const ingestion = new ListingIngestionService(repository);
    expect(await ingestion.ingestScrape(scrape(fresh, at, "first"))).toMatchObject({ updated: 1 });
    const saved = (await store.readSource("nifty"))!;
    expect(saved.listings[0].rent).toBe(91000); expect(saved.scrapedAt).toBe(at); expect(sourceSnapshotCaptureTime(saved)).toBe(at);
    // The other row still has no actual source observation, despite a newer
    // batch envelope from the first row's capture.
    expect(await ingestion.ingestScrape(scrape({ ...other, rent: 92000 }, "2026-09-19T00:00:00.000Z", "other"))).toMatchObject({ updated: 1 });
    expect(await ingestion.ingestScrape(scrape({ ...fresh, rent: 50000 }, "2026-09-18T00:00:00.000Z", "old"))).toMatchObject({ updated: 0, ignored: 1 });
    expect((await store.readSource("nifty"))!.listings[0].rent).toBe(91000);
  });

  it("reports only actual capture times for historical envelopes and keeps ordinary/complete snapshots compatible", () => {
    const historical = { scrapedAt: importedAt, completeSnapshot: false,
      provenance: { bootstrapAudit: { importedAt }, observedAtByKey: { first: oldAt, bad: "invalid" } } };
    expect(sourceSnapshotCaptureTime(historical)).toBe(oldAt);
    expect(sourceObservationFallbackTime(historical)).toBeUndefined();
    expect(sourceSnapshotCaptureTime({ ...historical, completeSnapshot: true })).toBe(importedAt);
    expect(sourceObservationFallbackTime({ ...historical, completeSnapshot: true })).toBe(importedAt);
    expect(sourceObservationFallbackTime({ scrapedAt: oldAt })).toBe(oldAt);
    expect(sourceSnapshotCaptureTime({ scrapedAt: oldAt })).toBe(oldAt);
  });

  it("matches the original split for every checked-in canonical row, without altering the input", async () => {
    const path = join(DATA_DIR, "listings_raw.json"), bytes = await readFile(path, "utf8");
    const records = JSON.parse(bytes) as LegacyListing[];
    const results = await service.bootstrapSources(request(records));
    let total = 0;
    for (const result of results) {
      const saved = (await store.readSource(result.source))!;
      expect(saved.listings).toEqual(records.filter((listing) => (listing.source || "unknown") === result.source));
      expect((saved.provenance!.bootstrapAudit as SourceBootstrapAudit).recordCount).toBe(saved.count);
      expect(saved.completeSnapshot).toBe(false); total += saved.count;
    }
    expect(total).toBe(records.length);
    expect((await service.bootstrapSources(request(records))).every((result) => result.status === "skipped")).toBe(true);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});
