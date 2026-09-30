import type { RawListing } from "../../domain/types";
import { deduplicateListings } from "../../domain/listingDedup";
import type { ListingObservationBatch, ListingSourceSnapshot } from "../contracts";
import type { DetailEnrichmentOptions, DetailPatchBatch, ListingDetailPatch } from "./contracts";
import { InvalidScrapeBatchError } from "./errors";

const defined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, v]) => v != null && (!Array.isArray(v) || v.length > 0))) as Partial<T>;

/** Existing detail overlay semantics: unknown values never clear known fields. */
export function applyDetail(listing: RawListing, detail: ListingDetailPatch): RawListing {
  return { ...listing, ...defined(detail),
    costs: { ...listing.costs, ...defined(detail.costs ?? {}) },
    tenancy: { ...listing.tenancy, ...defined(detail.tenancy ?? {}) },
    building: { ...listing.building, ...defined(detail.building ?? {}) },
  };
}

/** Keep collector selection separate from fetching, queue storage, and source mutation. */
export function selectDetailUrls(sources: readonly ListingSourceSnapshot[], options: DetailEnrichmentOptions): string[] {
  if (!Number.isFinite(options.maxRent) || options.maxRent <= 0 || !Number.isFinite(options.minSize) || options.minSize <= 0 || typeof options.force !== "boolean") {
    throw new InvalidScrapeBatchError("Invalid detail selection options");
  }
  if (!sources.some((source) => source.source === "suumo")) throw new InvalidScrapeBatchError("SUUMO source missing");
  const unique = deduplicateListings(sources.flatMap((source) => source.listings));
  const eligible = unique.filter((listing) => listing.status !== "sold" && listing.rent <= options.maxRent && (listing.sizeM2 ?? 0) >= options.minSize && Number(listing.layout?.match(/^\d+/)?.[0]) >= 2)
    .sort((a, b) => a.rent / a.sizeM2! - b.rent / b.sizeM2! || (a.url ?? "").localeCompare(b.url ?? ""));
  const urls = new Set<string>();
  for (const listing of eligible) {
    const complete = listing.parking && listing.tenancy?.leaseType && listing.building?.features?.length;
    const url = listing.source === "suumo" ? listing.url : listing.sourceListings?.find((reference) => reference.source === "suumo")?.url;
    if (url && (options.force || !complete)) urls.add(url);
  }
  return [...urls];
}

/** Exact-ad-only enrichment. Never discover, retire, reactivate, or advance market observation times. */
export function prepareSuumoDetailBatch(request: DetailPatchBatch, previous: ListingSourceSnapshot | null) {
  if (!previous) throw new InvalidScrapeBatchError("SUUMO source missing");
  const byUrl = new Map<string, RawListing[]>();
  for (const listing of previous.listings) {
    if (listing.url) byUrl.set(listing.url, [...(byUrl.get(listing.url) ?? []), listing]);
  }
  const priorTimes = previous.provenance?.detailObservedAtByUrl;
  if (priorTimes !== undefined && (!priorTimes || typeof priorTimes !== "object" || Array.isArray(priorTimes)
    || !Object.values(priorTimes).every((value) => typeof value === "string" && Number.isFinite(Date.parse(value))))) {
    throw new InvalidScrapeBatchError("Invalid persisted detail observation times");
  }
  const times: Record<string, string> = { ...priorTimes as Record<string, string> | undefined };
  const seen = new Set<string>();
  const observations: ListingObservationBatch["observations"][number][] = [];
  let updated = 0;
  for (const observation of request.observations) {
    const url = observation.evidence.url;
    const matches = byUrl.get(url);
    if (!matches) throw new InvalidScrapeBatchError(`Cannot enrich unknown source URL: ${url}`);
    if (seen.has(url)) continue;
    seen.add(url);
    if (times[url] && Date.parse(observation.observedAt) <= Date.parse(times[url])) continue;
    for (const listing of matches) {
      observations.push({ source: "suumo", sourceListingId: listing.id ?? url, targetUrl: url,
        observedAt: observation.observedAt, listing: applyDetail(listing, observation.details) });
    }
    times[url] = observation.observedAt;
    updated++;
  }
  const batch: ListingObservationBatch = {
    source: "suumo", expectedRevision: previous.revision, observedAt: previous.scrapedAt,
    completeness: "preserve", observations,
    // Detail capture metadata lives in the ingestion journal. Do not replace list
    // capture provenance or manufacture new availability evidence here.
    provenance: { ...previous.provenance, detailObservedAtByUrl: times },
  };
  return { batch, added: 0, updated, novel: 0, ignored: request.observations.length - updated,
    previousCount: previous.listings.length, currentCount: previous.listings.length };
}

/** Runtime allowlist for the patch shape, not just a TypeScript-only promise. */
export function validateDetailPatch(value: unknown): void {
  type Check = (value: unknown) => boolean;
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const nullable = (check: Check): Check => (v) => v === null || check(v);
  const text: Check = (v) => typeof v === "string";
  const number: Check = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const boolean: Check = (v) => typeof v === "boolean";
  const texts: Check = (v) => Array.isArray(v) && v.every(text);
  const fields = (checks: Record<string, Check>): Check => (v) => object(v) && Object.entries(v).every(([key, item]) =>
    Object.hasOwn(checks, key) && (item === undefined || checks[key](item)));
  const parkingFields = fields({ available: boolean, monthlyYen: nullable(number), distanceM: nullable(number), raw: text,
    location: nullable((v) => v === "onsite" || v === "nearby") });
  const parking: Check = (v) => object(v) && ["available", "monthlyYen", "distanceM", "raw", "location"].every((key) => v[key] !== undefined) && parkingFields(v);
  const costs = fields(Object.fromEntries([
    ...["depositYen", "keyMoneyYen", "cleaningFeeYen", "adminFeeYen", "parkingYen", "renewalFeeYen", "oneOffFeesYen", "monthlyExtrasYen"].map((key) => [key, nullable(number)] as const),
    ["parking", nullable(parking)], ["guarantorRequired", nullable(boolean)], ["feeNotes", nullable(text)],
  ]));
  const tenancy = fields({ leaseType: nullable((v) => v === "regular" || v === "fixed-term"), leaseMonths: nullable(number),
    availableFrom: nullable(text), immediateMoveIn: nullable(boolean) });
  const building = fields({ floor: nullable(text), totalFloors: nullable(number), structure: nullable(text),
    features: nullable(texts), conditions: nullable(texts) });
  const check = fields({ parking: nullable(parking), costs, tenancy, building,
    sourceDetails: (v) => object(v) && Object.keys(v).length > 0 && Object.values(v).every(text) });
  if (!check(value)) throw new InvalidScrapeBatchError("Invalid or forbidden detail patch fields");
}
