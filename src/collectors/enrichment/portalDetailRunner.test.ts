import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../../domain/types";
import { ListingIngestionService } from "../../data-layer/ingestion/service";
import { JsonListingRepository } from "../../storage/json/jsonListingRepository";
import { JsonSourceStore } from "../../storage/json/dataStore";
import { trackingKey } from "../../domain/listingIdentity";
import { portalDetailCapturePath, portalDetailQueuePath, runPortalDetails, type PortalDetailDependencies } from "./portalDetailRunner";
import { classifyPortalDetailPage, portalDetailBatch, type PortalDetailCapture, type PortalDetailPage } from "./portalDetailIngestion";

const now = "2026-10-08T00:00:00.000Z", listedAt = "2026-10-01T00:00:00.000Z";
// 広告主情報 as RoomSpot printed it on 2026-10-08 (trimmed).
const realtor = `<div class="kokoku-detail-realtor spec spec_detail"><h2>ドルフクレセント八番館の広告主情報</h2>
<table class="spec_table_default col4"><tbody>
<tr><th class="kokoku-detail-realtor__name">店舗名称</th><td class="kokoku-detail-realtor__name"> 株式会社中央ビル管理 北千住営業所 </td>
<th class="kokoku-detail-realtor__staff">担当者</th><td class="kokoku-detail-realtor__staff"> </td></tr>
<tr><th class="kokoku-detail-realtor__address">事務所の所在地</th><td class="kokoku-detail-realtor__address"> 東京都足立区千住２丁目22マスミビル1階 </td>
<th class="kokoku-detail-realtor__tel">電話番号</th><td class="kokoku-detail-realtor__tel"><a href="tel:0120956776">0120-956-776</a></td></tr>
<tr><th class="kokoku-detail-realtor__license">宅建免許番号</th><td class="kokoku-detail-realtor__license"> 国土交通大臣（9）第3918号 </td>
<th class="kokoku-detail-realtor__code">不動産会社コード</th><td class="kokoku-detail-realtor__code"> 2003962 </td></tr>
</tbody></table></div>`;
// 掲載不動産会社 as AtHome printed it on 2026-10-08 (trimmed).
const company = `<div class="company-info-area" id="section5"><h2 class="company-info-area__title">掲載不動産会社</h2>
<div class="head__name post-title__left"><a href="/ahto/a-nishikasai.html">アエラス西葛西店 (株)アエラス</a></div>
<table class="company-info-area__inner-list info"><tbody>
<tr><th>所在地</th><td colspan="3"> 〒134-0088 東京都江戸川区西葛西６丁目８－１０ 朝日生命西葛西ビル ７階 </td></tr>
<tr class="item"><th>免許番号</th><td class="item">国土交通大臣免許（３）第８５２２号</td><th>TEL/FAX</th><td>03-6456-0315 ／<br>03-6456-0316</td></tr>
</tbody></table></div>`;
const page = (url: string, body = realtor, changes: Partial<PortalDetailPage> = {}): PortalDetailPage =>
  ({ status: 200, url, title: "ドルフクレセント八番館 201｜ルームスポット", html: `<html><head><title>x</title></head><body><main>${body}</main></body></html>`, ...changes });
const row = (id: string, changes: Partial<RawListing> = {}): RawListing => ({ id: `roomspot-${id}`, source: "roomspot", name: `ハイツ${id}`,
  address: `東京都足立区千住${id}`, rent: 90000, sizeM2: 50, layout: "2LDK", builtYear: 2015, stationWalkMin: 6,
  url: `https://www.roomspot.net/rent/${id}`, ...changes });
const urlOf = (id: string) => row(id).url!;

