import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../../src/domain/types";
import type { DetailPatchBatch } from "../../src/data-layer/ingestion/contracts";
import { ListingIngestionService, InvalidScrapeBatchError, ScrapeReplayConflictError } from "../../src/data-layer/ingestion/service";
import { RevisionConflictError } from "../../src/data-layer/errors";
import { DATA_DIR, JsonSourceStore, type SourceFile } from "./dataStore";
import { JsonListingRepository } from "./jsonListingRepository";
import { detailCaptureBatch } from "./suumoDetailIngestion";
import { parseDetail } from "./detailEnrichment";
import { trackingKey } from "./lifecycle";

const capturedAt = "2026-09-24T00:00:00.000Z", sourceAt = "2026-09-25T00:00:00.000Z";
const html = '<table><tr><th>駐車場</th><td>敷地内6600円</td></tr><tr><th>契約期間</th><td>定期借家2年</td></tr><tr><th>保証会社</th><td>必加入</td></tr></table><ul class="inline_list"><li>都市ガス</li></ul>';
const options = { maxRent: 150000, minSize: 40 };
const row = (id = "one", changes: Partial<RawListing> = {}): RawListing => ({ id, source: "suumo", name: id,
  address: `埼玉県草加市${id}`, rent: 80000, sizeM2: 50, layout: "2LDK", builtYear: 2010, stationWalkMin: 5,
  url: `https://suumo.jp/chintai/${id}/`, ...changes });
const batch = (url = row().url!, at = capturedAt, body = html) => detailCaptureBatch([{ url, capturedAt: at, html: body }], options);

