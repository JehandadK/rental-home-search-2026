import type { ListingSourceSnapshot } from "../contracts";
import { canonicalJson, contentFingerprint } from "../contentIdentity";
import { indexSourceRows } from "../sourceRowIdentity";
import { portalPageUrl, type PortalDiscoveryOptions, type PortalDiscoverySession, type ScrapeBatch, type ScrapeIngestionReceipt, type SuumoDiscoveryPageResult } from "./contracts";
import { InvalidScrapeBatchError } from "./errors";
import type { SourcePolicy, SourcePolicyRegistry } from "./sourcePolicy";

/** Returns the source's policy; only sources with a portal-discovery policy qualify. */
export function validatePortalOptions(options: PortalDiscoveryOptions, policies: SourcePolicyRegistry): SourcePolicy & Required<Pick<SourcePolicy, "portalDiscovery">> {
  const policy = policies.get(options?.source);
  const host = policy?.host;
  if (!options || !policy?.portalDiscovery || typeof options.deep !== "boolean" || !Number.isInteger(options.maxPages) || options.maxPages < 1
    || !Array.isArray(options.cities) || !options.cities.length || !options.cities.every((city) => {
      try { const url = new URL(city.url); return typeof city.label === "string" && city.label.trim() && url.protocol === "https:" && url.hostname === host && !url.username && !url.password; } catch { return false; }
    }) || new Set(options.cities.map((city) => city.label)).size !== options.cities.length) throw new InvalidScrapeBatchError("Invalid portal discovery options");
  return policy as SourcePolicy & Required<Pick<SourcePolicy, "portalDiscovery">>;
}

/** Shared bounded-window orchestration; source-specific identity and merges remain in portalPolicy. */
export class StagedPortalDiscovery implements PortalDiscoverySession {
  readonly bootstrap: boolean;
  readonly deep: boolean;
  private readonly known: Set<string>;
  private readonly seen = new Map<string, string | null>();
  private readonly pages: ScrapeBatch[] = [];
  private readonly cities = new Map<string, { pages: number; known: number; done: boolean }>();
  private closed = false;
  private committing?: Promise<ScrapeIngestionReceipt>;
  constructor(private readonly options: PortalDiscoveryOptions,
    private readonly policy: NonNullable<SourcePolicy["portalDiscovery"]>,
    previous: ListingSourceSnapshot | null,
    private readonly validate: (batch: ScrapeBatch) => void,
    private readonly commitBatch: (batch: ScrapeBatch, options: { allowShrink?: boolean }) => Promise<ScrapeIngestionReceipt>) {
    indexSourceRows(previous?.listings ?? []);
    this.bootstrap = !previous; this.deep = options.deep || this.bootstrap;
    this.known = new Set((previous?.listings ?? []).flatMap((row) => policy.keys(row)));
    for (const city of options.cities) this.cities.set(city.label, { pages: 0, known: 0, done: false });
  }
  stagePage(input: ScrapeBatch): SuumoDiscoveryPageResult {
    if (this.closed) throw new InvalidScrapeBatchError("Portal discovery session is closed");
    try {
      this.validate(input);
      const batch = JSON.parse(canonicalJson(input)) as ScrapeBatch;
      const city = this.options.cities.find((city) => city.label === batch.scope.cities[0]);
      const state = city && this.cities.get(city.label)!;
      if (batch.source !== this.options.source || batch.mode !== "discovery" || batch.scraper.name !== `${this.options.source}-list`
        || !city || !state || state.done || batch.scope.cities.length !== 1 || batch.scope.urls.length !== 1
        || batch.scope.filters.page !== state.pages + 1 || batch.scope.urls[0] !== portalPageUrl(this.options.source, city.url, state.pages + 1)
        || batch.observations.some((observation) => observation.observedAt !== batch.capturedAt)) throw new InvalidScrapeBatchError("Unexpected portal page sequence/scope/time");
      let novel = 0, overlap = 0, duplicate = 0;
      for (const observation of batch.observations) {
        const keys = this.policy.keys(observation.listing);
        // Same as the commit merge: distinct source IDs are distinct ads even when they share a property alias.
        const id = observation.listing.id ?? null;
        if (keys.some((key) => this.seen.has(key) && (this.seen.get(key) == null || id === null || this.seen.get(key) === id))) { duplicate++; continue; }
        keys.forEach((key) => this.seen.set(key, id));
        if (keys.some((key) => this.known.has(key))) overlap++; else novel++;
      }
      state.pages++;
      // Legacy collectors skip empty non-family pages; they do not establish exhaustion or add a known page.
      if (batch.observations.length) state.known = novel === 0 ? state.known + 1 : 0;
      const stopReason = !this.deep && batch.observations.length > 0 && state.known >= 2 ? "overlap" : state.pages >= this.options.maxPages ? "page-limit" : null;
      state.done = stopReason !== null; this.pages.push(batch);
      return { parsedCount: batch.observations.length, novel, overlap, duplicate, stopReason };
    } catch (error) { this.closed = true; throw error; }
  }
  commit(options: { allowShrink?: boolean } = {}): Promise<ScrapeIngestionReceipt> {
    if (this.committing) return this.committing;
    if (this.closed) return Promise.reject(new InvalidScrapeBatchError("Portal discovery session is closed"));
    this.closed = true; this.committing = this.finish({ ...options }); return this.committing;
  }
  private async finish(options: { allowShrink?: boolean }) {
    if ([...this.cities.values()].some((city) => !city.done)) throw new InvalidScrapeBatchError("Incomplete portal discovery");
    const observations = this.pages.flatMap((page) => page.observations);
    if (!observations.length) throw new InvalidScrapeBatchError("Crawl returned no usable family rooms; source left untouched");
    const source = this.options.source;
    const capturedAt = this.pages.map((page) => page.capturedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
    const body = { schemaVersion: 1 as const, source, scraper: { name: `${source}-list`, version: "1", parserVersion: "1" },
      mode: "discovery" as const, capturedAt, observations,
      scope: { urls: this.pages.flatMap((page) => page.scope.urls), cities: this.options.cities.map((city) => city.label), filters: { deep: this.deep, maxPages: this.options.maxPages } },
      provenance: { mode: this.deep ? "deep newest-first" : "incremental newest-first", pagesFetched: this.pages.length,
        cities: this.options.cities.map((city) => this.policy.provenanceCity(city)),
        capturedBy: this.policy.capturedBy } };
    const batch = { ...body, runId: `${source}-discovery:${capturedAt}`, batchId: await contentFingerprint(body) };
    this.validate(batch); return this.commitBatch(batch, options);
  }
}
