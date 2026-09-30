import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, JsonSourceStore, ShrinkGuardError, atomicWriteJson, type SourceFile } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { portalPageUrl } from "../src/data-layer/ingestion/portalDiscovery";
import { RevisionConflictError } from "../src/data-layer/errors";
import { sourceRowKey, sourceRowLocator } from "../src/data-layer/sourceRowIdentity";
import type { ScrapeBatch } from "../src/data-layer/ingestion/contracts";
import { ATHOME_COLLECTOR, runAthomeScrape } from "./scrape-athome";
import type { PortalCollectorDependencies } from "./lib/portalCollector";
import { athomeObservationBatch, mergeAthomeIncremental, parseAthomePage } from "./lib/athome";
import { portalDiscoveryKeys } from "../src/data-layer/ingestion/portalPolicy";
import { listCaptureBatch } from "./lib/listCaptureBatch";
import { trackingKey } from "../src/data-layer/lifecycle";
import type { PageCapture } from "./lib/captureStore";
import type { RawListing } from "../src/domain/types";

const oldAt = "2026-09-24T00:00:00.000Z", at = "2026-09-25T00:00:00.000Z";
const cities = ATHOME_COLLECTOR.cities;
const idFor = (city: number, page: number) => (city + 1) * 1000 + page;
function room(id: number, { rent = "6.9", layout = "2DK", parking = true } = {}) {
  return `<div class="p-property"><h2 class="p-property__title--building">テストハイツ${id} 2階建</h2>
<dl><dt><i title="所在地"></i></dt><dd><strong>草加市氷川町${id}</strong></dd></dl>
<dl><dt><i title="交通"></i></dt><dd>東武伊勢崎線 「草加」駅 徒歩8分</dd></dl>
<dl><dt><i title="家"></i></dt><dd>賃貸アパート<br>2階建<br>1991年8月 (築35年)</dd></dl>
<div class="p-property__room--detailbox" data-bukken-no="${id}">
 <div class="p-property__information-price"><b class="p-property__information-rent">${rent}</b>万円<span>3,000円</span></div>
 <div class="p-property__room-keymoney"><p>1.5ヶ月</p><span>なし</span></div>
 <div class="p-property__room-floorplan"><div class="p-property__floor">${layout}</div><span>39.79m²</span></div>
 ${parking ? '<div class="p-property__information-facility"><ul><li>駐車場（近隣含む）</li></ul></div>' : ""}
 <a href="/chintai/${id}/?DOWN=1">詳細を見る</a>
</div></div>`;
}
function capture(city: number, page: number, html = room(idFor(city, page)), capturedAt = at): PageCapture {
  return { schemaVersion: 1, source: "athome", city: cities[city].city, page, capturedAt, httpStatus: 200,
    url: portalPageUrl("athome", cities[city].url, page), html };
}
const cityIndex = (label: string) => cities.findIndex((city) => city.city === label);
const rows = (pages = [1, 2]) => cities.flatMap((_, city) => pages.flatMap((page) => parseAthomePage(capture(city, page).html, cities[city].city)));