describe("SUUMO detail data-layer policy", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, service: ListingIngestionService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "suumo-detail-policy-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store); service = new ListingIngestionService(repository);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  async function seed(listings = [row()], completeSnapshot?: boolean) {
    await store.writeSource({ source: "suumo", scrapedAt: sourceAt, completeSnapshot, listings,
      provenance: { capturedBy: "list collector", observedTrackingKeys: [trackingKey(listings[0])], observedAtByKey: { [trackingKey(listings[0])]: sourceAt }, custom: "retained" },
      archivedListings: [{ sourceListingId: "retired", listing: row("retired"), retiredAt: capturedAt, reason: "fixture" }],
    }, { expectedRevision: null });
  }

  it.each([undefined, false, true])("enriches exact source rows without changing lifecycle/completeness (%s)", async (complete) => {
    const prior = row("one", { rent: 87000, status: "sold", soldAt: capturedAt, lastSeenAt: capturedAt,
      costs: { cleaningFeeYen: 40000, guarantorRequired: false }, building: { floor: "2階" } });
    const unseen = row("unseen");
    await seed([prior, unseen], complete);
    await store.writeSource({ source: "athome", scrapedAt: sourceAt, listings: [{ ...prior, source: "athome" }] }, { expectedRevision: null });
    const otherBytes = await readFile(store.sourcePath("athome"), "utf8");
    const userPath = join(root, "user.json"), canonicalPath = join(root, "listings_raw.json");
    await writeFile(userPath, '{"marks":{"one":"favorite"}}'); await writeFile(canonicalPath, JSON.stringify([prior]));
    const userBytes = await readFile(userPath, "utf8"), canonicalBytes = await readFile(canonicalPath, "utf8");
    const previous = (await store.readSource("suumo"))!;
    const request = await batch();
    expect(request.observations[0]).not.toHaveProperty("listing");
    expect(request).toMatchObject({ observationKind: "detail-patch", mode: "detail-enrichment", scraper: { name: "suumo-detail", version: "1", parserVersion: "1" } });
    const result = await service.ingestScrape(request);
    expect(result).toMatchObject({ added: 0, updated: 1, retired: 0, currentCount: 2 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings[0]).toEqual({ ...prior, ...parseDetail(html),
      costs: { ...prior.costs, parking: parseDetail(html).parking, parkingYen: 6600, guarantorRequired: true },
      tenancy: { leaseType: "fixed-term", leaseMonths: 24 },
      building: { floor: "2階", features: ["都市ガス"] },
    });
    expect(saved.listings[1]).toEqual(unseen);
    expect(saved.scrapedAt).toBe(sourceAt);
    expect(saved.completeSnapshot).toBe(complete);
    expect(saved.archivedListings).toEqual(previous.archivedListings);
    expect(saved.provenance).toMatchObject({ ...previous.provenance, detailObservedAtByUrl: { [prior.url!]: capturedAt },
      ingestionJournal: { batches: [{ metadata: { capturedAt }, evidence: [{ observedAt: capturedAt, url: prior.url }] }] } });
    expect(await readFile(store.sourcePath("athome"), "utf8")).toBe(otherBytes);
    expect(await readFile(userPath, "utf8")).toBe(userBytes);
    expect(await readFile(canonicalPath, "utf8")).toBe(canonicalBytes);
  });

  it.each([1, 2])("enriches %s exact URLs without collapsing legacy rows with a shared ID", async (count) => {
    const rows = [row("legacy"), row("legacy", { url: row("second").url, rent: 91000 })];
    await seed(rows);
    const input = await detailCaptureBatch(rows.slice(0, count).map((listing) => ({ url: listing.url!, capturedAt, html })), options);
    expect(await service.ingestScrape(input)).toMatchObject({ updated: count, currentCount: 2, added: 0, retired: 0 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings.map((listing) => [listing.id, listing.url, listing.rent])).toEqual(rows.map((listing) => [listing.id, listing.url, listing.rent]));
    expect(saved.listings[0].parking?.monthlyYen).toBe(6600);
    if (count === 1) expect(saved.listings[1]).toEqual(rows[1]);
    else expect(saved.listings[1].parking?.monthlyYen).toBe(6600);
  });

  it("replays idempotently after restart/newer detail writes and rejects changed batch-ID reuse", async () => {
    await seed();
    const original = await batch();
    await service.ingestScrape(original);
    const newer = await batch(row().url!, sourceAt, html.replace("6600", "7700"));
    await service.ingestScrape(newer);
    const bytes = await readFile(store.sourcePath("suumo"), "utf8"), backups = await readdir(store.backupDir);
    const restarted = new ListingIngestionService(new JsonListingRepository(store));
    expect(await restarted.ingestScrape(original)).toMatchObject({ replayed: true, updated: 0 });
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(await readdir(store.backupDir)).toEqual(backups);
    const changed = { ...original, observations: newer.observations };
    await expect(service.ingestScrape(changed)).rejects.toBeInstanceOf(ScrapeReplayConflictError);
    const older = await batch(row().url!, "2026-09-23T00:00:00.000Z", html.replace("6600", "5500"));
    expect(await service.ingestScrape(older)).toMatchObject({ updated: 0, ignored: 1 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings[0].parking!.monthlyYen).toBe(7700);
    expect(saved.provenance!.detailObservedAtByUrl).toEqual({ [row().url!]: sourceAt });
  });

  it("retains replay/freshness metadata across legacy source-writer provenance replacement", async () => {
    await seed(); const input = await batch(); await service.ingestScrape(input);
    const previous = (await store.readSource("suumo"))!;
    await store.writeSource({ ...previous, scrapedAt: sourceAt, provenance: { mode: "later list crawl" },
      listings: previous.listings.map((listing) => ({ ...listing, rent: 99000 })),
    }, { expectedRevision: previous.revision! });
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    expect(await service.ingestScrape(input)).toMatchObject({ replayed: true, updated: 0 });
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings[0].rent).toBe(99000);
    expect(saved.provenance!.detailObservedAtByUrl).toEqual({ [row().url!]: capturedAt });
  });

  it("preserves known details for absent fields while allowing explicit false/zero", async () => {
    await seed([row("one", { costs: { guarantorRequired: true, cleaningFeeYen: 40000 }, tenancy: { leaseType: "regular" }, building: { features: ["都市ガス"] } })]);
    const input = await batch();
    input.observations[0].details = { costs: { guarantorRequired: false, cleaningFeeYen: 0 }, tenancy: { leaseType: null }, building: { features: [] } };
    await service.ingestScrape(input);
    expect((await store.readSource("suumo"))!.listings[0]).toMatchObject({ costs: { guarantorRequired: false, cleaningFeeYen: 0 }, tenancy: { leaseType: "regular" }, building: { features: ["都市ガス"] } });
  });

  it("rejects unknown URLs and missing sources rather than adding or resurrecting ads", async () => {
    await expect(service.ingestScrape(await batch())).rejects.toThrow("source missing");
    await seed();
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    const unknown = await detailCaptureBatch([{ url: row().url!, capturedAt, html }, { url: row("retired").url!, capturedAt, html }], options);
    await expect(service.ingestScrape(unknown)).rejects.toThrow("unknown source URL");
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
  });

  it.each([
    ["rent", { rent: 1 }], ["lifecycle", { status: "active" }], ["ownership", { source: "athome" }],
    ["user data", { favorite: true }], ["nested ownership", { costs: { favorite: true } }],
    ["malformed amounts", { costs: { cleaningFeeYen: "cheap" } }], ["invalid features", { building: { features: [123] } }],
    ["incomplete parking", { parking: {} }], ["invalid lease", { tenancy: { leaseType: "anything" } }],
  ])("rejects %s in patches before accessing source storage", async (_, details) => {
    const input = await batch();
    const read = vi.spyOn(repository, "readSource");
    (input.observations[0] as unknown as { details: unknown }).details = details;
    await expect(service.ingestScrape(input)).rejects.toBeInstanceOf(InvalidScrapeBatchError);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["producer version", (input: DetailPatchBatch) => { input.scraper.version = "2"; }],
    ["parser version", (input: DetailPatchBatch) => { input.scraper.parserVersion = "2"; }],
    ["timestamp", (input: DetailPatchBatch) => { input.observations[0].observedAt = "unknown"; }],
    ["evidence", (input: DetailPatchBatch) => { input.observations[0].evidence.captureId = ""; }],
    ["identity", (input: DetailPatchBatch) => { input.observations[0].sourceListingId = "other"; }],
    ["scope", (input: DetailPatchBatch) => { input.scope.urls = []; }],
    ["managed provenance", (input: DetailPatchBatch) => { input.provenance = { detailObservedAtByUrl: {} }; }],
  ])("requires valid %s for detail observations", async (_, change) => {
    const input = await batch(); change(input);
    const read = vi.spyOn(repository, "readSource");
    await expect(service.ingestScrape(input)).rejects.toBeInstanceOf(InvalidScrapeBatchError);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns deduplicated eligible URLs using combined cross-source details, with force override", async () => {
    const wanted = row("wanted"), complete = row("complete");
    await seed([wanted, complete, row("expensive", { rent: 200000 }), row("small", { sizeM2: 30 }),
      row("single", { layout: "1K" }), row("sold", { status: "sold" })]);
    await store.writeSource({ source: "athome", scrapedAt: sourceAt, listings: [
      { ...wanted, id: "athome-wanted", source: "athome", url: "https://www.athome.co.jp/wanted/" },
      { ...complete, id: "athome-complete", source: "athome", url: "https://www.athome.co.jp/complete/",
        ...parseDetail(html) },
    ] }, { expectedRevision: null });
    expect(await service.planDetailEnrichment({ ...options, force: false })).toEqual([wanted.url]);
    expect(await service.planDetailEnrichment({ ...options, force: true })).toEqual([complete.url, wanted.url]);
  });

  it("matches the legacy detail overlay on an isolated copy of the entire checked-in SUUMO source", async () => {
    const path = join(DATA_DIR, "sources", "suumo.json");
    const bytes = await readFile(path, "utf8");
    const previous = JSON.parse(bytes) as SourceFile;
    await store.writeSource(previous, { expectedRevision: null });
    const target = previous.listings.find((listing) => listing.url?.startsWith("https://suumo.jp/"))!;
    const priorTimes = (previous.provenance?.detailObservedAtByUrl ?? {}) as Record<string, string>;
    const newerAt = new Date(Math.max(Date.parse(previous.scrapedAt), Date.parse(priorTimes[target.url!] ?? previous.scrapedAt)) + 1000).toISOString();
    const request = await batch(target.url!, newerAt);
    const details = parseDetail(html);
    // Independent copy of the old writer's defined-field overlay for parity.
    const defined = (value: object) => Object.fromEntries(Object.entries(value).filter(([, v]) => v != null && (!Array.isArray(v) || v.length > 0)));
    const expected = previous.listings.map((listing) => listing.url === target.url ? {
      ...listing, ...defined(details), costs: { ...listing.costs, ...defined(details.costs ?? {}) },
      tenancy: { ...listing.tenancy, ...defined(details.tenancy ?? {}) }, building: { ...listing.building, ...defined(details.building ?? {}) },
    } : listing);
    await service.ingestScrape(request);
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings).toEqual(expected);
    expect(saved.count).toBe(previous.count);
    expect(saved.scrapedAt).toBe(previous.scrapedAt);
    expect(saved.completeSnapshot).toBe(previous.completeSnapshot);
    const { ingestionJournal: _journal, detailObservedAtByUrl: _times, ...captureProvenance } = previous.provenance ?? {};
    expect(saved.provenance).toMatchObject(captureProvenance);
    expect(await service.ingestScrape(request)).toMatchObject({ replayed: true, revision: saved.revision });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("leaves source data/journal unchanged on a failed commit and permits explicit replay", async () => {
    await seed(); const input = await batch();
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    vi.spyOn(store, "writeSource").mockRejectedValueOnce(new Error("disk failure"));
    await expect(service.ingestScrape(input)).rejects.toThrow("disk failure");
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(await service.ingestScrape(input)).toMatchObject({ replayed: false, updated: 1 });
  });

  it("surfaces a concurrent source update without automatic retry or overwriting its price", async () => {
    await seed();
    const actualIngest = repository.ingest.bind(repository);
    const ingest = vi.spyOn(repository, "ingest").mockImplementationOnce(async (input) => {
      const previous = (await store.readSource("suumo"))!;
      await store.writeSource({ ...previous, listings: previous.listings.map((listing) => ({ ...listing, rent: 99000 })) }, { expectedRevision: previous.revision! });
      return actualIngest(input);
    });
    await expect(service.ingestScrape(await batch())).rejects.toBeInstanceOf(RevisionConflictError);
    expect(ingest).toHaveBeenCalledTimes(1);
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings[0].rent).toBe(99000);
    expect(saved.provenance).not.toHaveProperty("ingestionJournal");
  });
});
