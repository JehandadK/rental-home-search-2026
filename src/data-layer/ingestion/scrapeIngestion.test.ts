import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../../domain/types";
import type { ScrapeBatch } from "./contracts";
import { ListingIngestionService, InvalidScrapeBatchError, ScrapeReplayConflictError } from "./service";
import { RevisionConflictError } from "../errors";
import { JsonSourceStore } from "../../storage/json/dataStore";
import { JsonListingRepository } from "../../storage/json/jsonListingRepository";
import { trackingKey } from "../lifecycle";

const at = "2026-09-25T00:00:00.000Z";
const later = "2026-09-25T01:00:00.000Z";
function row(id = "nifty-aabbcc", changes: Partial<RawListing> = {}): RawListing {
  return { id, name: "House", address: "埼玉県草加市1丁目", source: "nifty", rent: 80000,
    sizeM2: 50, layout: "2LDK", builtYear: 2010, stationWalkMin: 5,
    url: `https://myhome.nifty.com/rent/detail_${id.slice(6)}/`, ...changes };
}
function request(listings = [row()], batchId = "page-1", observedAt: string | null = at): ScrapeBatch {
  return { schemaVersion: 1, source: "nifty", scraper: { name: "nifty-detail", version: "1", parserVersion: "1" },
    runId: "run-1", batchId, mode: "detail-enrichment", capturedAt: observedAt ?? at,
    scope: { urls: listings.map((listing) => listing.url!), cities: ["Soka"], filters: { minRooms: 2 } },
    observations: listings.map((listing) => ({ sourceListingId: listing.id!, observedAt, listing,
      evidence: { url: listing.url!, captureId: `capture:${listing.id}` } })), provenance: { capturedBy: "fixture" } };
}