describe("AtHome collector through staged public ingestion (offline)", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, client: ListingIngestionService, dependencies: PortalCollectorDependencies;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "athome-collector-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store); client = new ListingIngestionService(repository);
    dependencies = { client, sleep: vi.fn(async () => {}), log: vi.fn(), close: vi.fn(async () => {}), page: vi.fn(async (meta) => {
      const captured = capture(cityIndex(meta.city), meta.page);
      await atomicWriteJson(join(root, "captures", `${meta.city}-${meta.page}.json`), captured);
      return captured;
    }) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const seed = (listings: RawListing[] = rows(), provenance: Record<string, unknown> = { listTemplate: "retained" }) =>
    store.writeSource({ source: "athome", scrapedAt: oldAt, completeSnapshot: false, listings, provenance }, { expectedRevision: null });

  it("bootstraps a missing source with a deep crawl and a single create-only commit", async () => {
    const write = vi.spyOn(repository, "reconcileSource");
    const result = await runAthomeScrape(["--max-pages", "2"], dependencies);
    expect(dependencies.log).toHaveBeenCalledWith("No AtHome snapshot yet; automatically bootstrapping a deep discovery crawl.");
    expect(dependencies.log).toHaveBeenCalledWith("AtHome deep newest-first bootstrap");
    expect(dependencies.page).toHaveBeenCalledTimes(6); expect(write).toHaveBeenCalledTimes(1);
    expect(dependencies.close).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ added: 6, updated: 0, retired: 0, previousCount: 0, currentCount: 6 });
    const saved = (await store.readSource("athome"))!;
    expect(saved.listings).toEqual(rows());
    expect(saved.completeSnapshot).toBe(false); expect(saved.scrapedAt).toBe(at);
    expect(saved.provenance).toMatchObject({ mode: "deep newest-first", pagesFetched: 6, newListings: 6, capturedBy: "scripts/scrape-athome.ts",
      cities: ["soka-city", "koshigaya-city", "kawaguchi-city"], newListingIds: rows().map((row) => row.id) });
    expect(dependencies.log).toHaveBeenCalledWith("\nWrote 6 AtHome listings (was 0)");
    expect(dependencies.log).toHaveBeenCalledWith("Next: npm run data:build && npm run enrich && npm run find:new");
  });

  it("stops after two all-known pages per city, commits once, and replays without rewriting", async () => {
    await seed();
    const read = vi.spyOn(repository, "readSource"), write = vi.spyOn(repository, "reconcileSource");
    const result = await runAthomeScrape(["--max-pages", "5"], dependencies);
    expect(dependencies.page).toHaveBeenCalledTimes(6);
    expect(read).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ added: 0, updated: 6, retired: 0, currentCount: 6 });
    expect(dependencies.log).toHaveBeenCalledWith("AtHome incremental newest-first discovery");
    expect(dependencies.log).toHaveBeenCalledWith("\n=== Soka (soka-city) ===");
    expect(dependencies.log).toHaveBeenCalledWith("  page 1: 1 rooms (0 new, 1 known, 0 duplicate)");
    expect(dependencies.log).toHaveBeenCalledWith("  stopped: 2 consecutive pages were entirely known");
    expect(dependencies.log).toHaveBeenCalledWith("Discovered 0 new; refreshed 6 overlaps; retired 0 superseded source ad(s); fetched 6 pages.");
    expect(dependencies.log).not.toHaveBeenCalledWith(expect.stringContaining("No AtHome snapshot"));
    const saved = (await store.readSource("athome"))!;
    expect(saved.provenance).toMatchObject({ mode: "incremental newest-first", pagesFetched: 6, listTemplate: "retained", newListingIds: [] });
    const bytes = await readFile(store.sourcePath("athome"), "utf8"), backups = await readdir(store.backupDir);
    expect(await runAthomeScrape(["--max-pages", "5"], dependencies)).toMatchObject({ replayed: true, added: 0, updated: 0, revision: saved.revision });
    // The replay reports the journaled original effect for the refresh ledger.
    expect(dependencies.log).toHaveBeenLastCalledWith("Next: npm run data:build && npm run enrich && npm run find:new");
    expect(dependencies.log).toHaveBeenCalledWith("Discovered 0 new; refreshed 6 overlaps; retired 0 superseded source ad(s); fetched 6 pages. (already committed; no source change)");
    expect(await readFile(store.sourcePath("athome"), "utf8")).toBe(bytes); expect(await readdir(store.backupDir)).toEqual(backups);
  });

  it("does not count or log an empty non-family page as known, and honors the page budget", async () => {
    await seed(rows([2, 3]));
    dependencies.page = vi.fn(async (meta) => meta.page === 1
      ? capture(cityIndex(meta.city), 1, room(idFor(cityIndex(meta.city), 1), { layout: "1LDK" })) : capture(cityIndex(meta.city), meta.page));
    await runAthomeScrape(["--max-pages", "5"], dependencies);
    expect(dependencies.page).toHaveBeenCalledTimes(9);
    expect(dependencies.log).not.toHaveBeenCalledWith(expect.stringContaining("page 1:"));
    expect(dependencies.sleep).toHaveBeenCalledTimes(3);
    expect((await store.readSource("athome"))!.provenance).toMatchObject({ pagesFetched: 9 });

    await rm(join(root, "sources"), { recursive: true }); await seed([]);
    vi.mocked(dependencies.page).mockClear(); vi.mocked(dependencies.sleep).mockClear();
    await runAthomeScrape(["--deep", "--max-pages", "3"], dependencies);
    expect(dependencies.page).toHaveBeenCalledTimes(9); expect(dependencies.sleep).toHaveBeenCalledTimes(6);
    expect((await store.readSource("athome"))!.provenance).toMatchObject({ mode: "deep newest-first" });
  });

  it("rejects --full before any page or session and still cleans up the browser", async () => {
    const begin = vi.spyOn(client, "beginPortalDiscovery");
    await expect(runAthomeScrape(["--full"], dependencies)).rejects.toThrow("verified per-city exhaustion");
    expect(begin).not.toHaveBeenCalled(); expect(dependencies.page).not.toHaveBeenCalled();
    expect(dependencies.close).toHaveBeenCalledTimes(1); expect(await store.listSources()).toEqual([]);
  });

  it("maps a crawl with no family rooms to the legacy message and leaves storage untouched", async () => {
    dependencies.page = vi.fn(async (meta) => capture(cityIndex(meta.city), meta.page, room(idFor(cityIndex(meta.city), meta.page), { layout: "1K" })));
    await expect(runAthomeScrape(["--max-pages", "1"], dependencies)).rejects.toThrow("AtHome crawl returned no usable rooms; existing source left untouched.");
    expect(await store.listSources()).toEqual([]);
  });

  it.each(["fetch", "parser", "identity"])("retains captures but never commits partial progress after a %s failure", async (failure) => {
    await seed(); const bytes = await readFile(store.sourcePath("athome"), "utf8");
    const write = vi.spyOn(repository, "reconcileSource");
    dependencies.page = vi.fn(async (meta) => {
      if (meta.city === "Koshigaya" && failure === "fetch") throw new Error("fixture network failure");
      const page = capture(cityIndex(meta.city), meta.page);
      if (meta.city === "Koshigaya" && failure === "parser") page.html = '<div class="p-property"><div class="p-property__floor">3LDK</div></div>';
      if (meta.city === "Koshigaya" && failure === "identity") page.page = 10;
      await atomicWriteJson(join(root, "captures", `${meta.city}-${meta.page}.json`), page);
      return page;
    });
    await expect(runAthomeScrape(["--max-pages", "1"], dependencies)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled(); expect(dependencies.close).toHaveBeenCalledTimes(1);
    expect(await readFile(store.sourcePath("athome"), "utf8")).toBe(bytes);
    expect(JSON.parse(await readFile(join(root, "captures", "Soka-1.json"), "utf8"))).toMatchObject({ html: capture(0, 1).html });
  });

  it("does not retry a revision conflict when source state changes during the crawl", async () => {
    await seed(); const originalPage = dependencies.page;
    dependencies.page = async (meta) => {
      if (meta.city === "Soka") {
        const previous = (await store.readSource("athome"))!;
        await store.writeSource({ ...previous, listings: previous.listings.map((listing) => ({ ...listing, rent: 99000 })) }, { expectedRevision: previous.revision! });
      }
      return originalPage(meta);
    };
    const write = vi.spyOn(repository, "reconcileSource"), read = vi.spyOn(repository, "readSource");
    await expect(runAthomeScrape(["--max-pages", "1"], dependencies)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(write).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
    expect((await store.readSource("athome"))!.listings.every((listing) => listing.rent === 99000)).toBe(true);
    expect((await store.readSource("athome"))!.provenance).not.toHaveProperty("ingestionJournal");
  });

  it("retains --force as an explicit shrink-guard override with complete superseded-row archives", async () => {
    const initial = rows([1]);
    const aliases = Array.from({ length: 12 }, (_, index) => ({ ...initial[0], id: `athome-9${index}`, url: `https://www.athome.co.jp/chintai/9${index}/` }));
    await seed([...aliases, ...initial.slice(1)]);
    const bytes = await readFile(store.sourcePath("athome"), "utf8");
    await expect(runAthomeScrape(["--max-pages", "1"], dependencies)).rejects.toBeInstanceOf(ShrinkGuardError);
    expect(await readFile(store.sourcePath("athome"), "utf8")).toBe(bytes);
    expect(await runAthomeScrape(["--max-pages", "1", "--force"], dependencies)).toMatchObject({ retired: 12, currentCount: 3, replayed: false });
    const saved = (await store.readSource("athome"))!;
    expect(saved.archivedListings!.map((entry) => entry.listing)).toEqual(aliases);
    expect(saved.archivedListings!.every((entry) => entry.reason.includes("not evidence of delisting"))).toBe(true);
  });

  it("keeps newer prices over a stale replay and retains historical parking when a template omits it", async () => {
    const [prior] = parseAthomePage(capture(0, 1).html, "Soka");
    await seed([{ ...prior, rent: 80_000, parking: { ...prior.parking!, monthlyYen: 5000 } }], { observedAtByKey: {} });
    const stale = capture(0, 1, room(idFor(0, 1), { rent: "5.0" }), "2026-09-23T00:00:00.000Z");
    const session = await client.beginPortalDiscovery({ source: "athome", deep: true, maxPages: 1, cities: [{ label: "Soka", url: cities[0].url }] });
    session.stagePage(await listCaptureBatch(stale));
    expect(await session.commit()).toMatchObject({ added: 0, updated: 0, ignored: 1 });
    expect((await store.readSource("athome"))!.listings[0].rent).toBe(80_000);

    const later = await client.beginPortalDiscovery({ source: "athome", deep: true, maxPages: 1, cities: [{ label: "Soka", url: cities[0].url }] });
    later.stagePage(await listCaptureBatch(capture(0, 1, room(idFor(0, 1), { rent: "7.0", parking: false }))));
    expect(await later.commit()).toMatchObject({ updated: 1 });
    const [saved] = (await store.readSource("athome"))!.listings;
    expect(saved.rent).toBe(73_000);
    expect(saved.parking).toEqual({ ...prior.parking, monthlyYen: 5000 });
    expect(saved.costs?.parking).toEqual(saved.parking);
  });

  it("updates the same ad in place when only its list URL query changes", async () => {
    const [first, second] = rows([1]);
    const listed = { ...first, url: `${first.url!.split("?")[0]}?DOWN=1&BKLISTID=001&HEYA_NAYOSE_BUKKEN_NO=5` };
    await seed([listed, second]);
    const session = await client.beginPortalDiscovery({ source: "athome", deep: true, maxPages: 1, cities: [{ label: "Soka", url: cities[0].url }] });
    session.stagePage(await listCaptureBatch(capture(0, 1, room(idFor(0, 1), { rent: "7.5" }))));
    expect(await session.commit()).toMatchObject({ updated: 1, retired: 0, currentCount: 2 });
    const saved = (await store.readSource("athome"))!;
    expect(saved.listings.map((listing) => [listing.id, listing.url, listing.rent])).toEqual([[first.id, listed.url, 78_000], [second.id, second.url, second.rent]]);
    expect(saved.archivedListings ?? []).toEqual([]);
  });

  it("does not let an older capture supersede a newer row sharing only a market alias, and never moves evidence backwards", async () => {
    const [prior] = parseAthomePage(capture(0, 1).html, "Soka");
    const sibling = { ...prior, id: "athome-7777", url: "https://www.athome.co.jp/chintai/7777/", name: "別名ハイツ" };
    // The ad's own row is older than the replay; its market-alias sibling is newer.
    await seed([prior, sibling], { observedAtByKey: { [trackingKey(prior)]: "2026-09-23T00:00:00.000Z", [trackingKey(sibling)]: at } });
    const stale = await client.beginPortalDiscovery({ source: "athome", deep: true, maxPages: 1, cities: [{ label: "Soka", url: cities[0].url }] });
    stale.stagePage(await listCaptureBatch(capture(0, 1, room(idFor(0, 1)), oldAt)));
    expect(await stale.commit()).toMatchObject({ added: 0, updated: 0, retired: 0, ignored: 1 });
    expect((await store.readSource("athome"))!.listings).toEqual([prior, sibling]);

    await rm(join(root, "sources"), { recursive: true }); await seed([], {});
    const mixed = await client.beginPortalDiscovery({ source: "athome", deep: true, maxPages: 2, cities: [{ label: "Soka", url: cities[0].url }] });
    mixed.stagePage(await listCaptureBatch(capture(0, 1, room(idFor(0, 1)), at)));
    mixed.stagePage(await listCaptureBatch(capture(0, 2, room(idFor(0, 1)), oldAt))); // older cached copy staged later
    await mixed.commit();
    expect((await store.readSource("athome"))!.provenance!.observedAtByKey).toEqual({ [trackingKey(prior)]: at });
  });

  it("matches the legacy merge for every current AtHome row without rewriting production data", async () => {
    const path = join(DATA_DIR, "sources", "athome.json"), bytes = await readFile(path, "utf8");
    const previous = JSON.parse(bytes) as SourceFile;
    await store.writeSource(previous, { expectedRevision: null });
    const target = previous.listings.find((listing) => /^[2-9]/.test(listing.layout ?? "") && listing.rent > 0)!;
    const { status: _status, firstSeenAt: _first, lastSeenAt: _last, soldAt: _sold, sourceListings: _links, ...fields } = target;
    const fresh = { ...fields, id: "athome-999999999", url: "https://www.athome.co.jp/chintai/999999999/", rent: target.rent + 1000 };
    const priorTimes = Object.values(previous.provenance?.observedAtByKey ?? {}).filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
    const capturedAt = new Date(Math.max(Date.parse(previous.scrapedAt), ...priorTimes.map(Date.parse)) + 1000).toISOString();
    const pageUrl = portalPageUrl("athome", cities[0].url, 1);
    const input: ScrapeBatch = { schemaVersion: 1, source: "athome", scraper: { name: "athome-list", version: "1", parserVersion: "1" },
      runId: "athome-parity", batchId: "parity-1", mode: "discovery", capturedAt, scope: { urls: [pageUrl], cities: ["Soka"], filters: {} },
      observations: [{ sourceListingId: fresh.id, observedAt: capturedAt, evidence: { url: pageUrl, captureId: "fixture" }, listing: fresh }] };
    const result = await client.ingestScrape(input);
    const saved = (await store.readSource("athome"))!;
    const key = (listing: RawListing) => sourceRowKey(sourceRowLocator(listing));
    const current = new Map(saved.listings.map((listing) => [key(listing), listing]));
    const archived = saved.archivedListings!.slice(previous.archivedListings?.length ?? 0);
    const retired = new Map(archived.map((entry) => [key(entry.listing), entry.listing]));
    for (const listing of previous.listings) {
      if (current.has(key(listing))) expect(current.get(key(listing))).toEqual(listing);
      else expect(retired.get(key(listing))).toEqual(listing);
    }
    // Every legacy merge survivor is identical; unseen duplicates the legacy
    // helper compacted implicitly are additionally retained.
    for (const listing of mergeAthomeIncremental(previous.listings, [fresh]).listings) expect(current.get(key(listing))).toEqual(listing);
    expect(saved.listings.length + archived.length).toBe(previous.listings.length + 1);
    expect(result).toMatchObject({ added: 0, updated: 1, retired: archived.length });
    // Retirements are exactly the legacy ones, minus unseen duplicates the new policy retains.
    const legacy = athomeObservationBatch({ previous: previous.listings, current: mergeAthomeIncremental(previous.listings, [fresh]).listings,
      expectedRevision: null, observedAt: capturedAt, observedAtByKey: {}, provenance: {} }).retirements!.map((entry) => entry.id);
    const archivedIds = archived.map((entry) => entry.listing.id);
    expect(archivedIds).toContain(target.id);
    expect(archivedIds.every((id) => legacy.includes(id!))).toBe(true);
    const freshKeys = portalDiscoveryKeys("athome", fresh);
    for (const id of legacy.filter((id) => !archivedIds.includes(id))) {
      const kept = saved.listings.find((listing) => listing.id === id)!;
      expect(portalDiscoveryKeys("athome", kept).some((alias) => freshKeys.includes(alias))).toBe(false);
    }
    expect(await client.ingestScrape(input)).toMatchObject({ replayed: true, revision: saved.revision });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});
