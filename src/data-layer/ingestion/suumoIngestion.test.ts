import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../../domain/types";
import type { ScrapeBatch } from "./contracts";
import { InvalidScrapeBatchError, ListingIngestionService, ScrapeReplayConflictError } from "./service";
import { sourceRowKey, sourceRowLocator } from "../sourceRowIdentity";
import { DATA_DIR, JsonSourceStore, ShrinkGuardError, type SourceFile } from "../../storage/json/dataStore";
import { JsonListingRepository } from "../../storage/json/jsonListingRepository";
import { mergeSuumoIncremental, suumoMatchKeys } from "./suumoIdentity";
import { trackingKey } from "../lifecycle";

const oldAt = "2026-09-24T00:00:00.000Z", at = "2026-09-25T00:00:00.000Z";
const row = (id = "display-id", bc = "1", changes: Partial<RawListing> = {}): RawListing => ({ id, source: "suumo", name: `House ${bc}`,
  address: `埼玉県草加市町${bc}区`, rent: 80000, sizeM2: 50, layout: "2LDK", builtYear: 2010, stationWalkMin: 5,
  url: `https://suumo.jp/chintai/jnc_${bc}/?bc=${bc}`, ...changes });
function request(rows = [row()], capturedAt = at, batchId = "batch-1"): ScrapeBatch {
  const pageUrl = `https://suumo.jp/chintai/saitama/sc_soka/?md=05&po1=09`;
  return { schemaVersion: 1, source: "suumo", scraper: { name: "suumo-list", version: "1", parserVersion: "1" },
    mode: "discovery", runId: "run-1", batchId, capturedAt, scope: { urls: [pageUrl], cities: ["Soka"], filters: { page: 1 } },
    observations: rows.map((listing) => ({ sourceListingId: listing.url!, observedAt: capturedAt, listing, evidence: { url: pageUrl, captureId: batchId } })) };
}

