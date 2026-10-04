import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../src/domain/types";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { DATA_DIR, JsonSourceStore, ShrinkGuardError, type SourceFile } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { mergeNiftyIncremental, niftyMatchKeys } from "../src/data-layer/ingestion/niftyPolicy";
import { trackingKey } from "../src/data-layer/lifecycle";
import { NIFTY_DETAIL_PARSER_VERSION, prepareNiftyDetailImport, toRawListing, type NiftyDetail, type NiftyDump } from "./merge-nifty";

const before = "2026-09-24T00:00:00.000Z", now = "2026-09-25T00:00:00.000Z";
function detail(id = "aabbcc", changes: Partial<NiftyDetail> = {}): NiftyDetail {
  return { url: `https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_${id}/`, capturedAt: now,
    httpStatus: 200, h1: "House 新田駅より徒歩7分",
    kv: { "所在地": "埼玉県草加市1丁目", "賃料": "8万円＋ 管理費等5000円", "間取り": "2LDK（専有面積：50.5㎡）",
      "築年月": "2010年1月", "交通機関": "新田駅 歩7分", "敷金/礼金": "無 / 無", "階数/階建": "2階/3階建", "設備": "都市ガス" }, ...changes };
}
const dump = (listings: NiftyDetail[]): NiftyDump => ({ source: "myhome.nifty.com", scrapedAt: now, listings });
const serialized = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const byId = (rows: readonly RawListing[]) => [...rows].sort((a, b) => a.id!.localeCompare(b.id!));

