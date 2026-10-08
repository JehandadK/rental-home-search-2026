import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListingAgency, RawListing } from "../../domain/types";
import { JsonListingRepository } from "../../storage/json/jsonListingRepository";
import { JsonSourceStore } from "../../storage/json/dataStore";
import { trackingKey } from "../../domain/listingIdentity";
import type { DetailPatchBatch, ListingDetailPatch } from "./contracts";
import { ListingIngestionService } from "./service";
import { preparePortalRows } from "./portalBatch.contract";
import { addAgency } from "./agencyPatch";

const listedAt = "2026-10-01T00:00:00.000Z", readAt = "2026-10-08T00:00:00.000Z", laterAt = "2026-10-09T00:00:00.000Z";
const store = (changes: Partial<ListingAgency> = {}): ListingAgency => ({ name: "株式会社中央ビル管理 北千住営業所", brand: "中央ビル管理",
  company: "株式会社中央ビル管理", branch: "北千住営業所", address: "東京都足立区千住2丁目22マスミビル1階", prefecture: "東京都", city: "足立区",
  phone: "0120-956-776", licence: "国土交通大臣(9)第3918号", ...changes });
const withStore = (info = store()): ListingDetailPatch => ({ agency: info.name, agencyInfo: info });
const row = (id: string, changes: Partial<RawListing> = {}): RawListing => ({ id: `roomspot-${id}`, source: "roomspot", name: `ハイツ${id}`,
  address: `東京都足立区千住${id}`, rent: 90000, sizeM2: 50, layout: "2LDK", builtYear: 2015, stationWalkMin: 6,
  url: `https://www.roomspot.net/rent/${id}`, ...changes });

function patchBatch(observations: { url: string; at?: string; details: ListingDetailPatch }[], source: "roomspot" | "athome" = "roomspot"): DetailPatchBatch {
  return { schemaVersion: 1, source, scraper: { name: `${source}-detail`, version: "1", parserVersion: "1" },
    observationKind: "detail-patch", mode: "detail-enrichment", runId: `${source}-detail-captures:${readAt}`,
    batchId: `batch-${JSON.stringify(observations).length}-${observations.map((o) => o.at ?? readAt).join()}`, capturedAt: observations.map((o) => o.at ?? readAt).sort().at(-1)!,
    scope: { urls: observations.map((o) => o.url), cities: [], filters: { fields: "agency" } },
    observations: observations.map(({ url, at = readAt, details }) => ({ sourceListingId: url, observedAt: at, evidence: { url, captureId: `capture-${url}-${at}` }, details })) };
}