describe("public scrape ingestion boundary", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, service: ListingIngestionService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scrape-ingestion-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store);
    service = new ListingIngestionService(repository);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("persists producer metadata/evidence and rows together; replay survives restart and newer writes", async () => {
    const input = request();
    const first = await service.ingestScrape(input);
    expect(first).toMatchObject({ added: 1, currentCount: 1, previousCount: 0, replayed: false });
    const source = (await repository.readSource("nifty"))!;
    expect(source.provenance).toMatchObject({ ingestionJournal: { schemaVersion: 1, batches: [{
      runId: input.runId, batchId: input.batchId,
      metadata: { scraper: input.scraper, scope: input.scope, mode: "detail-enrichment" },
      evidence: [{ sourceListingId: "nifty-aabbcc", observedAt: at, ...input.observations[0].evidence }],
    }] } });
    const newer = request([row(undefined, { rent: 90000 })], "page-2", later);
    await service.ingestScrape(newer);
    const bytes = await readFile(store.sourcePath("nifty"), "utf8");
    const backups = await readdir(store.backupDir);
    const restarted = new ListingIngestionService(new JsonListingRepository(store));
    expect(await restarted.ingestScrape(input)).toMatchObject({ replayed: true, added: 0, updated: 0, retired: 0 });
    expect(await readFile(store.sourcePath("nifty"), "utf8")).toBe(bytes);
    expect(await readdir(store.backupDir)).toEqual(backups);
    expect((await repository.readSource("nifty"))!.listings[0].rent).toBe(90000);
  });

  it("rejects reused batch IDs with different content, even after newer batches", async () => {
    await service.ingestScrape(request());
    await service.ingestScrape(request([row()], "page-2", later));
    const bytes = await readFile(store.sourcePath("nifty"), "utf8");
    await expect(service.ingestScrape(request([row(undefined, { rent: 99999 })]))).rejects.toBeInstanceOf(ScrapeReplayConflictError);
    await expect(service.ingestScrape(request([row(undefined, { rent: 99999 })]))).rejects.toThrow(/already committed with different content.*not overwritten/);
    expect(await readFile(store.sourcePath("nifty"), "utf8")).toBe(bytes);
  });

  it("fingerprints semantic JSON rather than object insertion order", async () => {
    const input = request();
    const first = await service.ingestScrape(input);
    const reordered = { ...input, scraper: { parserVersion: "1", version: "1", name: "nifty-detail" } };
    expect(await service.ingestScrape(reordered)).toMatchObject({ replayed: true, revision: first.revision });
  });

  it("deduplicates observations itself, preserving unseen listings, details and source history", async () => {
    const prior = row(undefined, { parking: { available: true, monthlyYen: 6000, location: null, distanceM: null, raw: "6000円" }, tenancy: { leaseType: "regular" } });
    const unseen = row("nifty-ddeeff", { name: "Unseen", address: "埼玉県川口市", city: "Kawaguchi" });
    await service.ingestScrape(request([prior, unseen]));
    const replacement = row("nifty-112233", { rent: 85000 });
    const result = await service.ingestScrape(request([replacement, replacement], "page-2", later));
    expect(result).toMatchObject({ added: 0, updated: 1, retired: 1, ignored: 1, currentCount: 2 });
    const source = (await repository.readSource("nifty"))!;
    expect(source.listings).toContainEqual(unseen);
    expect(source.listings.find((listing) => listing.id === replacement.id)).toMatchObject({ rent: 85000, tenancy: { leaseType: "regular" }, parking: prior.parking });
    expect(source.archivedListings).toEqual([expect.objectContaining({ sourceListingId: prior.id, listing: prior })]);
    expect(source.completeSnapshot).toBe(false);
  });

  it("does not refresh unknown/old detail observations or invent availability for legacy additions", async () => {
    await service.ingestScrape(request());
    const legacy = row("nifty-ddeeff", { name: "Legacy", address: "埼玉県川口市" });
    const unknown = request([row(undefined, { rent: 60000 }), legacy], "legacy", null);
    expect(await service.ingestScrape(unknown)).toMatchObject({ added: 1, updated: 0, ignored: 1 });
    const older = request([row(undefined, { rent: 50000 })], "older", "2026-09-24T00:00:00.000Z");
    expect(await service.ingestScrape(older)).toMatchObject({ updated: 0, ignored: 1 });
    const saved = (await repository.readSource("nifty"))!;
    expect(saved.listings.find((listing) => listing.id === row().id)!.rent).toBe(80000);
    expect(saved.provenance!.observedAtByKey).toEqual({ [trackingKey(row())]: at });
    expect(saved.provenance!.observedTrackingKeys).toEqual([]);
    expect(saved.scrapedAt).toBe(at);
  });

  it.each([
    ["missing producer", { scraper: undefined }],
    ["unsupported scraper version", { scraper: { name: "nifty-detail", version: "2", parserVersion: "1" } }],
    ["unsupported parser version", { scraper: { name: "nifty-detail", version: "1", parserVersion: "3" } }],
    ["future schema", { schemaVersion: 2 }],
    ["unsafe source", { source: "../nifty" }],
    ["unverified complete snapshot", { mode: "full-snapshot" }],
    ["missing batch identity", { batchId: "" }],
    ["invalid capture time", { capturedAt: "not-a-date" }],
    ["missing scope", { scope: undefined }],
    ["reserved provenance", { provenance: { ingestionJournal: {} } }],
    ["reserved correction audit", { provenance: { correctionJournal: {} } }],
    ["reserved bootstrap audit", { provenance: { bootstrapAudit: {} } }],
  ])("rejects %s before accessing storage", async (_, overrides) => {
    const read = vi.spyOn(repository, "readSource"), write = vi.spyOn(repository, "ingest");
    await expect(service.ingestScrape({ ...request(), ...overrides } as ScrapeBatch)).rejects.toBeInstanceOf(InvalidScrapeBatchError);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("treats a re-parse under a newer detail-parser version as a new batch, not a replay conflict", async () => {
    await service.ingestScrape(request());
    const reparsed = { ...request([row(undefined, { rent: 99999 })]), runId: "run-1:parser-2",
      scraper: { name: "nifty-detail", version: "1", parserVersion: "2" } };
    expect(await service.ingestScrape(reparsed)).toMatchObject({ replayed: false });
    // Only the detail-import producer declares parser 2; list captures stay on 1.
    const list = { ...request(), mode: "discovery" as const, runId: "list-1",
      scraper: { name: "nifty-list", version: "1", parserVersion: "2" } };
    await expect(service.ingestScrape(list)).rejects.toBeInstanceOf(InvalidScrapeBatchError);
  });

  it("rejects an entire batch containing an invalid observation, including canonical-field injection", async () => {
    for (const invalid of [row(undefined, { rent: NaN }), row(undefined, { source: "suumo" }), row(undefined, { status: "sold" })]) {
      await expect(service.ingestScrape(request([row("nifty-ddeeff"), invalid]))).rejects.toBeInstanceOf(InvalidScrapeBatchError);
    }
    const input = request();
    input.observations[0].evidence.url = "https://example.com/capture";
    await expect(service.ingestScrape(input)).rejects.toBeInstanceOf(InvalidScrapeBatchError);
    expect(await repository.readSource("nifty")).toBeNull();
  });

  it("does not publish receipts when the source commit fails", async () => {
    await service.ingestScrape(request());
    const bytes = await readFile(store.sourcePath("nifty"), "utf8");
    vi.spyOn(store, "writeSource").mockRejectedValueOnce(new Error("simulated disk failure"));
    const next = request([row(undefined, { rent: 90000 })], "page-2", later);
    await expect(service.ingestScrape(next)).rejects.toThrow("simulated disk failure");
    expect(await readFile(store.sourcePath("nifty"), "utf8")).toBe(bytes);
    expect(await service.ingestScrape(next)).toMatchObject({ replayed: false, updated: 1 });
  });

  it("lets only one concurrent writer commit and never automatically retries a conflict", async () => {
    await service.ingestScrape(request());
    const read = repository.readSource.bind(repository);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    vi.spyOn(repository, "readSource").mockImplementation(async (source) => {
      const snapshot = await read(source);
      if (++reads === 2) release();
      await barrier;
      return snapshot;
    });
    const results = await Promise.allSettled([
      service.ingestScrape(request([row(undefined, { rent: 91000 })], "writer-a", later)),
      service.ingestScrape(request([row(undefined, { rent: 92000 })], "writer-b", later)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    expect(reads).toBe(2);
    const journal = (await read("nifty"))!.provenance!.ingestionJournal as { batches: unknown[] };
    expect(journal.batches).toHaveLength(2);
  });
});
