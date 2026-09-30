import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSourceStore, atomicWriteJson } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { portalPageUrl } from "../src/data-layer/ingestion/portalDiscovery";
import { runCaptureImport, type CaptureImportDependencies } from "./import-capture";
import { parseAthomePage } from "../src/collectors/athome/athome";
import type { PageCapture } from "../src/collectors/shared/captureStore";
import type { RefreshLedger, RefreshRunRecord } from "./lib/refreshLedger";

const at = "2026-09-25T00:00:00.000Z";
const cityUrls: Record<string, string> = { Soka: "soka-city", Koshigaya: "koshigaya-city", Kawaguchi: "kawaguchi-city" };
function athomeRoom(id: number, rent = "6.9") {
  return `<div class="p-property"><h2 class="p-property__title--building">テストハイツ${id} 2階建</h2>
<dl><dt><i title="所在地"></i></dt><dd><strong>草加市氷川町${id}</strong></dd></dl>
<dl><dt><i title="交通"></i></dt><dd>東武伊勢崎線 「草加」駅 徒歩8分</dd></dl>
<dl><dt><i title="家"></i></dt><dd>賃貸アパート<br>2階建<br>1991年8月 (築35年)</dd></dl>
<div class="p-property__room--detailbox" data-bukken-no="${id}">
 <div class="p-property__information-price"><b class="p-property__information-rent">${rent}</b>万円<span>3,000円</span></div>
 <div class="p-property__room-keymoney"><p>1.5ヶ月</p><span>なし</span></div>
 <div class="p-property__room-floorplan"><div class="p-property__floor">2DK</div><span>39.79m²</span></div>
 <a href="/chintai/${id}/?DOWN=1">詳細を見る</a>
</div></div>`;
}
function roomspotRoom(id: number) {
  return `<article class="data"><h2>ルームハイツ${id}</h2><table class="spec">
<tr><td class="kokoku-list-data__address">埼玉県越谷市蒲生${id}</td></tr>
<tr><td class="kokoku-list-data__access">東武スカイツリーライン 蒲生駅 徒歩5分</td></tr>
<tr><td class="kokoku-list-data__age">2018年3月</td></tr></table>
<table class="room_data"><tbody><tr><td><a href="https://www.roomspot.net/rent/${id}">ルームハイツ 201</a></td>
<td class="kokoku-list-condition__floor">2階</td>
<td class="kokoku-list-condition__price"><strong>8万5000</strong>円<span class="pc">5,000円</span></td>
<td class="kokoku-list-condition__deposit">敷金 1ヶ月 / 礼金 0ヶ月</td>
<td class="kokoku-list-condition__layout">2LDK / 55.2㎡</td></tr></tbody></table></article>`;
}
function suumoCard(bc: number) {
  return `<div class="cassetteitem"><div class="cassetteitem_content-title">Kawaguchi rental ${bc}</div><div class="cassetteitem_detail-col1">埼玉県川口市${bc}</div>
    <div class="cassetteitem_detail-col2"><div class="cassetteitem_detail-text">JR/川口駅 歩15分</div></div>
    <div class="cassetteitem_detail-col3"><div>築10年</div></div><table class="cassetteitem_other"><tbody><tr class="js-cassette_link">
    <td></td><td></td><td>2階</td><td><span class="cassetteitem_price--rent">8万円</span><span class="cassetteitem_price--administration">4000円</span></td>
    <td><span class="cassetteitem_price--deposit">8万円</span><span class="cassetteitem_price--gratuity">-</span></td>
    <td><span class="cassetteitem_madori">3LDK</span><span class="cassetteitem_menseki">70m2</span></td><td><a href="/chintai/jnc_${bc}/?bc=${bc}">detail</a></td>
    </tr></tbody></table></div>`;
}
const athome = (city: string, page: number, html = athomeRoom(page * 10 + Object.keys(cityUrls).indexOf(city)), capturedAt = at): PageCapture & { sortedNewest?: boolean } => ({
  schemaVersion: 1, source: "athome", city, page, capturedAt, httpStatus: 200, sortedNewest: true,
  url: portalPageUrl("athome", `https://www.athome.co.jp/chintai/saitama/${cityUrls[city]}/list/`, page), html });
const roomspot = (page: number): PageCapture => ({ schemaVersion: 1, source: "roomspot", city: "Koshigaya", page, capturedAt: at, httpStatus: 200,
  url: `https://www.roomspot.net/rent/search/area/pref_11/city_222/?sort=new_arrival&page_num=${page}`, html: roomspotRoom(500 + page) });
const suumo = (page: number): PageCapture => ({ schemaVersion: 1, source: "suumo", city: "Kawaguchi", page, capturedAt: at, httpStatus: 200,
  url: `https://suumo.jp/chintai/saitama/sc_kawaguchi/?po1=09&page=${page}`, html: suumoCard(700 + page) });
