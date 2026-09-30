import type { EnrichedListing, ListingAttribute } from "./types";
export interface WebPayload {
  schemaVersion: 2;
  attributes: ListingAttribute[];
  listings: Array<Omit<EnrichedListing, "attributes"> & { attributeIds: number[] }>;
}
/** Dictionary-encode repeated bilingual attributes once; lossless round trip. */
export function packListings(listings: readonly EnrichedListing[]): WebPayload {
  const attributes: ListingAttribute[] = [];
  const ids = new Map<string, number>();
  return {
    schemaVersion: 2, attributes,
    listings: listings.map(({ attributes: items, ...listing }) => ({
      ...listing,
      attributeIds: (items ?? []).map((item) => {
        const key = JSON.stringify(item);
        let id = ids.get(key);
        if (id === undefined) { id = attributes.length; ids.set(key, id); attributes.push(item); }
        return id;
      }),
    })),
  };
}
export function unpackListings(payload: WebPayload | EnrichedListing[]): EnrichedListing[] {
  if (Array.isArray(payload)) return payload;
  if (payload.schemaVersion !== 2) throw new Error("Unsupported listing payload");
  return payload.listings.map(({ attributeIds, ...listing }) => ({
    ...listing,
    attributes: attributeIds.map((id) => {
      if (!payload.attributes[id]) throw new Error(`Invalid attribute ID: ${id}`);
      return payload.attributes[id];
    }),
  }));
}
