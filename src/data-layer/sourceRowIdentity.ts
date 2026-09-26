import type { RawListing } from "../types";
import type { SourceRowLocator } from "./contracts";

export function sourceRowLocator(listing: RawListing): SourceRowLocator {
  const sourceListingId = listing.id ?? listing.url;
  if (typeof sourceListingId !== "string" || !sourceListingId.trim()) throw new Error("Source row has no stable identity");
  return { sourceListingId, targetUrl: listing.url ?? null };
}

export function sourceRowKey(locator: SourceRowLocator): string {
  return JSON.stringify([locator.sourceListingId, locator.targetUrl]);
}

/** Fail closed on genuinely ambiguous locators; never silently drop rows in a Map. */
export function indexSourceRows(rows: readonly RawListing[]): Map<string, RawListing> {
  const index = new Map<string, RawListing>();
  for (const row of rows) {
    const key = sourceRowKey(sourceRowLocator(row));
    if (index.has(key)) throw new Error(`Ambiguous source ID/URL pair: ${key}`);
    index.set(key, row);
  }
  return index;
}