describe("AtHome / RoomSpot agency detail patches", () => {
  let root: string, sources: JsonSourceStore, repository: JsonListingRepository, service: ListingIngestionService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "portal-detail-policy-"));
    sources = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    repository = new JsonListingRepository(sources);
    service = new ListingIngestionService(repository);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const seed = (listings = [row("1"), row("2")], source = "roomspot", provenance: Record<string, unknown> = {}) => sources.writeSource({ source, scrapedAt: listedAt,
    completeSnapshot: false, listings, provenance: { observedAtByKey: {}, ...provenance } }, { expectedRevision: null });
  const saved = async (source = "roomspot") => new Map((await sources.readSource(source))!.listings.map((listing) => [listing.id, listing]));

  it("adds the store's name and details together, and nothing else", async () => {
    await seed();
    const receipt = await service.ingestScrape(patchBatch([{ url: row("1").url!, details: withStore() }]));
    expect(receipt).toMatchObject({ added: 0, updated: 1, retired: 0, currentCount: 2 });
    const rows = await saved();
    expect(rows.get("roomspot-1")).toEqual({ ...row("1"), agency: store().name, agencyInfo: store() });
    expect(rows.get("roomspot-2")).toEqual(row("2"));
    const file = (await sources.readSource("roomspot"))!;
    expect(file.scrapedAt).toBe(listedAt);
    expect(file.provenance).toMatchObject({ detailObservedAtByUrl: { [row("1").url!]: readAt } });
  });

  it("keeps a stored store when a later page shows no store block", async () => {
    await seed();
    await service.ingestScrape(patchBatch([{ url: row("1").url!, details: withStore() }]));
    expect(await service.ingestScrape(patchBatch([{ url: row("1").url!, at: laterAt, details: {} }]))).toMatchObject({ updated: 0, ignored: 1 });
    expect((await saved()).get("roomspot-1")).toMatchObject({ agency: store().name, agencyInfo: store() });
  });

  it("never mixes two stores: another store's page leaves the stored one whole", async () => {
    await seed([row("1", { agency: store().name, agencyInfo: store() })]);
    const other = store({ name: "ハウスコム埼玉(株)草加店", brand: "ハウスコム", city: "草加市", phone: "0800-1700231" });
    expect(await service.ingestScrape(patchBatch([{ url: row("1").url!, at: laterAt, details: withStore(other) }]))).toMatchObject({ updated: 0 });
    expect((await saved()).get("roomspot-1")).toMatchObject({ agency: store().name, agencyInfo: store() });
  });

  it("fills only the details the stored store lacks", async () => {
    const partial = store({ phone: null, licence: null });
    await seed([row("1", { agency: partial.name, agencyInfo: partial })]);
    await service.ingestScrape(patchBatch([{ url: row("1").url!, details: withStore(store({ phone: "03-0000-0000" })) }]));
    expect((await saved()).get("roomspot-1")!.agencyInfo).toEqual(store({ phone: "03-0000-0000" }));
    // A stored value is never overwritten, even by a newer page of the same store.
    expect(addAgency({ ...row("1"), agency: store().name, agencyInfo: store() }, withStore(store({ phone: "03-1111-1111" })))).toBeNull();
    expect(addAgency({ ...row("1"), agency: store().name }, withStore())).toEqual(withStore());
  });

  it("lets an older capture, or a newer parser's reading of it, fill a store that is still missing", async () => {
    await seed([row("1")], "roomspot", { detailObservedAtByUrl: { [row("1").url!]: laterAt } });
    // The first parser found no store in the capture; a later parser reads the same capture.
    expect(await service.ingestScrape(patchBatch([{ url: row("1").url!, details: {} }]))).toMatchObject({ updated: 0 });
    expect(await service.ingestScrape(patchBatch([{ url: row("1").url!, details: withStore() }]))).toMatchObject({ updated: 1 });
    expect((await saved()).get("roomspot-1")).toMatchObject({ agency: store().name, agencyInfo: store() });
    expect((await sources.readSource("roomspot"))!.provenance!.detailObservedAtByUrl).toEqual({ [row("1").url!]: laterAt });
  });

  it("keeps the store across a later list crawl, which never names one", () => {
    const enriched = { ...row("1"), agency: store().name, agencyInfo: store() };
    const merged = preparePortalRows("roomspot", [enriched], [{ ...row("1"), rent: 88000 }]);
    expect(merged.listings).toEqual([{ ...enriched, rent: 88000 }]);
    expect(preparePortalRows("roomspot", [enriched], [{ ...row("1"), agency: null, agencyInfo: null }]).listings).toEqual([enriched]);
    const other = store({ name: "別の店" });
    expect(preparePortalRows("roomspot", [enriched], [{ ...row("1"), agency: other.name, agencyInfo: other }]).listings).toEqual([enriched]);
    const athome = { ...row("1"), id: "athome-1", source: "athome", url: "https://www.athome.co.jp/chintai/1/", agency: store().name, agencyInfo: store() };
    expect(preparePortalRows("athome", [athome], [{ ...athome, agency: undefined, agencyInfo: undefined, rent: 88000 }]).listings[0])
      .toMatchObject({ agency: store().name, agencyInfo: store(), rent: 88000 });
  });

  it("never gives a store to a different ad a list crawl matches by property alias", () => {
    const enriched = { ...row("1"), agency: store().name, agencyInfo: store() };
    // Same room relisted under a new ad ID (perhaps by another agency).
    const relisted = { ...row("1"), id: "roomspot-99", url: "https://www.roomspot.net/rent/99" };
    const merged = preparePortalRows("roomspot", [enriched], [relisted]);
    expect(merged.listings).toEqual([relisted]);
    expect(merged.listings[0]).not.toHaveProperty("agency");
    // The old ad, store and all, is archived rather than dropped.
    expect(merged.retirements).toEqual([expect.objectContaining({ sourceListingId: "roomspot-1" })]);
  });

    it("serves AtHome through the same policy", async () => {
    const ad = row("1", { id: "athome-1", source: "athome", url: "https://www.athome.co.jp/chintai/1/" });
    await seed([ad], "athome");
    await service.ingestScrape(patchBatch([{ url: ad.url!, details: withStore() }], "athome"));
    expect((await saved("athome")).get("athome-1")).toMatchObject({ agency: store().name, agencyInfo: store() });
  });

  it.each([
    ["prices", { agency: store().name, agencyInfo: store(), rent: 1 }],
    ["parking", { parking: { available: true, monthlyYen: 0, distanceM: null, raw: "有", location: "onsite" } }],
    ["source details", { sourceDetails: { 所在地: "東京都" } }],
    ["a name without its store", { agency: store().name }],
    ["a store without its name", { agencyInfo: store() }],
    ["two different stores", { agency: "別の店", agencyInfo: store() }],
    ["an unnamed store", { agency: "", agencyInfo: store({ name: "" }) }],
    ["unknown store fields", { agency: store().name, agencyInfo: { ...store(), owner: "x" } }],
    ["a cleared store", { agency: null, agencyInfo: null }],
  ])("rejects %s before reading source storage", async (_, details) => {
    await seed();
    const read = vi.spyOn(repository, "readSource");
    await expect(service.ingestScrape(patchBatch([{ url: row("1").url!, details: details as ListingDetailPatch }]))).rejects.toThrow("Invalid or forbidden detail patch fields");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown parser version", (batch: DetailPatchBatch) => { batch.scraper.parserVersion = "2"; }, "parserVersion"],
    ["another portal's URL", (batch: DetailPatchBatch) => {
      const url = "https://www.athome.co.jp/chintai/1/";
      batch.scope = { ...batch.scope, urls: [url] };
      batch.observations = [{ ...batch.observations[0], sourceListingId: url, evidence: { ...batch.observations[0].evidence, url } }];
    }, "Invalid scrape scope"],
    ["another producer", (batch: DetailPatchBatch) => { batch.scraper.name = "suumo-detail"; }, "scraper name"],
  ])("rejects %s", async (_, change, message) => {
    await seed();
    const batch = patchBatch([{ url: row("1").url!, details: withStore() }]);
    change(batch);
    await expect(service.ingestScrape(batch)).rejects.toThrow(message);
  });

  it("refuses to enrich an ad the source does not hold, without writing", async () => {
    await seed();
    const before = await readFile(sources.sourcePath("roomspot"), "utf8");
    await expect(service.ingestScrape(patchBatch([{ url: "https://www.roomspot.net/rent/9", details: withStore() }]))).rejects.toThrow("unknown source URL");
    expect(await readFile(sources.sourcePath("roomspot"), "utf8")).toBe(before);
  });

  it("plans current ads without a store, most recently seen first", async () => {
    const [a, b, c] = [row("1"), row("2"), row("3")];
    await seed([a, b, c, row("4", { agency: store().name, agencyInfo: store() }), row("5", { status: "sold" }),
      row("6", { url: "http://www.roomspot.net/rent/6" }), row("7", { url: "https://example.com/rent/7" })],
    "roomspot", { observedAtByKey: { [trackingKey(b)]: laterAt, [trackingKey(a)]: listedAt } });
    expect(await service.planAgencyDetails({ source: "roomspot", force: false })).toEqual([b.url, a.url, c.url]);
    expect(await service.planAgencyDetails({ source: "roomspot", force: true })).toEqual([b.url, a.url, c.url, row("4").url]);
    await expect(service.planAgencyDetails({ source: "athome", force: false })).rejects.toThrow("athome source missing");
    await expect(service.planAgencyDetails({ source: "nifty" as "athome", force: false })).rejects.toThrow("Unsupported agency detail source");
  });
});
