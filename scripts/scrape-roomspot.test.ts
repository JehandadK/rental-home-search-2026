import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, JsonSourceStore, ShrinkGuardError, atomicWriteJson, type SourceFile } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { portalPageUrl } from "../src/data-layer/ingestion/contracts";
import { sourceRowKey, sourceRowLocator } from "../src/data-layer/sourceRowIdentity";
import type { ScrapeBatch } from "../src/data-layer/ingestion/contracts";
import { ROOMSPOT_COLLECTOR, runRoomspotScrape } from "./scrape-roomspot";
import type { PortalCollectorDependencies } from "../src/collectors/shared/portalCollector";
import { listCaptureBatch } from "../src/collectors/shared/listCaptureBatch";
import { parseRoomspotPage } from "../src/collectors/roomspot/roomspot";
import { portalDiscoveryKeys } from "../src/data-layer/ingestion/portalPolicy";
import { trackingKey } from "../src/data-layer/lifecycle";
import type { PageCapture } from "../src/collectors/shared/captureStore";
import type { RawListing } from "../src/domain/types";

const oldAt = "2026-09-24T00:00:00.000Z", at = "2026-09-25T00:00:00.000Z";
const cities = ROOMSPOT_COLLECTOR.cities;
const idFor = (city: number, page: number) => (city + 1) * 1000 + page;
function room(id: number, { rent = "8万5000", layout = "2LDK" } = {}) {
  return `<article class="data"><h2>テストハイツ${id}</h2><table class="spec">
<tr><td class="kokoku-list-data__address">埼玉県草加市谷塚町${id}</td></tr>
<tr><td class="kokoku-list-data__access">東武スカイツリーライン 谷塚駅 徒歩5分</td></tr>
<tr><td class="kokoku-list-data__age">2018年3月</td></tr></table>
<table class="room_data"><tbody><tr><td><a href="https://www.roomspot.net/rent/${id}">テストハイツ 201</a></td>
<td class="kokoku-list-condition__floor">2階</td>
<td class="kokoku-list-condition__price"><strong>${rent}</strong>円<span class="pc">5,000円</span></td>
<td class="kokoku-list-condition__deposit">敷金 1ヶ月 / 礼金 0ヶ月</td>
<td class="kokoku-list-condition__layout">${layout} / 55.2㎡</td></tr></tbody></table></article>`;
}
function capture(city: number, page: number, html = room(idFor(city, page)), capturedAt = at): PageCapture {
  return { schemaVersion: 1, source: "roomspot", city: cities[city].city, page, capturedAt, httpStatus: 200,
    url: portalPageUrl("roomspot", cities[city].url, page), html };
}
const cityIndex = (label: string) => cities.findIndex((city) => city.city === label);
const rows = (pages = [1, 2]) => cities.flatMap((_, city) => pages.flatMap((page) => parseRoomspotPage(capture(city, page).html, cities[city].city)));