const receipt = (c: PageCapture) => createHash("sha256").update(c.url + c.capturedAt + c.html).digest("hex");

function run(id = "run-1"): RefreshRunRecord {
  const stage = (stageId: string, status: RefreshRunRecord["stages"][number]["status"] = "pending") => ({ id: stageId, label: stageId, status, attempts: [] });
  return { schemaVersion: 1, id, startedAt: at, updatedAt: at, status: "partial", mode: "incremental", skipNifty: false, invocations: [], beforeTotal: 0,
    stages: [stage("athome"), stage("roomspot"), stage("detail-enrich", "success"), stage("data-build", "success"), stage("enrich", "success"), stage("find-new", "success")] };
}

describe("native capture import through the public ingestion boundary (offline)", () => {
  let root: string, store: JsonSourceStore, repository: JsonListingRepository, service: ListingIngestionService;
  let ledger: RefreshLedger, dependencies: CaptureImportDependencies, released: number;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "capture-import-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store); service = new ListingIngestionService(repository);
    ledger = { schemaVersion: 1, runs: [] }; released = 0;
    dependencies = { ingestion: service, captureDir: join(root, "captures"), saveCapture: vi.fn(async () => "saved"),
      acquireLock: vi.fn(async () => async () => { released++; }), readLedger: async () => structuredClone(ledger),
      saveRun: vi.fn(async (saved) => { ledger.runs = ledger.runs.map((entry) => entry.id === saved.id ? structuredClone(saved) : entry); }),
      writeProgress: vi.fn(atomicWriteJson), log: vi.fn(), error: vi.fn() };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const exportFile = async (captures: PageCapture[], errors?: string[]) => {
    const path = join(root, `export-${Math.random()}.json`);
    await writeFile(path, JSON.stringify({ captures, ...(errors ? { errors } : {}) })); return path;
  };
  const progress = async (id: string) => JSON.parse(await readFile(join(root, "captures", `progress-${id}.json`), "utf8"));

  it("imports mixed sources per page, never reads/merges in the CLI, and annotates each source with the run summary", async () => {
    ledger.runs = [run()];
    const pages = [athome("Soka", 1), athome("Soka", 2), roomspot(1), suumo(1)];
    const reconcile = vi.spyOn(repository, "reconcileSource");
    expect(await runCaptureImport(["--file", await exportFile(pages)], dependencies)).toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(4); expect(dependencies.saveCapture).toHaveBeenCalledTimes(4);
    expect(dependencies.writeProgress).toHaveBeenCalledTimes(4); expect(released).toBe(1);
    expect(dependencies.log).toHaveBeenCalledWith("athome/Soka p1: 1 family rows; 1 added; 0 refreshed; continue");
    expect(dependencies.log).toHaveBeenCalledWith("suumo/Kawaguchi p1: 1 family rows; 1 added; 0 refreshed; continue");
    const saved = (await store.readSource("athome"))!;
    expect(saved.listings.map((listing) => listing.id)).toEqual(["athome-10", "athome-20"]);
    expect(saved.provenance).toMatchObject({ mode: "bounded native-browser discovery", capturedBy: "scripts/import-capture.ts (native browser export)",
      pagesFetched: 2, newListings: 2, cities: ["Soka"], captureRunId: "run-1" });
    expect(saved.provenance).not.toHaveProperty("newListingIds");
    expect((await store.readSource("suumo"))!.provenance).toMatchObject({ pagesFetched: 1, newListings: 1, cities: ["Kawaguchi"], captureRunId: "run-1" });
    expect((await store.readSource("suumo"))!.provenance).not.toHaveProperty("newListingIds");
    expect(await progress("run-1")).toMatchObject({ imported: pages.map(receipt),
      cities: { "athome/Soka": { pages: 2, knownPages: 0, added: 2, done: false }, "roomspot/Koshigaya": { pages: 1, added: 1 } } });
  });

  it("skips already imported receipts (including legacy progress files) and enforces page order", async () => {
    const legacy = athome("Soka", 1);
    await atomicWriteJson(join(root, "captures", "progress-2026-09-25.json"),
      { imported: [receipt(legacy)], cities: { "athome/Soka": { pages: 1, knownPages: 0, added: 1, updatedAt: at, done: false } } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at));
    try {
      await runCaptureImport(["--file", await exportFile([legacy, athome("Soka", 2)])], dependencies);
      expect(dependencies.log).toHaveBeenCalledWith("athome/Soka p1: already imported");
      expect(await progress("2026-09-25")).toMatchObject({ cities: { "athome/Soka": { pages: 2, added: 2 } } });
      await expect(runCaptureImport(["--file", await exportFile([athome("Soka", 4)])], dependencies)).rejects.toThrow("expected page 3, got 4");
    } finally { vi.useRealTimers(); }
    expect(released).toBe(2);
    await expect(runCaptureImport(["--file", await exportFile([]), "--run-id", "missing"], dependencies)).rejects.toThrow("Unknown run ID");
    await expect(runCaptureImport(["--file", await exportFile([{ ...athome("Soka", 1), city: "Tokyo" }])], dependencies)).rejects.toThrow("Unknown city");
    expect(released).toBe(4);
  });

  it("persists each validated page before a later page fails", async () => {
    ledger.runs = [run()];
    const broken = { ...athome("Soka", 2), html: '<div class="p-property"><div class="p-property__floor">3LDK</div></div>' };
    await expect(runCaptureImport(["--file", await exportFile([athome("Soka", 1), broken])], dependencies)).rejects.toThrow("none parsed");
    expect((await store.readSource("athome"))!.listings).toHaveLength(1);
    expect(await progress("run-1")).toMatchObject({ cities: { "athome/Soka": { pages: 1, added: 1 } } });
    expect(released).toBe(1);
  });

  it("repairs progress from journaled effects after a source commit whose progress write failed", async () => {
    ledger.runs = [run()];
    const file = await exportFile([athome("Soka", 1)]);
    vi.mocked(dependencies.writeProgress).mockRejectedValueOnce(new Error("disk full"));
    await expect(runCaptureImport(["--file", file], dependencies)).rejects.toThrow("disk full");
    const committed = (await store.readSource("athome"))!;
    expect(committed.listings).toHaveLength(1);
    const reconcile = vi.spyOn(repository, "reconcileSource");
    expect(await runCaptureImport(["--file", file], dependencies)).toBe(0);
    expect(reconcile).not.toHaveBeenCalled(); // replayed, not reapplied
    expect(await progress("run-1")).toMatchObject({ cities: { "athome/Soka": { pages: 1, added: 1 } } });
    const saved = (await store.readSource("athome"))!;
    expect(saved.listings).toEqual(committed.listings);
    expect((saved.provenance!.ingestionJournal as { batches: unknown[] }).batches).toHaveLength(1);
    expect(saved.provenance).toMatchObject({ newListings: 1, pagesFetched: 1 });
    expect(dependencies.log).toHaveBeenCalledWith("athome/Soka p1: 1 family rows; 1 added; 0 refreshed; continue");
  });

  it("filters stale captures, keeps empty non-family pages, and stops after two known newest-first pages", async () => {
    const [prior] = parseAthomePage(athome("Soka", 1).html, "Soka");
    await store.writeSource({ source: "athome", scrapedAt: at, completeSnapshot: false, listings: [{ ...prior, rent: 90_000 }], provenance: {} }, { expectedRevision: null });
    const stale = athome("Soka", 1, athomeRoom(10, "5.0"), "2026-09-20T00:00:00.000Z");
    const empty = { ...athome("Soka", 2), html: athomeRoom(99).replace(">2DK<", ">1K<") };
    const known = athome("Soka", 3, athomeRoom(10, "9.0"));
    const again = athome("Soka", 4, athomeRoom(10, "9.0"));
    await runCaptureImport(["--file", await exportFile([stale, empty, known, again])], dependencies);
    expect(dependencies.log).toHaveBeenCalledWith("athome/Soka p1: 0 family rows; 0 added; 0 refreshed; continue");
    expect(dependencies.log).toHaveBeenCalledWith("athome/Soka p2: 0 family rows; 0 added; 0 refreshed; continue");
    expect(dependencies.log).toHaveBeenCalledWith("athome/Soka p4: 1 family rows; 0 added; 1 refreshed; STOP (overlap/budget; not complete market)");
    expect((await store.readSource("athome"))!.listings).toEqual([expect.objectContaining({ id: "athome-10", rent: 93_000 })]);
  });

  it("completes finished ledger stages, invalidates downstream work, and reports export errors with exit code 2", async () => {
    ledger.runs = [run()];
    const pages = ["Soka", "Koshigaya", "Kawaguchi"].map((city) => athome(city, 1));
    expect(await runCaptureImport(["--file", await exportFile(pages, ["roomspot/Soka blocked"]), "--max-pages", "1"], dependencies)).toBe(2);
    expect(dependencies.error).toHaveBeenCalledWith("Capture failed: roomspot/Soka blocked");
    const [saved] = ledger.runs;
    const status = Object.fromEntries(saved.stages.map((stage) => [stage.id, stage.status]));
    expect(status).toEqual({ athome: "success", roomspot: "pending", "detail-enrich": "pending", "data-build": "pending", enrich: "pending", "find-new": "success" });
    expect(saved.stages[0]).toMatchObject({ discovered: 3, exitCode: 0, detail: expect.stringContaining("no removal claims"), attempts: [expect.objectContaining({ status: "success", discovered: 3 })] });
    expect((await store.readSource("athome"))!.provenance).toMatchObject({ cities: ["Soka", "Koshigaya", "Kawaguchi"], pagesFetched: 3, newListings: 3 });
  });
});
