import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../../src/types";
import { RevisionConflictError } from "../../src/data-layer/errors";
import { ListingIngestionService } from "../../src/data-layer/ingestion/service";
import type { PageCapture } from "./captureStore";
import { JsonSourceStore } from "./dataStore";
import { JsonListingRepository } from "./jsonListingRepository";
import { trackingKey } from "./lifecycle";
import { mergeNiftyIncremental, parseNiftyPage } from "./nifty";
import { ingestNiftyListPage } from "./niftyIngestion";

const html = `<div><header>
  <h2>家の賃貸物件</h2><p>埼玉県草加市1丁目</p>
  <li data-transport-access>新田駅 歩7分</li>
  <dl><dt>築年数</dt><dd>築10年</dd></dl>
  <span class="badge is-outline">駐車場あり</span>
</header><table class="result-bukken-table"><tbody class="click-area">
  <tr><td></td><td></td><td>2階</td><td><p>2LDK</p><p>50.5㎡</p></td>
    <td class="bukken-info-rent"><p>8万円</p><p>5,000円</p></td>
    <td><dl><dt>敷</dt><dd>不要</dd></dl><dl><dt>礼</dt><dd>1ヶ月</dd></dl></td></tr>
  <tr><td><a href="/rent/saitama/sokashi_ct/detail_aabbcc/">詳細</a></td></tr>
</tbody></table></div>`;
const capturedAt = "2026-09-25T00:00:00.000Z";
const priorAt = "2026-09-24T00:00:00.000Z";
const capture: PageCapture = {
  schemaVersion: 1, source: "nifty", city: "Soka", page: 1,
  url: "https://myhome.nifty.com/rent/saitama/sokashi_ct/?sort=regDate-desc",
  capturedAt, httpStatus: 200, html,
};
const byId = (rows: readonly RawListing[]) => [...rows].sort((a, b) => a.id!.localeCompare(b.id!));

