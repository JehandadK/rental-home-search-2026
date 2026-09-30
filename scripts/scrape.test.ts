import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSourceStore, ShrinkGuardError, atomicWriteJson } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { RevisionConflictError } from "../src/data-layer/errors";
import { runSuumoScrape, parsePage, suumoCaptureBatch, type SuumoScrapeDependencies } from "./scrape";
import type { PageCapture } from "../src/collectors/shared/captureStore";
import type { RawListing } from "../src/domain/types";

const oldAt = "2026-09-24T00:00:00.000Z", at = "2026-09-25T00:00:00.000Z";
const layoutCodes = ["05", "06", "07", "08", "09", "10", "11", "12", "13", "14"];
const cities = [{ code: "sc_soka", label: "Soka" }, { code: "sc_koshigaya", label: "Koshigaya" }, { code: "sc_kawaguchi", label: "Kawaguchi" }];
function html(city: string, bc: number, rent = "8") {
  return `<div class="cassetteitem"><div class="cassetteitem_content-title">${city} rental</div><div class="cassetteitem_detail-col1">埼玉県${city}町</div>
    <div class="cassetteitem_detail-col2"><div class="cassetteitem_detail-text">東武線/草加駅 歩15分</div></div>
    <div class="cassetteitem_detail-col3"><div>築10年</div></div><table class="cassetteitem_other"><tbody><tr class="js-cassette_link">
    <td></td><td></td><td>2階</td><td><span class="cassetteitem_price--rent">${rent}万円</span><span class="cassetteitem_price--administration">4000円</span></td>
    <td><span class="cassetteitem_price--deposit">8万円</span><span class="cassetteitem_price--gratuity">-</span></td>
    <td><span class="cassetteitem_madori">3LDK</span><span class="cassetteitem_menseki">70m2</span></td><td><a href="/chintai/jnc_${bc}/?bc=${bc}">detail</a></td>
    </tr></tbody></table></div>`;
}
function capture(city = cities[0], page = 1, rent = "8"): PageCapture {
  return { schemaVersion: 1, source: "suumo", city: city.label, page, capturedAt: at, httpStatus: 200,
    url: `https://suumo.jp/chintai/saitama/${city.code}/?${layoutCodes.map((code) => `md=${code}`).join("&")}&po1=09${page > 1 ? `&page=${page}` : ""}`,
    html: html(city.label, (cities.findIndex((entry) => entry.label === city.label) + 1) * 100 + page, rent) };
}
const rows = () => cities.map((city) => ({ ...parsePage(capture(city).html, 2026)[0], city: city.label }));

