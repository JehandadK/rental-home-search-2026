import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../../domain/types";
import { ListingIngestionService } from "../../data-layer/ingestion/service";
import { JsonListingRepository } from "../../storage/json/jsonListingRepository";
import { atomicWriteJson, JsonSourceStore } from "../../storage/json/dataStore";
import { captureKey } from "../shared/captureStore";
import { runDetailEnrichment, type DetailEnrichmentDependencies } from "./detailEnrichmentRunner";

const now = "2026-09-25T00:00:00.000Z", capturedAt = "2026-09-24T00:00:00.000Z";
const html = '<table><tr><th>駐車場</th><td>敷地内6600円</td></tr><tr><th>契約期間</th><td>普通借家2年</td></tr></table><ul class="inline_list"><li>都市ガス</li></ul>';
const row = (id: string): RawListing => ({ id, source: "suumo", name: id, address: `埼玉県草加市${id}`,
  rent: 80000, sizeM2: 50, layout: "2LDK", builtYear: 2010, stationWalkMin: 5, url: `https://suumo.jp/chintai/${id}/` });

describe("detail enrichment collector (offline)", () => {
  let root: string, store: JsonSourceStore, client: ListingIngestionService, dependencies: DetailEnrichmentDependencies;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const pathFor = (url: string) => join(root, ".captures", "details", captureKey("suumo", url) + ".json");
  const queuePath = () => join(root, "detail-queue.json");
  const queue = async () => JSON.parse(await readFile(queuePath(), "utf8")) as { url: string; queuedAt: string; checkedAt?: string; retryAfter?: string; error?: string }[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "detail-collector-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    client = new ListingIngestionService(new JsonListingRepository(store));
    fetchMock = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected network request in offline test"); });
    dependencies = { dataDir: root, client, fetch: fetchMock, now: () => new Date(now), sleep: vi.fn(async () => {}) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const seed = async (rows = [row("one")]) => store.writeSource({ source: "suumo", scrapedAt: now, completeSnapshot: false, listings: rows,
    provenance: { mode: "list crawl", observedTrackingKeys: [], observedAtByKey: {} } }, { expectedRevision: null });
  const cache = async (url = row("one").url!, body = html, at = capturedAt) => atomicWriteJson(pathFor(url), { url, html: body, capturedAt: at });

  it("replays cached HTML with zero requests and submits only captured fields and original timestamps", async () => {
    await seed(); await cache();
    const submit = vi.spyOn(client, "ingestScrape");
    expect(await runDetailEnrichment(["--replay", "--limit", "0"], dependencies)).toEqual({ requests: 0, limit: 0, reused: 1, applied: 1, failed: 0, queued: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(submit.mock.calls[0][0]).toMatchObject({ observationKind: "detail-patch", observations: [{ observedAt: capturedAt, details: { parking: { monthlyYen: 6600 } } }] });
    expect(submit.mock.calls[0][0].observations[0]).not.toHaveProperty("listing");
    expect(await queue()).toEqual([{ url: row("one").url, queuedAt: now, checkedAt: capturedAt }]);
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    expect(await runDetailEnrichment(["--replay", "--force"], dependencies)).toMatchObject({ requests: 0, reused: 1, applied: 0 });
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds requests and keeps deferred URLs available for later runs", async () => {
    const rows = [row("a"), row("b"), row("c")]; await seed(rows);
    fetchMock.mockResolvedValue(new Response(html));
    expect(await runDetailEnrichment(["--limit", "1"], dependencies)).toMatchObject({ requests: 1, reused: 0, applied: 1, queued: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue()).toEqual(rows.map((listing, index) => ({ url: listing.url, queuedAt: now, ...(index === 0 ? { checkedAt: now } : {}) })));
    expect(dependencies.sleep).toHaveBeenCalledWith(2000);
    expect(JSON.parse(await readFile(pathFor(rows[0].url!), "utf8"))).toMatchObject({ html, capturedAt: now });
  });

  it("retains a valid capture/checkpoint when a later response trips the circuit breaker", async () => {
    const rows = [row("a"), row("b"), row("c")]; await seed(rows);
    fetchMock.mockResolvedValueOnce(new Response(html)).mockResolvedValueOnce(new Response("throttled", { status: 429 }));
    expect(await runDetailEnrichment(["--limit", "10"], dependencies)).toMatchObject({ requests: 2, applied: 1, failed: 1, queued: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const savedQueue = await queue();
    expect(savedQueue[0].checkedAt).toBe(now);
    expect(savedQueue[1]).toMatchObject({ error: "HTTP 429", retryAfter: "2026-09-25T01:00:00.000Z" });
    expect(savedQueue[2].checkedAt).toBeUndefined();
    expect((await store.readSource("suumo"))!.listings).toEqual([
      expect.objectContaining({ id: "a", parking: { available: true, monthlyYen: 6600, location: "onsite", distanceM: null, raw: "敷地内6600円" } }), rows[1], rows[2],
    ]);
  });

  it("does not spool verification HTML or claim successful observations", async () => {
    await seed(); const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    fetchMock.mockResolvedValueOnce(new Response("<h1>Human verification</h1>"));
    expect(await runDetailEnrichment([], dependencies)).toMatchObject({ requests: 1, applied: 0, failed: 1 });
    await expect(readFile(pathFor(row("one").url!))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await queue())[0]).toMatchObject({ error: expect.stringContaining("Unrecognized"), retryAfter: "2026-09-25T01:00:00.000Z" });
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
  });

  it("keeps retry backoff, except when explicitly forced; forced replay still never fetches", async () => {
    await seed();
    await atomicWriteJson(queuePath(), [{ url: row("one").url, queuedAt: capturedAt, retryAfter: "2026-09-25T01:00:00.000Z", error: "HTTP 503" }]);
    expect(await runDetailEnrichment([], dependencies)).toMatchObject({ requests: 0, applied: 0 });
    expect(await runDetailEnrichment(["--replay", "--force"], dependencies)).toMatchObject({ requests: 0, applied: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(html));
    expect(await runDetailEnrichment(["--force"], dependencies)).toMatchObject({ requests: 1, applied: 1 });
    expect((await queue())[0]).toEqual({ url: row("one").url, queuedAt: capturedAt, checkedAt: now });
  });

  it("refreshes stale cache normally but allows explicit offline replay with its original timestamp", async () => {
    await seed(); await cache(row("one").url!, '<table><tr><th>駐車場</th><td>敷地内6600円</td></tr></table>', "2026-09-01T00:00:00.000Z");
    expect(await runDetailEnrichment(["--replay"], dependencies)).toMatchObject({ requests: 0, applied: 1 });
    expect((await queue())[0].checkedAt).toBe("2026-09-01T00:00:00.000Z");
    fetchMock.mockResolvedValueOnce(new Response(html.replace("6600", "7700")));
    expect(await runDetailEnrichment([], dependencies)).toMatchObject({ requests: 1, applied: 1 });
    expect((await store.readSource("suumo"))!.listings[0].parking!.monthlyYen).toBe(7700);
  });

  it.each([
    ["wrong cached identity", { url: "https://suumo.jp/chintai/other/" }],
    ["invalid cached timestamp", { capturedAt: "unknown" }],
    ["invalid cached markup", { html: "<h1>Human verification</h1>" }],
  ])("fails safely on %s without overwriting source rows", async (_, changes) => {
    await seed(); const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    await atomicWriteJson(pathFor(row("one").url!), { url: row("one").url, html, capturedAt, ...changes });
    await expect(runDetailEnrichment(["--replay"], dependencies)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect((await queue())[0].checkedAt).toBeUndefined();
  });

  it("retains parsed progress/cache on commit failure and can replay it without fetching", async () => {
    await seed(); await cache();
    const bytes = await readFile(store.sourcePath("suumo"), "utf8");
    vi.spyOn(store, "writeSource").mockRejectedValueOnce(new Error("commit failed"));
    await expect(runDetailEnrichment(["--replay"], dependencies)).rejects.toThrow("commit failed");
    expect(await readFile(store.sourcePath("suumo"), "utf8")).toBe(bytes);
    expect((await queue())[0].checkedAt).toBe(capturedAt); // fetched/parsed, not a source-commit receipt
    expect(await runDetailEnrichment(["--replay"], dependencies)).toMatchObject({ requests: 0, applied: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not overwrite source changes made between URL selection and detail submission", async () => {
    await seed();
    fetchMock.mockImplementationOnce(async () => {
      const previous = (await store.readSource("suumo"))!;
      await store.writeSource({ ...previous, listings: [{ ...previous.listings[0], rent: 99000 }, row("unseen")] }, { expectedRevision: previous.revision! });
      return new Response(html);
    });
    await runDetailEnrichment(["--limit", "1"], dependencies);
    expect((await store.readSource("suumo"))!.listings).toEqual([
      expect.objectContaining({ id: "one", rent: 99000, parking: expect.objectContaining({ monthlyYen: 6600 }) }), row("unseen"),
    ]);
  });

  it("preserves CLI guards and selection gates without starting network work", async () => {
    await seed();
    await expect(runDetailEnrichment(["--all-missing"], dependencies)).rejects.toThrow("retired");
    await expect(runDetailEnrichment(["--limit", "-1"], dependencies)).rejects.toThrow();
    expect(await runDetailEnrichment(["--max-rent", "70000", "--min-size", "60"], dependencies)).toMatchObject({ requests: 0, queued: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