describe("SUUMO public discovery ingestion", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, service: ListingIngestionService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "suumo-discovery-policy-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store); service = new ListingIngestionService(repository);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  async function seed(listings: RawListing[]) {
    await store.writeSource({ source: "suumo", scrapedAt: oldAt, completeSnapshot: false, listings,
      provenance: { custom: "retained", observedAtByKey: Object.fromEntries(listings.map((listing) => [trackingKey(listing), oldAt])) },
      archivedListings: [{ sourceListingId: "older", listing: row("older", "999"), retiredAt: oldAt, reason: "earlier archive" }],
    }, { expectedRevision: null });
  }

  it("resolves exact ad/alias identity, archives replaced pairs, and preserves colliding display IDs and expensive details", async () => {
    const prior = row("collision", "1", { parking: { available: true, monthlyYen: 6000, location: null, distanceM: null, raw: "6000円" },
      costs: { cleaningFeeYen: 40000 }, tenancy: { leaseType: "regular" }, building: { features: ["都市ガス"], totalFloors: 3 },
      status: "sold", soldAt: oldAt, lastSeenAt: oldAt });
    const unrelated = row("collision", "2");
    const duplicate = row("alias-copy", "3", { name: prior.name, address: prior.address });
    await seed([prior, unrelated, duplicate]);
    await store.writeSource({ source: "yahoo", scrapedAt: oldAt, listings: [{ ...unrelated, source: "yahoo" }] }, { expectedRevision: null });
    const userPath = join(root, "user.json"), canonicalPath = join(root, "listings_raw.json");
    await writeFile(userPath, '{"favorites":["collision"]}'); await writeFile(canonicalPath, JSON.stringify([prior, unrelated]));
    const ownedPaths = [userPath, canonicalPath, store.sourcePath("yahoo")];
    const bytes = await Promise.all(ownedPaths.map((path) => readFile(path, "utf8")));
    const fresh = row("new-display", "1", { rent: 85000, costs: { adminFeeYen: 1000 }, building: { floor: "2階" } });
    const result = await service.ingestScrape(request([fresh]));
    expect(result).toMatchObject({ added: 0, updated: 1, retired: 2, currentCount: 2 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings[0]).toMatchObject({ ...fresh, parking: prior.parking, costs: { adminFeeYen: 1000, cleaningFeeYen: 40000 },
      tenancy: prior.tenancy, building: { floor: "2階", totalFloors: 3, features: ["都市ガス"] }, status: "sold", soldAt: oldAt, lastSeenAt: oldAt });
    expect(saved.listings[1]).toEqual(unrelated);
    expect(saved.archivedListings!.slice(1).map((entry) => entry.listing)).toEqual([prior, duplicate]);
    expect(saved.completeSnapshot).toBe(false);
    expect(saved.provenance).toMatchObject({ custom: "retained", observedTrackingKeys: [trackingKey(fresh)],
      observedAtByKey: { [trackingKey(fresh)]: at, [trackingKey(unrelated)]: oldAt },
      ingestionJournal: { batches: [{ metadata: { scraper: request().scraper } }] } });
    expect(await Promise.all(ownedPaths.map((path) => readFile(path, "utf8")))).toEqual(bytes);
  });

  it("preserves unseen historical aliases instead of opportunistically compacting them", async () => {
    const a = row("unseen-a", "1"), b = { ...a, id: "unseen-b", url: row("unseen-b", "2").url };
    await seed([a, b]);
    const fresh = row("new", "3");
    expect(await service.ingestScrape(request([fresh]))).toMatchObject({ added: 1, retired: 0, currentCount: 3 });
    expect((await store.readSource("suumo"))!.listings).toEqual([fresh, a, b]);
  });

  it("can retain a collision while adding another ad with the same generated display ID", async () => {
    const prior = row("collision", "1"), fresh = row("collision", "2"); await seed([prior]);
    expect(await service.ingestScrape(request([fresh]))).toMatchObject({ added: 1, retired: 0, currentCount: 2 });
    expect((await store.readSource("suumo"))!.listings).toEqual([fresh, prior]);
  });

  it("uses an exact ad URL even without bc/jnc when display fields change", async () => {
    const prior = row("old", "1", { url: "https://suumo.jp/chintai/detail/fixture-ad/" });
    await seed([prior]);
    const fresh = row("new", "2", { url: prior.url, rent: 99000, sizeM2: 75 });
    expect(await service.ingestScrape(request([fresh]))).toMatchObject({ added: 0, updated: 1, retired: 1, currentCount: 1 });
    expect((await store.readSource("suumo"))!.listings).toEqual([fresh]);
  });

  it("does not leave a reconciliation or receipt after a failed storage commit", async () => {
    await seed([row()]); const input = request([row("replacement")]);
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    vi.spyOn(store, "writeSource").mockRejectedValueOnce(new Error("disk failure"));
    await expect(service.ingestScrape(input)).rejects.toThrow("disk failure");
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(await service.ingestScrape(input)).toMatchObject({ replayed: false, retired: 1 });
  });

  it("replays durably after a newer write and rejects conflicting batch-ID reuse", async () => {
    await seed([row()]); const first = request([row(undefined, undefined, { rent: 81000 })]);
    await service.ingestScrape(first);
    await service.ingestScrape(request([row(undefined, undefined, { rent: 90000 })], "2026-09-26T00:00:00.000Z", "newer"));
    const bytes = await readFile(store.sourcePath("suumo"), "utf8"), backups = await readdir(store.backupDir);
    expect(await new ListingIngestionService(new JsonListingRepository(store)).ingestScrape(first)).toMatchObject({ replayed: true, updated: 0, retired: 0 });
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes); expect(await readdir(store.backupDir)).toEqual(backups);
    await expect(service.ingestScrape({ ...first, provenance: { changed: true } })).rejects.toBeInstanceOf(ScrapeReplayConflictError);
  });

  it("does not regress newer prices or compact history for an all-stale import, even with --force", async () => {
    const prior = row("one", "1"), alias = { ...prior, id: "alias", url: row("alias", "2").url };
    await seed([prior, alias]);
    expect(await service.ingestScrape(request([row("new-display", "1", { rent: 1 })], "2026-09-23T00:00:00.000Z"), { allowShrink: true })).toMatchObject({ updated: 0, retired: 0, ignored: 1 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings).toEqual([prior, alias]); expect(saved.scrapedAt).toBe(oldAt);
    expect(saved.provenance!.observedAtByKey).toEqual({ [trackingKey(prior)]: oldAt });
  });

  it("accepts repeated ads across captures but records only the selected observation's real time", async () => {
    await seed([row()]);
    const first = request([row(undefined, undefined, { rent: 81000 })]);
    const later = { ...first.observations[0], observedAt: "2026-09-25T00:01:00.000Z", listing: row(undefined, undefined, { rent: 82000 }), evidence: { ...first.observations[0].evidence, captureId: "page-two" } };
    const result = await service.ingestScrape({ ...first, capturedAt: later.observedAt, observations: [...first.observations, later] });
    expect(result).toMatchObject({ updated: 1, ignored: 1 });
    const saved = (await store.readSource("suumo"))!;
    expect(saved.listings[0].rent).toBe(81000);
    expect(saved.provenance!.observedAtByKey).toEqual({ [trackingKey(row())]: at });
  });

  it("requires an existing source and never invents a complete market snapshot", async () => {
    await expect(service.ingestScrape(request())).rejects.toThrow("No SUUMO snapshot");
    await seed([row()]);
    await expect(service.ingestScrape({ ...request(), mode: "full-snapshot" })).rejects.toBeInstanceOf(InvalidScrapeBatchError);
  });

  it.each([
    ["producer", (input: ScrapeBatch) => { input.scraper.version = "2"; }],
    ["parser", (input: ScrapeBatch) => { input.scraper.parserVersion = "2"; }],
    ["stable ad identity", (input: ScrapeBatch) => { input.observations[0].sourceListingId = input.observations[0].listing.id!; }],
    ["canonical fields", (input: ScrapeBatch) => { input.observations[0].listing.status = "sold"; }],
    ["timestamp", (input: ScrapeBatch) => { input.observations[0].observedAt = null; }],
    ["future observation", (input: ScrapeBatch) => { input.observations[0].observedAt = "2027-01-01T00:00:00.000Z"; }],
    ["evidence", (input: ScrapeBatch) => { input.observations[0].evidence.captureId = ""; }],
    ["empty page", (input: ScrapeBatch) => { input.observations = []; }],
  ])("rejects invalid %s before accessing storage", async (_, change) => {
    const input = request(); change(input); const read = vi.spyOn(repository, "readSource");
    await expect(service.ingestScrape(input)).rejects.toBeInstanceOf(InvalidScrapeBatchError);
    expect(read).not.toHaveBeenCalled();
  });

  it("retains shrink protection and commits the archive/journal only with explicit override", async () => {
    const original = row("old", "1");
    await seed([1, 2, 3, 4].map((bc) => ({ ...original, id: `old-${bc}`, url: row("x", String(bc)).url })));
    const input = request([row("fresh", "1")]); const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    await expect(service.ingestScrape(input)).rejects.toBeInstanceOf(ShrinkGuardError);
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(await service.ingestScrape(input, { allowShrink: true })).toMatchObject({ currentCount: 1, retired: 4, replayed: false });
    expect((await store.readSource("suumo"))!.archivedListings).toHaveLength(5);
  });

  it("verifies every current SUUMO row is either retained or explicitly archived, without rewriting production data", async () => {
    const path = join(DATA_DIR, "sources", "suumo.json"), bytes = await readFile(path, "utf8");
    const previous = JSON.parse(bytes) as SourceFile;
    await store.writeSource(previous, { expectedRevision: null });
    const target = previous.listings[0];
    const { status: _status, firstSeenAt: _first, lastSeenAt: _last, soldAt: _sold, sourceListings: _links, ...fields } = target;
    const fresh = { ...fields, id: `${target.id}-fixture`, rent: target.rent + 1000 };
    const priorTimes = Object.values(previous.provenance?.observedAtByKey ?? {}).filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
    const capturedAt = new Date(Math.max(Date.parse(previous.scrapedAt), ...priorTimes.map(Date.parse)) + 1000).toISOString();
    const input = request([fresh], capturedAt);
    const result = await service.ingestScrape(input);
    const saved = (await store.readSource("suumo"))!;
    const key = (listing: RawListing) => sourceRowKey(sourceRowLocator(listing));
    const current = new Map(saved.listings.map((listing) => [key(listing), listing]));
    const archived = saved.archivedListings!.slice(previous.archivedListings?.length ?? 0);
    const retired = new Map(archived.map((entry) => [key(entry.listing), entry.listing]));
    for (const listing of previous.listings) {
      if (current.has(key(listing))) expect(current.get(key(listing))).toEqual(listing);
      else expect(retired.get(key(listing))).toEqual(listing);
    }
    // All old merger survivors remain equivalent. The new policy additionally
    // keeps unseen duplicates that the legacy helper would compact implicitly.
    for (const listing of mergeSuumoIncremental(previous.listings, [fresh]).listings) expect(current.get(key(listing))).toEqual(listing);
    expect(saved.listings.length + archived.length).toBe(previous.listings.length + 1);
    expect(result.retired).toBe(archived.length);
    expect(saved.listings.some((listing) => suumoMatchKeys(listing).some((alias) => suumoMatchKeys(fresh).includes(alias)))).toBe(true);
    expect(await service.ingestScrape(input)).toMatchObject({ replayed: true, revision: saved.revision });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});