/** Independent copy of the pre-migration detail import selection/provenance behavior. */
function legacyResult(input: NiftyDump, previous: SourceFile | null) {
  const converted = input.listings.map(toRawListing).filter((row): row is RawListing => {
    if (!row || row.address === "" || row.rent <= 0) return false;
    return Number(row.layout?.normalize("NFKC").match(/^(\d+)/)?.[1] ?? 0) >= 2;
  });
  const aliases = new Map((previous?.listings ?? []).flatMap((row) => niftyMatchKeys(row).map((key) => [key, row] as const)));
  const priorTimes = (previous?.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const details = new Map(input.listings.map((entry) => [entry.url, entry]));
  const eligible = converted.filter((row) => {
    const prior = niftyMatchKeys(row).map((key) => aliases.get(key)).find(Boolean);
    if (!prior) return true;
    const at = details.get(row.url!)?.capturedAt;
    return at != null && at > (priorTimes[trackingKey(prior)] ?? previous?.scrapedAt ?? "");
  });
  return { merged: mergeNiftyIncremental(previous?.listings ?? [], eligible),
    scrapedAt: [previous?.scrapedAt ?? "", input.scrapedAt].sort().at(-1),
    provenance: { ...previous?.provenance, capturedBy: "logged-in browser session via Pi Control Chrome",
      detailPages: input.listings.length, familyListings: converted.length,
      observedTrackingKeys: eligible.filter((row) => details.get(row.url!)?.capturedAt).map(trackingKey),
      observedAtByKey: { ...priorTimes, ...Object.fromEntries(eligible.flatMap((row) => {
        const at = details.get(row.url!)?.capturedAt; return at ? [[trackingKey(row), at]] : [];
      })) }, input: "src/data/nifty_detail_raw.json" } };
}

describe("Nifty detail import through the public data layer", () => {
  let root: string, store: JsonSourceStore, service: ListingIngestionService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nifty-detail-import-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    service = new ListingIngestionService(new JsonListingRepository(store));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("submits only parsed observations with deterministic versioned capture metadata", async () => {
    const small = detail("112233", { kv: { ...detail().kv, "間取り": "1K（専有面積：25㎡）" } });
    const input = dump([detail(), detail("ddeeff", { capturedAt: undefined }), small,
      detail("445566", { httpStatus: 403 }), detail("778899", { kv: undefined })]);
    const prepared = await prepareNiftyDetailImport(input);
    expect(prepared.skipped).toBe(3);
    expect(prepared.batch).toMatchObject({ schemaVersion: 1, source: "nifty", mode: "detail-enrichment",
      scraper: { name: "nifty-detail", version: "1", parserVersion: NIFTY_DETAIL_PARSER_VERSION },
      observations: [expect.objectContaining({ sourceListingId: "nifty-aabbcc", observedAt: now }),
        expect.objectContaining({ sourceListingId: "nifty-ddeeff", observedAt: null })] });
    expect(prepared.batch).not.toHaveProperty("expectedRevision");
    expect(prepared.batch.observations[0].listing).not.toHaveProperty("parking");
    expect((await prepareNiftyDetailImport(serialized(input))).batch).toEqual(prepared.batch);
    await expect(prepareNiftyDetailImport({ ...input, source: "suumo" })).rejects.toThrow("Invalid Nifty");
  });

  it("matches legacy additions/newer-only updates and preserves unrelated data and archives", async () => {
    const oldAd = { ...toRawListing(detail())!, rent: 90000,
      parking: { available: true, monthlyYen: 6000, distanceM: null, location: null, raw: "6000円" },
      costs: { cleaningFeeYen: 40000 }, sourceDetails: { old: "retained in archive" } };
    const unseen = { ...oldAd, id: "nifty-eeeeff", url: detail("eeeeff").url, name: "Unseen", address: "埼玉県川口市",
      status: "sold" as const, soldAt: before, lastSeenAt: before };
    const previous: SourceFile = { source: "nifty", count: 2, listings: [oldAd, unseen], scrapedAt: before, completeSnapshot: true,
      provenance: { captureRunId: "older-run", observedAtByKey: { [trackingKey(oldAd)]: before } } };
    await store.writeSource(previous, { expectedRevision: null });
    await store.writeSource({ source: "yahoo", scrapedAt: before, listings: [{ ...oldAd, source: "yahoo" }] }, { expectedRevision: null });
    const otherSource = await readFile(store.sourcePath("yahoo"), "utf8");
    const userPath = join(root, "user.json"), canonicalPath = join(root, "listings_raw.json");
    await writeFile(userPath, '{"favorites":["nifty-aabbcc"]}');
    await writeFile(canonicalPath, JSON.stringify(previous.listings));
    const userBytes = await readFile(userPath, "utf8"), canonicalBytes = await readFile(canonicalPath, "utf8");
    const legacyNew = detail("778899", { capturedAt: undefined, h1: "Legacy home", kv: { ...detail().kv, "所在地": "埼玉県越谷市" } });
    const input = dump([detail("112233"), legacyNew, detail("445566", { error: "failed capture" })]);
    const expected = legacyResult(input, previous);
    const { batch } = await prepareNiftyDetailImport(input);
    const result = await service.ingestScrape(batch);
    expect(result).toMatchObject({ added: 1, updated: 1, retired: 1, currentCount: 3 });
    const saved = (await store.readSource("nifty"))!;
    expect(byId(saved.listings)).toEqual(byId(serialized(expected.merged.listings)));
    expect(saved.scrapedAt).toBe(expected.scrapedAt);
    expect(saved.listings.find((listing) => listing.id === "nifty-112233")!.parking).toEqual(oldAd.parking);
    const { ingestionJournal, ...provenance } = saved.provenance!;
    expect(provenance).toEqual(expected.provenance);
    expect(ingestionJournal).toBeDefined();
    expect(saved.archivedListings).toContainEqual(expect.objectContaining({ listing: serialized(oldAd), sourceListingId: oldAd.id }));
    expect(await readFile(store.sourcePath("yahoo"), "utf8")).toBe(otherSource);
    expect(await readFile(userPath, "utf8")).toBe(userBytes);
    expect(await readFile(canonicalPath, "utf8")).toBe(canonicalBytes);
    const bytes = await readFile(store.sourcePath("nifty"), "utf8");
    expect(await service.ingestScrape(batch)).toMatchObject({ replayed: true, added: 0, updated: 0, revision: result.revision });
    expect(await readFile(store.sourcePath("nifty"), "utf8")).toBe(bytes);
  });

  it("does not erase source rows when a dump has only failed captures", async () => {
    const initial = await prepareNiftyDetailImport(dump([detail()]));
    await service.ingestScrape(initial.batch);
    const previous = (await store.readSource("nifty"))!;
    const failed = await prepareNiftyDetailImport(dump([detail("112233", { error: "HTTP 403" })]));
    expect(failed.skipped).toBe(1);
    expect(await service.ingestScrape(failed.batch)).toMatchObject({ added: 0, updated: 0, retired: 0, currentCount: 1 });
    const saved = (await store.readSource("nifty"))!;
    expect(saved.listings).toEqual(previous.listings);
    expect(saved.completeSnapshot).toBe(false);
    expect(saved.provenance!.observedTrackingKeys).toEqual([]);
    expect(saved.provenance!.observedAtByKey).toEqual(previous.provenance!.observedAtByKey);
  });

  it("keeps shrink protection and allows only an explicit force override", async () => {
    const rows = ["aaaa", "bbbb", "cccc"].map((id) => toRawListing(detail(id))!);
    await store.writeSource({ source: "nifty", scrapedAt: before, listings: rows }, { expectedRevision: null });
    const bytes = await readFile(store.sourcePath("nifty"), "utf8");
    const { batch } = await prepareNiftyDetailImport(dump([detail("dddd")]));
    await expect(service.ingestScrape(batch)).rejects.toBeInstanceOf(ShrinkGuardError);
    expect(await readFile(store.sourcePath("nifty"), "utf8")).toBe(bytes);
    expect(await service.ingestScrape(batch, { allowShrink: true })).toMatchObject({ replayed: false, currentCount: 1, retired: 3 });
    expect((await store.readSource("nifty"))!.archivedListings).toHaveLength(3);
  });

  it("matches the full checked-in dump/source without touching production files", async () => {
    const sourcePath = join(DATA_DIR, "sources", "nifty.json"), inputPath = join(DATA_DIR, "nifty_detail_raw.json");
    const sourceBytes = await readFile(sourcePath, "utf8"), inputBytes = await readFile(inputPath, "utf8");
    const previous = JSON.parse(sourceBytes) as SourceFile, input = JSON.parse(inputBytes) as NiftyDump;
    await store.writeSource(previous, { expectedRevision: null });
    const expected = legacyResult(input, previous);
    const { batch } = await prepareNiftyDetailImport(input);
    const result = await service.ingestScrape(batch);
    const saved = (await store.readSource("nifty"))!;
    expect(byId(saved.listings)).toEqual(byId(serialized(expected.merged.listings)));
    expect(result).toMatchObject({ added: expected.merged.added, updated: expected.merged.updated, currentCount: expected.merged.listings.length });
    // The journal is data-layer managed, so the legacy copy cannot predict it; compare it separately.
    const { ingestionJournal: journal, ...provenance } = saved.provenance! as { ingestionJournal?: { batches: unknown[] } };
    const { ingestionJournal: priorJournal, ...legacyProvenance } = expected.provenance as { ingestionJournal?: { batches: unknown[] } };
    // Journal history from earlier real refreshes survives. A dump that a refresh already
    // imported replays without a new entry, and later crawls own the rest of the provenance
    // (capturedBy, observed keys); otherwise the import appends exactly one batch.
    const priorBatches = (priorJournal?.batches ?? []) as { runId: string; batchId: string }[];
    const alreadyImported = priorBatches.some((entry) => entry.runId === batch.runId && entry.batchId === batch.batchId);
    const { ingestionJournal: _journal, ...priorProvenance } = (previous.provenance ?? {}) as { ingestionJournal?: unknown };
    expect(provenance).toEqual(alreadyImported ? priorProvenance : legacyProvenance);
    expect(result.replayed).toBe(alreadyImported);
    expect(journal?.batches.slice(0, priorBatches.length)).toEqual(priorBatches);
    expect(journal?.batches).toHaveLength(priorBatches.length + (alreadyImported ? 0 : 1));
    expect(saved.scrapedAt).toBe(expected.scrapedAt);
    expect(await service.ingestScrape(batch)).toMatchObject({ replayed: true, revision: result.revision });
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
    expect(await readFile(inputPath, "utf8")).toBe(inputBytes);
  });
});