describe("Nifty list-page ingestion", () => {
  let root: string;
  let store: JsonSourceStore;
  let repository: JsonListingRepository;
  let service: ListingIngestionService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nifty-ingestion-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(store);
    service = new ListingIngestionService(repository);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("matches the legacy merge and provenance, preserving unseen rows/details and archiving superseded IDs", async () => {
    const [row] = parseNiftyPage(html, "Soka", 2026);
    const prior = { ...row, rent: 90000, parking: { ...row.parking!, monthlyYen: 6000 },
      costs: { ...row.costs, cleaningFeeYen: 40000 }, tenancy: { leaseType: "regular" as const },
      building: { ...row.building, features: ["都市ガス"] }, sourceDetails: { custom: "retained detail" } };
    const duplicate = { ...row, id: "nifty-old-ad", url: "https://myhome.nifty.com/rent/detail_0011/" };
    const unseen = { ...row, id: "nifty-unseen", name: "Unseen", address: "埼玉県川口市1丁目", city: "Kawaguchi",
      status: "sold" as const, soldAt: priorAt, lastSeenAt: priorAt };
    const previous = [prior, duplicate, unseen];
    const priorTimes = { [trackingKey(prior)]: priorAt, [trackingKey(unseen)]: priorAt };
    const provenance = { capturedBy: "previous collector", custom: "retained provenance", observedAtByKey: priorTimes };
    const seed = { source: "nifty", scrapedAt: priorAt, completeSnapshot: true, provenance,
      listings: previous, futureMetadata: { preserve: true } };
    await store.writeSource(seed, { expectedRevision: null });
    const originalBytes = await readFile(store.sourcePath("nifty"), "utf8");
    await store.writeSource({ source: "yahoo", scrapedAt: priorAt, listings: [{ ...row, source: "yahoo" }] }, { expectedRevision: null });
    const otherBytes = await readFile(store.sourcePath("yahoo"), "utf8");
    // User state and canonical outputs are not owned by source ingestion.
    const userPath = join(root, "user.json"), canonicalPath = join(root, "listings_raw.json");
    await writeFile(userPath, JSON.stringify({ marks: { "nifty-aabbcc": "favorite" }, customListings: [row] }));
    await writeFile(canonicalPath, JSON.stringify(previous));
    const userBytes = await readFile(userPath, "utf8"), canonicalBytes = await readFile(canonicalPath, "utf8");

    const secondCard = html.replace("detail_aabbcc", "detail_ddeeff").replace("家の", "別の家の").replace("1丁目", "2丁目");
    const page = { ...capture, html: html + secondCard };
    const parsed = parseNiftyPage(page.html, page.city, 2026);
    const merged = mergeNiftyIncremental(previous, parsed);
    const ingest = vi.spyOn(repository, "ingest");
    const submit = vi.spyOn(service, "ingestScrape");
    const result = await ingestNiftyListPage(service, page);
    expect(submit.mock.calls[0][0]).toMatchObject({
      scraper: { name: "nifty-list", version: "1", parserVersion: "1" },
      mode: "discovery", observations: parsed.map((listing) => expect.objectContaining({ listing })),
    });
    expect(submit.mock.calls[0][0].observations).toHaveLength(2); // not merged history
    expect(submit.mock.calls[0][0]).not.toHaveProperty("expectedRevision");
    const saved = (await store.readSource("nifty"))!;

    expect(result).toMatchObject({ parsedCount: 2, novel: 1, added: merged.added, updated: merged.updated, ingestion: { retired: 1 } });
    // The repository retains stable storage order; identity/values must match the old writer.
    expect(byId(saved.listings)).toEqual(byId(merged.listings));
    expect(saved.listings.find((listing) => listing.id === row.id)).toMatchObject({
      rent: 85000, parking: { monthlyYen: 6000 }, costs: { cleaningFeeYen: 40000 },
      tenancy: { leaseType: "regular" }, building: { features: ["都市ガス", "駐車場あり"] },
    });
    expect(saved.listings).toContainEqual(unseen);
    expect(saved).toMatchObject({ source: "nifty", count: 3, scrapedAt: capturedAt, completeSnapshot: false, futureMetadata: { preserve: true } });
    const { ingestionJournal, ...savedProvenance } = saved.provenance!;
    expect(ingestionJournal).toBeDefined();
    expect(savedProvenance).toEqual({
      ...provenance, mode: "verified newest-first list discovery", capturedBy: "scripts/crawl-nifty.ts",
      observedTrackingKeys: parsed.map(trackingKey),
      observedAtByKey: { ...priorTimes, ...Object.fromEntries(parsed.map((listing) => [trackingKey(listing), capturedAt])) },
    });
    expect(saved.archivedListings).toEqual([{
      sourceListingId: duplicate.id, listing: duplicate, retiredAt: capturedAt,
      reason: expect.stringContaining("matching source aliases"),
    }]);
    expect(ingest.mock.calls[0][0]).toMatchObject({ completeness: "incremental", observations: expect.arrayContaining([
      expect.objectContaining({ sourceListingId: unseen.id, observedAt: priorAt }),
    ]) });
    const backups = await readdir(store.backupDir);
    expect(backups).toHaveLength(1);
    expect(await readFile(join(store.backupDir, backups[0]), "utf8")).toBe(originalBytes);
    expect(await readFile(store.sourcePath("yahoo"), "utf8")).toBe(otherBytes);
    expect(await readFile(userPath, "utf8")).toBe(userBytes);
    expect(await readFile(canonicalPath, "utf8")).toBe(canonicalBytes);

    const replay = await ingestNiftyListPage(service, page);
    expect(replay).toMatchObject({ novel: 0, added: 0, ingestion: { replayed: true, retired: 0, revision: saved.revision } });
    expect((await store.readSource("nifty"))!.archivedListings).toEqual(saved.archivedListings);
    expect(await readdir(store.backupDir)).toEqual(backups);
  });

  it("bootstraps and replays the same capture without changing the revision or adding a backup", async () => {
    const first = await ingestNiftyListPage(service, capture);
    const bytes = await readFile(store.sourcePath("nifty"), "utf8");
    expect(first).toMatchObject({ parsedCount: 1, novel: 1, added: 1, ingestion: { replayed: false } });
    const replay = await ingestNiftyListPage(service, { ...capture, sha256: "optional-spool-checksum" });
    expect(replay).toMatchObject({ parsedCount: 1, novel: 0, added: 0,
      ingestion: { replayed: true, retired: 0, revision: first.ingestion.revision } });
    expect(await readFile(store.sourcePath("nifty"), "utf8")).toBe(bytes);
    await expect(readdir(store.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["failed HTTP response", { httpStatus: 403 }],
    ["unrecognized page", { html: "<h1>Human verification</h1>" }],
    ["malformed family card", { html: html.replace("8万円", "unknown") }],
    ["invalid capture time", { capturedAt: "invalid" }],
    ["wrong source", { source: "suumo" as const }],
  ])("retains the last page checkpoint after a %s", async (_, changes) => {
    await ingestNiftyListPage(service, capture);
    const checkpoint = await readFile(store.sourcePath("nifty"), "utf8");
    const ingest = vi.spyOn(repository, "ingest");
    await expect(ingestNiftyListPage(service, { ...capture, page: 2, ...changes })).rejects.toThrow();
    expect(ingest).not.toHaveBeenCalled();
    expect(await readFile(store.sourcePath("nifty"), "utf8")).toBe(checkpoint);
    await expect(readdir(store.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never treats a page without family layouts as a complete snapshot or all-known page", async () => {
    await ingestNiftyListPage(service, capture);
    const previous = (await repository.readSource("nifty"))!;
    const result = await ingestNiftyListPage(service, {
      ...capture, page: 2, capturedAt: "2026-09-25T00:01:00.000Z", html: html.replace("2LDK", "1K"),
    });
    expect(result).toMatchObject({ parsedCount: 0, novel: 0, added: 0, ingestion: { retired: 0 } });
    expect(await repository.readSource("nifty")).toMatchObject({
      listings: previous.listings, archivedListings: [], completeSnapshot: false,
      provenance: { observedTrackingKeys: [], observedAtByKey: previous.provenance!.observedAtByKey },
    });
  });

  it("does not let a previously unseen older cached page roll back newer price evidence", async () => {
    await ingestNiftyListPage(service, capture);
    const newerAt = "2026-09-25T01:00:00.000Z";
    await ingestNiftyListPage(service, { ...capture, capturedAt: newerAt, html: html.replace("8万円", "9万円") });
    const older = await ingestNiftyListPage(service, { ...capture, capturedAt: priorAt, html: html.replace("8万円", "7万円") });
    expect(older).toMatchObject({ added: 0, updated: 0, ingestion: { ignored: 1, retired: 0 } });
    const saved = (await repository.readSource("nifty"))!;
    expect(saved.scrapedAt).toBe(newerAt);
    expect(saved.listings[0].rent).toBe(95000);
    expect(saved.provenance!.observedAtByKey).toEqual({ [trackingKey(saved.listings[0])]: newerAt });
  });

  it("surfaces a stale revision without retrying or overwriting the winning writer", async () => {
    await ingestNiftyListPage(service, capture);
    const realIngest = repository.ingest.bind(repository);
    const ingest = vi.spyOn(repository, "ingest").mockImplementationOnce(async (batch) => {
      await realIngest({ ...batch, observations: batch.observations.map((observation) => ({
        ...observation, listing: { ...observation.listing, rent: 99000 },
      })) });
      return realIngest(batch);
    });
    await expect(ingestNiftyListPage(service, { ...capture, capturedAt: "2026-09-25T00:01:00.000Z" })).rejects.toBeInstanceOf(RevisionConflictError);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect((await repository.readSource("nifty"))!.listings[0].rent).toBe(99000);
  });
});
