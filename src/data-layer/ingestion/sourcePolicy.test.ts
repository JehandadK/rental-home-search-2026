import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawListing } from "../../domain/types";
import type { ScrapeBatch } from "./contracts";
import { ListingIngestionService, InvalidScrapeBatchError } from "./service";
import { exactReconciliation } from "./reconciliation";
import { SourcePolicyRegistry, type SourcePolicy } from "./sourcePolicy";
import { SOURCE_POLICIES } from "./sourcePolicies";
import { JsonSourceStore } from "../../storage/json/dataStore";
import { JsonListingRepository } from "../../storage/json/jsonListingRepository";

const at = "2026-09-30T00:00:00.000Z";

/** A new site: one policy (append every fresh row), registered without touching the service. */
const examplePolicy: SourcePolicy = {
  source: "example",
  host: "rent.example.jp",
  listings: {
    exactUrlDiscovery: false,
    prepare: (batch, previous) => {
      const fresh = batch.observations.map((observation) => observation.listing);
      const listings = [...(previous?.listings ?? []), ...fresh];
      return {
        reconciliation: exactReconciliation(batch.source, previous, listings, batch.capturedAt, { ...previous?.provenance }),
        added: fresh.length, updated: 0, novel: fresh.length, ignored: 0,
        previousCount: previous?.listings.length ?? 0, currentCount: listings.length,
      };
    },
  },
};

const row = (id: string): RawListing => ({ id, name: "Example House", address: "埼玉県草加市1丁目", source: "example", rent: 90_000,
  sizeM2: 55, layout: "2LDK", builtYear: 2015, stationWalkMin: 6, url: `https://rent.example.jp/rooms/${id}` });

const batch = (listings: RawListing[], overrides: Partial<ScrapeBatch> = {}): ScrapeBatch => ({
  schemaVersion: 1, source: "example", scraper: { name: "example-list", version: "1", parserVersion: "1" },
  runId: "run-1", batchId: "page-1", mode: "discovery", capturedAt: at,
  scope: { urls: listings.map((listing) => listing.url!), cities: ["Soka"], filters: { page: 1 } },
  observations: listings.map((listing) => ({ sourceListingId: listing.id!, observedAt: at, listing,
    evidence: { url: listing.url!, captureId: `capture:${listing.id}` } })),
  ...overrides,
});

describe("source policy registry", () => {
  let root: string, repository: JsonListingRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "source-policy-"));
    repository = new JsonListingRepository(new JsonSourceStore(join(root, "sources"), join(root, "backups")));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("registers the four current sources", () => {
    expect(SOURCE_POLICIES.sources).toEqual(["suumo", "nifty", "athome", "roomspot"]);
  });

  it("ingests a newly registered source through the unchanged service", async () => {
    const service = new ListingIngestionService(repository, new SourcePolicyRegistry([...defaultPolicies(), examplePolicy]));
    const receipt = await service.ingestScrape(batch([row("a1"), row("a2")]));
    expect(receipt).toMatchObject({ source: "example", added: 2, currentCount: 2, replayed: false });
    expect((await repository.readSource("example"))!.listings.map((listing) => listing.id)).toEqual(["a1", "a2"]);
    // Replay and journaling are the service's, not the policy's.
    expect(await service.ingestScrape(batch([row("a1"), row("a2")]))).toMatchObject({ replayed: true, added: 0 });
  });

  it("applies the policy's host to listing and evidence URLs", async () => {
    const service = new ListingIngestionService(repository, new SourcePolicyRegistry([examplePolicy]));
    const offHost = { ...row("b1"), url: "https://elsewhere.example.com/rooms/b1" };
    await expect(service.ingestScrape(batch([offHost]))).rejects.toThrow(InvalidScrapeBatchError);
  });

  it("rejects unregistered sources and capabilities a policy does not declare", async () => {
    const service = new ListingIngestionService(repository, new SourcePolicyRegistry([examplePolicy]));
    // The default sources are not registered in this registry.
    const nifty = { ...batch([row("c1")]), source: "nifty" };
    await expect(service.ingestScrape(nifty)).rejects.toThrow("Unsupported scrape source");
    // No detail-patch policy.
    const patch = { ...batch([]), observationKind: "detail-patch", mode: "detail-enrichment", observations: [] } as unknown as ScrapeBatch;
    await expect(service.ingestScrape(patch)).rejects.toThrow("Unsupported scrape source");
    // No detail-import producer: listing batches must be discovery.
    await expect(service.ingestScrape(batch([row("c2")], { mode: "detail-enrichment" }))).rejects.toThrow(/Unsupported scrape mode/);
    // No portal-discovery policy.
    await expect(service.beginPortalDiscovery({ source: "example" as "athome", deep: false, maxPages: 1,
      cities: [{ label: "Soka", url: "https://rent.example.jp/soka" }] })).rejects.toThrow("Invalid portal discovery options");
    // Capture-run annotations accept registered sources only.
    await expect(service.annotateCaptureRun({ schemaVersion: 1, source: "nifty", cities: [] })).rejects.toThrow("Invalid capture run summary");
  });

  it("refuses two policies for one source", () => {
    expect(() => new SourcePolicyRegistry([examplePolicy, examplePolicy])).toThrow(/Duplicate source policy: example/);
  });
});

function defaultPolicies(): SourcePolicy[] {
  return SOURCE_POLICIES.sources.map((source) => SOURCE_POLICIES.get(source)!);
}