describe("AtHome / RoomSpot detail loading (offline)", () => {
  let root: string, sources: JsonSourceStore, client: ListingIngestionService, dependencies: PortalDetailDependencies;
  let load: ReturnType<typeof vi.fn<(url: string) => Promise<PortalDetailPage>>>;
  let clock: Date;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "portal-detail-runner-"));
    sources = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    client = new ListingIngestionService(new JsonListingRepository(sources));
    load = vi.fn(async () => { throw new Error("Unexpected page request in offline test"); });
    clock = new Date(now);
    dependencies = { source: "roomspot", dataDir: root, client, loader: { load, close: vi.fn(async () => {}) },
      now: () => clock, sleep: vi.fn(async () => {}) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const seed = (rows = [row("1"), row("2"), row("3")], source = "roomspot") => sources.writeSource({ source, scrapedAt: listedAt,
    completeSnapshot: false, listings: rows, provenance: { observedAtByKey: {} } }, { expectedRevision: null });
  const queue = async (source = "roomspot") => JSON.parse(await readFile(portalDetailQueuePath(root, source as "roomspot"), "utf8"));
  const stored = async () => new Map((await sources.readSource("roomspot"))!.listings.map((listing) => [listing.url, listing]));

  it("reads at most --limit pages, caches them, and adds each ad's store", async () => {
    await seed();
    load.mockImplementation(async (url) => page(url));
    const result = await runPortalDetails(["--limit", "2"], dependencies);
    expect(result).toMatchObject({ source: "roomspot", requests: 2, limit: 2, reused: 0, applied: 2, failed: 0, queued: 3, ended: [] });
    expect(load.mock.calls.map(([url]) => url)).toEqual([urlOf("1"), urlOf("2")]);
    expect(dependencies.sleep).toHaveBeenCalledWith(3000);
    const rows = await stored();
    expect(rows.get(urlOf("1"))).toMatchObject({ agency: "株式会社中央ビル管理 北千住営業所",
      agencyInfo: { brand: "中央ビル管理", branch: "北千住営業所", city: "足立区", phone: "0120-956-776", licence: "国土交通大臣(9)第3918号" } });
    expect(rows.get(urlOf("3"))).toEqual(row("3"));
    const capture = JSON.parse(await readFile(portalDetailCapturePath(root, "roomspot", urlOf("1")), "utf8")) as PortalDetailCapture;
    expect(capture).toMatchObject({ schemaVersion: 1, source: "roomspot", url: urlOf("1"), capturedAt: now });
    expect((await queue()).items).toEqual([
      { url: urlOf("1"), queuedAt: now, checkedAt: now }, { url: urlOf("2"), queuedAt: now, checkedAt: now }, { url: urlOf("3"), queuedAt: now },
    ]);
  });

  it("replays cached captures with zero requests, deterministically", async () => {
    await seed();
    load.mockImplementation(async (url) => page(url));
    await runPortalDetails(["--limit", "1"], dependencies);
    const bytes = await readFile(sources.sourcePath("roomspot"), "utf8");
    load.mockReset();
    // Planned again with --force; the cached page is replayed, never re-requested.
    expect(await runPortalDetails(["--replay", "--force"], dependencies)).toMatchObject({ requests: 0, reused: 1, applied: 0 });
    expect(load).not.toHaveBeenCalled();
    expect(await readFile(sources.sourcePath("roomspot"), "utf8")).toBe(bytes);
    const capture = JSON.parse(await readFile(portalDetailCapturePath(root, "roomspot", urlOf("1")), "utf8")) as PortalDetailCapture;
    expect(await portalDetailBatch("roomspot", [capture])).toEqual(await portalDetailBatch("roomspot", [capture]));
  });

  it("stops every request at a verification page and pauses the source", async () => {
    await seed();
    load.mockResolvedValueOnce(page(urlOf("1"))).mockImplementationOnce(async (url) => page(url, "<p>確認中</p>", { title: "認証が必要です" }));
    const result = await runPortalDetails(["--limit", "10"], dependencies);
    expect(result).toMatchObject({ requests: 2, applied: 1, failed: 1, blocked: { until: "2026-10-08T01:00:00.000Z" } });
    expect(load).toHaveBeenCalledTimes(2);
    const saved = await queue();
    expect(saved).toMatchObject({ blockedUntil: "2026-10-08T01:00:00.000Z", trips: 1 });
    expect(saved.items[1]).toMatchObject({ error: expect.stringContaining("verification"), attempts: 1 });
    // Nothing was cached for the verification page.
    await expect(readFile(portalDetailCapturePath(root, "roomspot", urlOf("2")), "utf8")).rejects.toThrow();

    // While paused, a run makes no requests although two ads still lack a store.
    expect(await runPortalDetails(["--limit", "10"], dependencies)).toMatchObject({ requests: 0, blocked: { reason: expect.stringContaining("earlier run") } });
    expect(load).toHaveBeenCalledTimes(2);
    // After the pause, a repeat block doubles it.
    clock = new Date("2026-10-08T02:00:00.000Z");
    load.mockImplementation(async (url) => page(url, "", { status: 429 }));
    expect(await runPortalDetails(["--limit", "10", "--force"], dependencies)).toMatchObject({ requests: 1, blocked: { reason: "blocked: HTTP 429", until: "2026-10-08T04:00:00.000Z" } });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("treats a page without the store block as unrecognised: never cached, and the breaker trips", async () => {
    await seed();
    load.mockImplementation(async (url) => page(url, "<div class=\"kokoku-detail\">no store here</div>"));
    expect(await runPortalDetails(["--limit", "10"], dependencies)).toMatchObject({ requests: 1, applied: 0, failed: 1, blocked: {} });
    await expect(readFile(portalDetailCapturePath(root, "roomspot", urlOf("1")), "utf8")).rejects.toThrow();
    expect((await stored()).get(urlOf("1"))).toEqual(row("1"));
  });

  it("reports an ended ad with its evidence, keeps going, and waits a week before looking again", async () => {
    await seed([row("1"), row("2")]);
    load.mockResolvedValueOnce(page(urlOf("1"), "<p>この物件は掲載終了しました</p>", { status: 404, title: "掲載終了" }))
      .mockImplementationOnce(async (url) => page(url));
    const result = await runPortalDetails(["--limit", "10"], dependencies);
    expect(result).toMatchObject({ requests: 2, applied: 1, failed: 0, ended: [{ url: urlOf("1"), checkedAt: now, evidence: "HTTP 404 · 掲載終了" }] });
    expect(result.blocked).toBeUndefined();
    expect((await queue()).items[0]).toMatchObject({ retryAfter: "2026-10-15T00:00:00.000Z" });
    // The ended ad waits; the other now has its store and is not planned again.
    load.mockReset();
    expect(await runPortalDetails(["--limit", "10"], dependencies)).toMatchObject({ requests: 0, reused: 0, applied: 0 });
    expect(load).not.toHaveBeenCalled();
  });

  it("backs off a page that failed to load, and stops after repeated load errors", async () => {
    await seed();
    load.mockRejectedValue(new Error("Browser request timed out: navigate"));
    expect(await runPortalDetails(["--limit", "10"], dependencies)).toMatchObject({ requests: 2, failed: 2, blocked: { reason: expect.stringContaining("repeated load errors") } });
    expect((await queue()).items[0]).toMatchObject({ attempts: 1, retryAfter: "2026-10-08T01:00:00.000Z", error: "Browser request timed out: navigate" });
  });

  it("never saves the previous ad's document under the next ad's URL", async () => {
    await seed([row("1"), row("2")]);
    // The tab still shows ad 1 when ad 2 is read: ad 1's store must not become ad 2's.
    load.mockResolvedValueOnce(page(urlOf("1"))).mockResolvedValueOnce(page(urlOf("1")));
    expect(await runPortalDetails(["--limit", "10"], dependencies)).toMatchObject({ requests: 2, applied: 1, failed: 1, blocked: { reason: expect.stringContaining("not the requested ad") } });
    expect((await stored()).get(urlOf("2"))).toEqual(row("2"));
    await expect(readFile(portalDetailCapturePath(root, "roomspot", urlOf("2")), "utf8")).rejects.toThrow();
  });

  it("records ended ads before submitting stores, so a failed submission keeps the evidence", async () => {
    await seed([row("1"), row("2")]);
    load.mockResolvedValueOnce(page(urlOf("1"), "", { status: 404, title: "掲載終了" })).mockImplementationOnce(async (url) => page(url));
    const onEnded = vi.fn(async () => {});
    vi.spyOn(client, "ingestScrape").mockRejectedValueOnce(new Error("revision conflict"));
    await expect(runPortalDetails(["--limit", "10"], { ...dependencies, onEnded })).rejects.toThrow("revision conflict");
    expect(onEnded).toHaveBeenCalledWith("roomspot", [{ url: urlOf("1"), checkedAt: now, evidence: "HTTP 404 · 掲載終了" }]);
  });

  it("works the most recently seen ads first, keeps backoff under --force, and drops ads that gained a store", async () => {
    await sources.writeSource({ source: "roomspot", scrapedAt: listedAt, completeSnapshot: false, listings: [row("1"), row("2")],
      provenance: { observedAtByKey: { [trackingKey(row("2"))]: now } } }, { expectedRevision: null });
    load.mockRejectedValueOnce(new Error("Browser request timed out: navigate")).mockImplementationOnce(async (url) => page(url));
    expect(await runPortalDetails(["--limit", "10"], dependencies)).toMatchObject({ requests: 2, applied: 1, failed: 1 });
    expect(load.mock.calls.map(([url]) => url)).toEqual([urlOf("2"), urlOf("1")]);
    expect((await queue()).items.map((item: { url: string }) => item.url)).toEqual([urlOf("2"), urlOf("1")]);
    load.mockReset();
    expect(await runPortalDetails(["--limit", "10", "--force"], dependencies)).toMatchObject({ requests: 0, reused: 1 });
    expect(load).not.toHaveBeenCalled();
    clock = new Date("2026-10-08T02:00:00.000Z");
    expect(await runPortalDetails(["--limit", "0"], dependencies)).toMatchObject({ queued: 1 });
    expect((await queue()).items.map((item: { url: string }) => item.url)).toEqual([urlOf("2")]);
  });

  it("records ended ads even when a later item stops the run", async () => {
    await seed([row("1"), row("2")]);
    load.mockResolvedValueOnce(page(urlOf("1"), "", { status: 404, title: "掲載終了" }));
    const onEnded = vi.fn(async () => {});
    await mkdir(join(root, ".captures", "details"), { recursive: true });
    await writeFile(portalDetailCapturePath(root, "roomspot", urlOf("2")), JSON.stringify({ schemaVersion: 1, source: "roomspot", url: urlOf("2"), capturedAt: now, html: "x", sha256: "bad" }));
    await expect(runPortalDetails(["--limit", "10"], { ...dependencies, onEnded })).rejects.toThrow("checksum");
    expect(onEnded).toHaveBeenCalledWith("roomspot", [expect.objectContaining({ url: urlOf("1") })]);
  });

  it("re-reads nothing outside the portal it was asked for", async () => {
    await seed([row("1")]);
    await writeFile(portalDetailQueuePath(root, "roomspot"), JSON.stringify({ schemaVersion: 1, source: "athome", items: [] }));
    await expect(runPortalDetails([], dependencies)).rejects.toThrow("Invalid roomspot detail queue");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads AtHome pages the same way", async () => {
    const ad = row("1", { id: "athome-1126499429", source: "athome", url: "https://www.athome.co.jp/chintai/1126499429/" });
    await seed([ad], "athome");
    load.mockImplementation(async (url) => page(url, company, { title: "アエラス西葛西 賃貸 | アットホーム" }));
    expect(await runPortalDetails(["--limit", "10"], { ...dependencies, source: "athome" })).toMatchObject({ requests: 1, applied: 1 });
    expect(dependencies.sleep).toHaveBeenCalledWith(4000);
    expect((await sources.readSource("athome"))!.listings[0]).toMatchObject({ agency: "アエラス西葛西店 (株)アエラス",
      agencyInfo: { brand: "アエラス", company: "株式会社アエラス", branch: "西葛西店", city: "江戸川区" } });
  });
});

describe("classifyPortalDetailPage", () => {
  const url = "https://www.athome.co.jp/chintai/1126499429/";
  it.each([
    ["detail", page(url, company, { title: "アットホーム" })],
    ["verification", page(url, "<p>…</p>", { title: "認証 | アットホーム" })],
    ["blocked", page(url, company, { status: 403 })],
    ["ended", page(url, "<p>…</p>", { status: 404, title: "お探しのページが見つかりません" })],
    ["ended", page("https://www.athome.co.jp/chintai/", "<p>…</p>", { title: "賃貸 | アットホーム" })],
    ["unrecognized", page(url, "<p>…</p>", { title: "アットホーム" })],
    ["unrecognized", page(url, company, { status: 500, title: "エラー" })],
  ] as const)("%s", (kind, loaded) => {
    expect(classifyPortalDetailPage("athome", loaded, url).kind).toBe(kind);
  });

  it("does not read 掲載終了 on a live RoomSpot ad page as the ad having ended", () => {
    const live = page("https://www.roomspot.net/rent/1", `${realtor}<p>掲載終了予定日 2026/10/31</p>`);
    expect(classifyPortalDetailPage("roomspot", live, "https://www.roomspot.net/rent/1").kind).toBe("detail");
    expect(classifyPortalDetailPage("roomspot", page("https://www.roomspot.net/rent/1", "<p>掲載終了</p>"), "https://www.roomspot.net/rent/1").kind).toBe("ended");
    // A page still loading its store block is not an ended ad because it shows its end date.
    expect(classifyPortalDetailPage("roomspot", page("https://www.roomspot.net/rent/1", "<p>掲載終了予定日 2026/10/31</p>"), "https://www.roomspot.net/rent/1").kind).toBe("unrecognized");
  });

  it("does not take another ad's document for the requested one, even a gone one", () => {
    const stale = page("https://www.athome.co.jp/chintai/2/", "<p>…</p>", { status: 404, title: "お探しのページが見つかりません" });
    expect(classifyPortalDetailPage("athome", stale, url).kind).toBe("unrecognized");
    expect(classifyPortalDetailPage("athome", page("https://www.athome.co.jp/chintai/1/", company), url).kind).toBe("unrecognized");
  });
});