describe("RoomSpot collector through staged public ingestion (offline)", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, client: ListingIngestionService, dependencies: PortalCollectorDependencies;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roomspot-collector-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store); client = new ListingIngestionService(repository);
    dependencies = { client, sleep: vi.fn(async () => {}), log: vi.fn(), close: vi.fn(async () => {}), page: vi.fn(async (meta) => {
      const captured = capture(cityIndex(meta.city), meta.page);
      await atomicWriteJson(join(root, "captures", `${meta.city}-${meta.page}.json`), captured);
      return captured;
    }) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const seed = (listings: RawListing[] = rows(), provenance: Record<string, unknown> = { captureRunId: "earlier-native-run", fixture: "retained" }) =>
    store.writeSource({ source: "roomspot", scrapedAt: oldAt, completeSnapshot: false, listings, provenance }, { expectedRevision: null });

  it("keeps the legacy URLs, page sequence, and delay", () => {
    expect(portalPageUrl("roomspot", cities[0].url, 2)).toBe("https://www.roomspot.net/rent/search/area/pref_11/city_221/?address[]=%E5%9F%BC%E7%8E%89%E7%9C%8C%E8%8D%89%E5%8A%A0%E5%B8%82&ftlsflg=1&sort=new_arrival&item_per_page=30&page_num=2");
    expect(ROOMSPOT_COLLECTOR.delayMs).toBe(1000);
  });

  it("bootstraps a missing source with a deep crawl and a single create-only commit", async () => {
    const write = vi.spyOn(repository, "reconcileSource");
    const result = await runRoomspotScrape(["--max-pages", "2"], dependencies);
    expect(dependencies.log).toHaveBeenCalledWith("RoomSpot deep newest-first bootstrap");
    expect(dependencies.page).toHaveBeenCalledTimes(6); expect(write).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ added: 6, updated: 0, retired: 0, previousCount: 0, currentCount: 6 });
    const saved = (await store.readSource("roomspot"))!;
    expect(saved.listings).toEqual(rows());
    expect(saved.provenance).toMatchObject({ mode: "deep newest-first", pagesFetched: 6, newListings: 6, cities: ["Soka", "Koshigaya", "Kawaguchi"],
      capturedBy: "scripts/scrape-roomspot.ts via Pi Control Chrome" });
    expect(saved.provenance).not.toHaveProperty("newListingIds");
    expect(dependencies.log).toHaveBeenCalledWith("\nWrote 6 RoomSpot listings (was 0)");
    expect(dependencies.log).not.toHaveBeenCalledWith(expect.stringContaining("Next:"));
  });

  it("stops after two all-known pages per city, commits once, and replays without rewriting", async () => {
    await seed();
    const read = vi.spyOn(repository, "readSource"), write = vi.spyOn(repository, "reconcileSource");
    const result = await runRoomspotScrape(["--max-pages", "5"], dependencies);
    expect(dependencies.page).toHaveBeenCalledTimes(6);
    expect(read).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ added: 0, updated: 6, retired: 0, currentCount: 6 });
    expect(dependencies.log).toHaveBeenCalledWith("RoomSpot incremental newest-first discovery");
    expect(dependencies.log).toHaveBeenCalledWith("\n=== Soka ===");
    expect(dependencies.log).toHaveBeenCalledWith("  page 1: 1 family rooms (0 new, 1 known, 0 duplicate)");
    expect(dependencies.log).toHaveBeenCalledWith("  stopped: two all-known pages");
    expect(dependencies.log).toHaveBeenCalledWith("Discovered 0 new; refreshed 6 overlaps; retired 0 superseded source ad(s); fetched 6 pages.");
    const saved = (await store.readSource("roomspot"))!;
    // Other provenance is retained, but a direct crawl is not part of an earlier native capture run.
    expect(saved.provenance).toMatchObject({ mode: "incremental newest-first", pagesFetched: 6, fixture: "retained" });
    expect(saved.provenance).not.toHaveProperty("captureRunId");
    const bytes = await readFile(store.sourcePath("roomspot"), "utf8"), backups = await readdir(store.backupDir);
    expect(await runRoomspotScrape(["--max-pages", "5"], dependencies)).toMatchObject({ replayed: true, added: 0, updated: 0, revision: saved.revision });
    expect(await readFile(store.sourcePath("roomspot"), "utf8")).toBe(bytes); expect(await readdir(store.backupDir)).toEqual(backups);
  });

  it("rejects --full before any page or session and maps an empty crawl to the legacy message", async () => {
    const begin = vi.spyOn(client, "beginPortalDiscovery");
    await expect(runRoomspotScrape(["--full"], dependencies)).rejects.toThrow("verified per-city exhaustion");
    expect(begin).not.toHaveBeenCalled(); expect(dependencies.page).not.toHaveBeenCalled(); expect(dependencies.close).toHaveBeenCalledTimes(1);
    dependencies.page = vi.fn(async (meta) => capture(cityIndex(meta.city), meta.page, room(idFor(cityIndex(meta.city), meta.page), { layout: "1K" })));
    await expect(runRoomspotScrape(["--max-pages", "1"], dependencies)).rejects.toThrow("RoomSpot returned no in-scope family listings; source left untouched");
    expect(await store.listSources()).toEqual([]);
  });

  it.each(["fetch", "parser", "identity"])("never commits partial progress after a %s failure", async (failure) => {
    await seed(); const bytes = await readFile(store.sourcePath("roomspot"), "utf8");
    const write = vi.spyOn(repository, "reconcileSource");
    dependencies.page = vi.fn(async (meta) => {
      if (meta.city === "Koshigaya" && failure === "fetch") throw new Error("fixture network failure");
      const page = capture(cityIndex(meta.city), meta.page);
      if (meta.city === "Koshigaya" && failure === "parser") page.html = '<div class="kokoku-list-condition__layout">3LDK</div>';
      if (meta.city === "Koshigaya" && failure === "identity") page.url = portalPageUrl("roomspot", cities[0].url, meta.page);
      return page;
    });
    await expect(runRoomspotScrape(["--max-pages", "1"], dependencies)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled(); expect(dependencies.close).toHaveBeenCalledTimes(1);
    expect(await readFile(store.sourcePath("roomspot"), "utf8")).toBe(bytes);
  });

  it("retains --force as an explicit shrink-guard override with complete superseded-row archives", async () => {
    const initial = rows([1]);
    const aliases = Array.from({ length: 12 }, (_, index) => ({ ...initial[0], id: `roomspot-9${index}`, url: `https://www.roomspot.net/rent/9${index}` }));
    await seed([...aliases, ...initial.slice(1)]);
    await expect(runRoomspotScrape(["--max-pages", "1"], dependencies)).rejects.toBeInstanceOf(ShrinkGuardError);
    expect(await runRoomspotScrape(["--max-pages", "1", "--force"], dependencies)).toMatchObject({ retired: 12, currentCount: 3 });
    expect((await store.readSource("roomspot"))!.archivedListings!.map((entry) => entry.listing)).toEqual(aliases);
  });

  it("retains nested details a list page does not publish and rejects stale price replays", async () => {
    const [prior] = parseRoomspotPage(capture(0, 1).html, "Soka");
    await seed([{ ...prior, rent: 95_000, costs: { ...prior.costs, cleaningFeeYen: 30_000 }, building: { ...prior.building, conditions: ["ペット相談"] },
      tenancy: { leaseType: "regular" } }], {});
    const begin = () => client.beginPortalDiscovery({ source: "roomspot", deep: true, maxPages: 1, cities: [{ label: "Soka", url: cities[0].url }] });
    const stale = await begin();
    stale.stagePage(await listCaptureBatch(capture(0, 1, room(idFor(0, 1), { rent: "7万" }), "2026-09-23T00:00:00.000Z")));
    expect(await stale.commit()).toMatchObject({ updated: 0, ignored: 1 });
    expect((await store.readSource("roomspot"))!.listings[0].rent).toBe(95_000);
    const fresh = await begin();
    fresh.stagePage(await listCaptureBatch(capture(0, 1, room(idFor(0, 1), { rent: "8万" }))));
    expect(await fresh.commit()).toMatchObject({ updated: 1 });
    const [saved] = (await store.readSource("roomspot"))!.listings;
    expect(saved).toMatchObject({ rent: 85_000, costs: { adminFeeYen: 5000, depositYen: 80_000, cleaningFeeYen: 30_000 },
      building: { floor: "2階", conditions: ["ペット相談"] }, tenancy: { leaseType: "regular" } });
  });

  it("updates a current RoomSpot ad in place and supersedes only its alias duplicates, without rewriting production data", async () => {
    const path = join(DATA_DIR, "sources", "roomspot.json"), bytes = await readFile(path, "utf8");
    const previous = JSON.parse(bytes) as SourceFile;
    await store.writeSource(previous, { expectedRevision: null });
    // Prefer an ad with a stored alias duplicate (today's data has many), so supersession beyond the ad
    // itself is exercised; the synthetic --force tests cover that case independently of the data.
    const shared = new Map<string, number>();
    for (const listing of previous.listings) shared.set(trackingKey(listing), (shared.get(trackingKey(listing)) ?? 0) + 1);
    const family = previous.listings.filter((listing) => /^[2-9]/.test(listing.layout ?? "") && listing.rent > 0);
    const target = family.find((listing) => shared.get(trackingKey(listing))! > 1) ?? family[0];
    const { status: _status, firstSeenAt: _first, lastSeenAt: _last, soldAt: _sold, sourceListings: _links, ...fields } = target;
    // A same-ID observation that adds no nested fields, so the stored row only changes rent.
    const fresh = { ...fields, rent: target.rent + 1000 };
    const priorTimes = Object.values(previous.provenance?.observedAtByKey ?? {}).filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
    const capturedAt = new Date(Math.max(Date.parse(previous.scrapedAt), ...priorTimes.map(Date.parse)) + 1000).toISOString();
    const pageUrl = portalPageUrl("roomspot", cities[0].url, 1);
    const input: ScrapeBatch = { schemaVersion: 1, source: "roomspot", scraper: { name: "roomspot-list", version: "1", parserVersion: "1" },
      runId: "roomspot-parity", batchId: "parity-1", mode: "discovery", capturedAt, scope: { urls: [pageUrl], cities: ["Soka"], filters: {} },
      observations: [{ sourceListingId: fresh.id!, observedAt: capturedAt, evidence: { url: pageUrl, captureId: "fixture" }, listing: fresh }] };
    const result = await client.ingestScrape(input);
    const saved = (await store.readSource("roomspot"))!;
    const key = (listing: RawListing) => sourceRowKey(sourceRowLocator(listing));
    const current = new Map(saved.listings.map((listing) => [key(listing), listing]));
    const archived = saved.archivedListings!.slice(previous.archivedListings?.length ?? 0);
    const retired = new Map(archived.map((entry) => [key(entry.listing), entry.listing]));
    for (const listing of previous.listings) {
      if (key(listing) === key(target)) continue;
      if (current.has(key(listing))) expect(current.get(key(listing))).toEqual(listing);
      else expect(retired.get(key(listing))).toEqual(listing);
    }
    // The ad keeps its stored row and position; another row is superseded exactly when it shares
    // a discovery alias with the observation, and every other row, unseen duplicates included, survives.
    const freshKeys = portalDiscoveryKeys("roomspot", fresh);
    const absorbed = (listing: RawListing) => key(listing) !== key(target) && portalDiscoveryKeys("roomspot", listing).some((alias) => freshKeys.includes(alias));
    expect(archived.map((entry) => key(entry.listing))).toEqual(previous.listings.filter(absorbed).map(key));
    expect(saved.listings.map(key)).toEqual(previous.listings.filter((listing) => !absorbed(listing)).map(key));
    expect(current.get(key(target))).toEqual({ ...target, rent: target.rent + 1000 });
    expect(result).toMatchObject({ added: 0, updated: 1, retired: archived.length, currentCount: saved.listings.length });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});
