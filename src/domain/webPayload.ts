import type { EnrichedListing, ListingAttribute } from "./types";

type PackedListing = Omit<EnrichedListing, "attributes"> & { attributeIds: number[] };

/** The original layout: attributes repeated their verbatim source text. Still read, no longer written. */
export interface WebPayloadV2 {
  schemaVersion: 2;
  attributes: ListingAttribute[];
  listings: PackedListing[];
}

export interface WebPayload {
  schemaVersion: 3;
  /** Each verbatim source text once: a listing's attributes often share one long description. */
  texts: string[];
  attributes: Array<Omit<ListingAttribute, "raw"> & { rawId: number }>;
  listings: PackedListing[];
}

/** Dictionary-encode repeated bilingual attributes and their source texts once; lossless round trip. */
export function packListings(listings: readonly EnrichedListing[]): WebPayload {
  const texts: string[] = [];
  const textIds = new Map<string, number>();
  const attributes: WebPayload["attributes"] = [];
  const ids = new Map<string, number>();
  const textId = (text: string) => {
    let id = textIds.get(text);
    if (id === undefined) { id = texts.length; texts.push(text); textIds.set(text, id); }
    return id;
  };
  return {
    schemaVersion: 3, texts, attributes,
    listings: listings.map(({ attributes: items, ...listing }) => ({
      ...listing,
      attributeIds: (items ?? []).map(({ raw, ...item }) => {
        const packed = { ...item, rawId: textId(raw) };
        const key = JSON.stringify(packed);
        let id = ids.get(key);
        if (id === undefined) { id = attributes.length; attributes.push(packed); ids.set(key, id); }
        return id;
      }),
    })),
  };
}

export function unpackListings(payload: WebPayload | WebPayloadV2 | EnrichedListing[]): EnrichedListing[] {
  if (Array.isArray(payload)) return payload;
  if (payload.schemaVersion !== 2 && payload.schemaVersion !== 3) throw new Error("Unsupported listing payload");
  const attributes: ListingAttribute[] = payload.schemaVersion === 2
    ? payload.attributes
    : payload.attributes.map(({ rawId, ...attribute }) => {
      const raw = payload.texts[rawId];
      if (raw === undefined) throw new Error(`Invalid text ID: ${rawId}`);
      return { ...attribute, raw };
    });
  return payload.listings.map(({ attributeIds, ...listing }) => ({
    ...listing,
    attributes: attributeIds.map((id) => {
      if (!attributes[id]) throw new Error(`Invalid attribute ID: ${id}`);
      return attributes[id];
    }),
  }));
}
