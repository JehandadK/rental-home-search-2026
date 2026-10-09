import type { ListingSourceSnapshot } from "../contracts";
import { canonicalJson, contentFingerprint } from "../contentIdentity";
import { indexSourceRows } from "../sourceRowIdentity";
import type { ScrapeBatch, ScrapeIngestionReceipt, SuumoDiscoveryOptions, SuumoDiscoveryPageResult, SuumoDiscoverySession } from "./contracts";
import { InvalidScrapeBatchError } from "./errors";
import { suumoDiscoveryMatchKeys as suumoMatchKeys } from "./suumoIdentity";

export function validateSuumoDiscoveryOptions(options: SuumoDiscoveryOptions): void {
  if (!options || typeof options.deep !== "boolean" || !Number.isInteger(options.maxPages) || options.maxPages < 1
    || !Array.isArray(options.cities) || !options.cities.length || !options.cities.every((city) => city && /^sc_[a-z0-9_]+$/.test(city.code) && typeof city.label === "string" && city.label.trim())
    || new Set(options.cities.map((city) => city.code)).size !== options.cities.length || new Set(options.cities.map((city) => city.label)).size !== options.cities.length
    || !Array.isArray(options.layoutCodes) || !options.layoutCodes.length || !options.layoutCodes.every((code) => typeof code === "string" && /^\d{2}$/.test(code))) {
    throw new InvalidScrapeBatchError("Invalid SUUMO discovery scope/options");
  }
}

/** Keeps baseline/seen aliases inside the application layer; the collector only receives counters. */
export class StagedSuumoDiscovery implements SuumoDiscoverySession {
  private readonly known: Set<string>;
  private readonly seen = new Set<string>();
  private readonly pages: ScrapeBatch[] = [];
  private readonly cities = new Map<string, { pages: number; knownPages: number; done: boolean }>();
  private closed = false;
  private committing?: Promise<ScrapeIngestionReceipt>;

  constructor(
    private readonly options: SuumoDiscoveryOptions,
    previous: ListingSourceSnapshot,
    private readonly validate: (batch: ScrapeBatch) => void,
    private readonly commitBatch: (batch: ScrapeBatch, options: { allowShrink?: boolean }) => Promise<ScrapeIngestionReceipt>,
  ) {
    if (previous.listings.some((listing) => listing.source !== "suumo")) throw new InvalidScrapeBatchError("SUUMO snapshot contains another source's rows");
    indexSourceRows(previous.listings);
    this.known = new Set(previous.listings.flatMap(suumoMatchKeys));
    for (const city of options.cities) this.cities.set(city.label, { pages: 0, knownPages: 0, done: false });
  }

  stagePage(input: ScrapeBatch): SuumoDiscoveryPageResult {
    if (this.closed) throw new InvalidScrapeBatchError("SUUMO discovery session is closed");
    try {
      this.validate(input);
      const page = JSON.parse(canonicalJson(input)) as ScrapeBatch;
      if (page.source !== "suumo" || page.mode !== "discovery" || !page.observations.length
        || page.scope.urls.length !== 1 || page.scope.cities.length !== 1) throw new InvalidScrapeBatchError("Expected one SUUMO discovery page");
      const city = this.options.cities.find((candidate) => candidate.label === page.scope.cities[0]);
      const state = city ? this.cities.get(city.label)! : undefined;
      const number = page.scope.filters.page;
      const url = new URL(page.scope.urls[0]);
      if (!city || !state || state.done || number !== state.pages + 1 || Number(url.searchParams.get("page") ?? 1) !== number
        || !new RegExp(`^/chintai/[a-z]+/${city.code}/$`).test(url.pathname) || url.searchParams.get("po1") !== "09"
        || url.searchParams.getAll("md").join(",") !== this.options.layoutCodes.join(",")
        || page.observations.some((observation) => observation.observedAt !== page.capturedAt)) throw new InvalidScrapeBatchError("Unexpected SUUMO page sequence/scope/time");
      let novel = 0, overlap = 0, duplicate = 0;
      for (const observation of page.observations) {
        const aliases = suumoMatchKeys(observation.listing);
        if (aliases.some((key) => this.seen.has(key))) { duplicate++; continue; }
        aliases.forEach((key) => this.seen.add(key));
        if (aliases.some((key) => this.known.has(key))) overlap++; else novel++;
      }
      state.pages++;
      state.knownPages = novel === 0 ? state.knownPages + 1 : 0;
      const stopReason = !this.options.deep && state.knownPages >= 2 ? "overlap" : state.pages >= this.options.maxPages ? "page-limit" : null;
      state.done = stopReason !== null;
      this.pages.push(page);
      return { parsedCount: page.observations.length, novel, overlap, duplicate, stopReason };
    } catch (error) { this.closed = true; throw error; }
  }

  commit(options: { allowShrink?: boolean } = {}): Promise<ScrapeIngestionReceipt> {
    if (this.committing) return this.committing;
    if (this.closed) return Promise.reject(new InvalidScrapeBatchError("SUUMO discovery session is closed"));
    this.closed = true;
    this.committing = this.finish({ ...options });
    return this.committing;
  }

  private async finish(options: { allowShrink?: boolean }): Promise<ScrapeIngestionReceipt> {
    if (!this.pages.length || [...this.cities.values()].some((city) => !city.done)) throw new InvalidScrapeBatchError("Incomplete bounded SUUMO discovery; source checkpoint not committed");
    const capturedAt = this.pages.map((page) => page.capturedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
    const body = {
      schemaVersion: 1 as const, source: "suumo", scraper: { name: "suumo-list", version: "1", parserVersion: "1" }, mode: "discovery" as const, capturedAt,
      scope: { urls: this.pages.flatMap((page) => page.scope.urls), cities: this.options.cities.map((city) => city.label),
        filters: { deep: this.options.deep, maxPages: this.options.maxPages, layoutCodes: this.options.layoutCodes.join(","), sort: "newest" } },
      observations: this.pages.flatMap((page) => page.observations),
      provenance: { mode: this.options.deep ? "deep newest-first" : "incremental newest-first", pagesFetched: this.pages.length,
        cities: this.options.cities.map((city) => `${city.label} (${city.code}, emergency ceiling ${this.options.maxPages}p)`),
        layoutCodes: this.options.layoutCodes.join(","), capturedBy: "scripts/scrape.ts" },
    };
    const batch = { ...body, runId: `suumo-discovery:${capturedAt}`, batchId: await contentFingerprint(body) };
    this.validate(batch);
    return this.commitBatch(batch, options);
  }
}