describe("SUUMO collector through staged public ingestion (offline)", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, client: ListingIngestionService, dependencies: SuumoScrapeDependencies;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "suumo-collector-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store); client = new ListingIngestionService(repository);
    dependencies = { client, sleep: vi.fn(async () => {}), log: vi.fn(), page: vi.fn(async (meta) => {
      const captured = capture(cities.find((city) => city.label === meta.city)!, meta.page);
      await atomicWriteJson(join(root, "captures", `${meta.city}-${meta.page}.json`), captured);
      return captured;
    }) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const seed = (listings: RawListing[] = rows()) => store.writeSource({ source: "suumo", scrapedAt: oldAt, completeSnapshot: false,
    listings, provenance: { fixture: "retained" } }, { expectedRevision: null });

  it("stops after two all-known pages per city, preserves log counters, and commits only once", async () => {
    await seed();
    const read = vi.spyOn(repository, "readSource"), write = vi.spyOn(repository, "reconcileSource");
    const result = await runSuumoScrape(["--max-pages", "5"], dependencies);
    expect(dependencies.page).toHaveBeenCalledTimes(6);
    expect(read).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ added: 0, updated: 3, retired: 0, currentCount: 3 });
    expect(dependencies.log).toHaveBeenCalledWith("  page 1: 1 properties (0 new, 1 known, 0 duplicate)");
    expect(dependencies.log).toHaveBeenCalledWith("  page 2: 1 properties (0 new, 0 known, 1 duplicate)");
    expect(dependencies.log).toHaveBeenCalledWith("  stopped: 2 consecutive pages were entirely known");
    expect(dependencies.log).toHaveBeenCalledWith("Discovered 0 new; refreshed 3 overlapping; retired 0 superseded source ad(s); fetched 6 pages.");
    const saved = (await store.readSource("suumo"))!;
    expect(saved.scrapedAt).toBe(at); expect(saved.completeSnapshot).toBe(false);
    expect(saved.provenance).toMatchObject({ capturedBy: "scripts/scrape.ts", mode: "incremental newest-first", pagesFetched: 6, fixture: "retained",
      cities: cities.map((city) => `${city.label} (${city.code}, emergency ceiling 5p)`), layoutCodes: layoutCodes.join(",") });
    const bytes = await readFile(store.sourcePath("suumo"), "utf8"), backups = await readdir(store.backupDir);
    vi.mocked(dependencies.log).mockClear();
    expect(await runSuumoScrape(["--max-pages", "5"], dependencies)).toMatchObject({ replayed: true, added: 0, updated: 0, revision: saved.revision });
    // The replay logs the journaled original counts, not zeros, and says nothing changed.
    expect(dependencies.log).toHaveBeenCalledWith("Discovered 0 new; refreshed 3 overlapping; retired 0 superseded source ad(s); fetched 6 pages. (already committed; no source change)");
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes); expect(await readdir(store.backupDir)).toEqual(backups);
  });

  it("honors deep/page budgets without interpreting the window as complete", async () => {
    await seed();
    expect(await runSuumoScrape(["--deep", "--max-pages", "3"], dependencies)).toMatchObject({ currentCount: 3 });
    expect(dependencies.page).toHaveBeenCalledTimes(9);
    expect(dependencies.log).not.toHaveBeenCalledWith("  stopped: 2 consecutive pages were entirely known");
    expect(dependencies.sleep).toHaveBeenCalledTimes(9);
    expect((await store.readSource("suumo"))!.provenance).toMatchObject({ mode: "deep newest-first", pagesFetched: 9 });
    expect((await store.readSource("suumo"))!.completeSnapshot).toBe(false);
  });

  it("computes novelty/deduplication in the application, not in the parser adapter", async () => {
    await seed([]);
    const result = await runSuumoScrape(["--max-pages", "5"], dependencies);
    expect(dependencies.page).toHaveBeenCalledTimes(9);
    expect(result).toMatchObject({ added: 3, updated: 0, currentCount: 3 });
    expect(dependencies.log).toHaveBeenCalledWith("  page 1: 1 properties (1 new, 0 known, 0 duplicate)");
    const input = capture(); input.html += input.html;
    expect((await suumoCaptureBatch(input)).observations).toHaveLength(2); // raw duplicates cross the public boundary
  });

  it("rejects --full and a missing source before requesting any page", async () => {
    const begin = vi.spyOn(client, "beginSuumoDiscovery");
    await expect(runSuumoScrape(["--full"], dependencies)).rejects.toThrow("verified per-city exhaustion");
    expect(begin).not.toHaveBeenCalled();
    await expect(runSuumoScrape([], dependencies)).rejects.toThrow("data:migrate");
    expect(dependencies.page).not.toHaveBeenCalled(); expect(await store.listSources()).toEqual([]);
  });

  it.each(["fetch", "parser", "identity"])("retains captures but never commits partial source progress after a %s failure", async (failure) => {
    await seed(); const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    const write = vi.spyOn(repository, "reconcileSource");
    dependencies.page = vi.fn(async (meta) => {
      if (meta.city === "Koshigaya" && failure === "fetch") throw new Error("fixture network failure");
      const page = capture(cities.find((city) => city.label === meta.city)!, meta.page);
      if (meta.city === "Koshigaya" && failure === "parser") page.html = '<div class="cassetteitem">broken family card</div>';
      if (meta.city === "Koshigaya" && failure === "identity") page.page = 10;
      await atomicWriteJson(join(root, "captures", `${meta.city}-${meta.page}.json`), page);
      return page;
    });
    await expect(runSuumoScrape(["--max-pages", "1"], dependencies)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled(); expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(JSON.parse(await readFile(join(root, "captures", "Soka-1.json"), "utf8"))).toMatchObject({ html: capture().html });
  });

  it("rejects incomplete sessions and closes a session after invalid page metadata", async () => {
    await seed(); const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    const options = { cities: [cities[0]], deep: false, maxPages: 2, layoutCodes };
    const session = await client.beginSuumoDiscovery(options);
    session.stagePage(await suumoCaptureBatch(capture()));
    await expect(session.commit()).rejects.toThrow("Incomplete bounded");
    const invalid = await client.beginSuumoDiscovery(options);
    const page = await suumoCaptureBatch(capture()); page.scraper.parserVersion = "2";
    expect(() => invalid.stagePage(page)).toThrow("parserVersion");
    await expect(invalid.commit()).rejects.toThrow("closed");
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
  });

  it("commits a completed session only once and refuses additional pages", async () => {
    await seed(); const write = vi.spyOn(repository, "reconcileSource");
    const options = { cities: [cities[0]], deep: false, maxPages: 1, layoutCodes };
    const session = await client.beginSuumoDiscovery(options);
    options.maxPages = 5; // caller mutation cannot change the application's scope
    expect(session.stagePage(await suumoCaptureBatch(capture())).stopReason).toBe("page-limit");
    const first = session.commit(), repeated = session.commit();
    expect(repeated).toBe(first);
    await first;
    expect(write).toHaveBeenCalledTimes(1);
    expect(() => session.stagePage({} as never)).toThrow("closed");
  });

  it("rejects out-of-order or wrong-query pages without publishing a source checkpoint", async () => {
    await seed(); const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    const options = { cities: [cities[0]], deep: false, maxPages: 2, layoutCodes };
    for (const page of [capture(cities[0], 2), { ...capture(), url: capture().url.replace("po1=09", "po1=01") }]) {
      const session = await client.beginSuumoDiscovery(options);
      const input = await suumoCaptureBatch(page);
      expect(() => session.stagePage(input)).toThrow("sequence/scope/time");
      await expect(session.commit()).rejects.toThrow("closed");
    }
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
  });

  it("does not retry a revision conflict when source state changes during the crawl", async () => {
    await seed(); const originalPage = dependencies.page;
    dependencies.page = async (meta) => {
      if (meta.city === "Soka") {
        const previous = (await store.readSource("suumo"))!;
        await store.writeSource({ ...previous, listings: previous.listings.map((listing) => ({ ...listing, rent: 99000 })) }, { expectedRevision: previous.revision! });
      }
      return originalPage(meta);
    };
    const write = vi.spyOn(repository, "reconcileSource"), read = vi.spyOn(repository, "readSource");
    await expect(runSuumoScrape(["--max-pages", "1"], dependencies)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(write).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
    expect((await store.readSource("suumo"))!.listings.every((listing) => listing.rent === 99000)).toBe(true);
    expect((await store.readSource("suumo"))!.provenance).not.toHaveProperty("ingestionJournal");
  });

  it("retains --force as an explicit shrink-guard override with complete superseded-row archives", async () => {
    const initial = rows();
    const aliases = Array.from({ length: 12 }, (_, index) => ({ ...initial[0], id: `old-${index}`, url: `https://suumo.jp/chintai/jnc_${index}/?bc=${index}` }));
    await seed([...aliases, ...initial.slice(1)]);
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    await expect(runSuumoScrape(["--max-pages", "1"], dependencies)).rejects.toBeInstanceOf(ShrinkGuardError);
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(await runSuumoScrape(["--max-pages", "1", "--force"], dependencies)).toMatchObject({ retired: 12, currentCount: 3, replayed: false });
    expect((await store.readSource("suumo"))!.archivedListings!.map((entry) => entry.listing)).toEqual(aliases);
  });

  it("uses original capture year/time and ignores optional spool hashes for replay identity", async () => {
    const original = { ...capture(), capturedAt: "2025-09-25T00:00:00.000Z" };
    const fresh = await suumoCaptureBatch(original), cached = await suumoCaptureBatch({ ...original, sha256: "optional spool checksum" });
    expect(cached).toEqual(fresh);
    expect(fresh.observations[0]).toMatchObject({ observedAt: original.capturedAt, sourceListingId: expect.stringContaining("bc=101"), listing: { builtYear: 2015 } });
  });
});
