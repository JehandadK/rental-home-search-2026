import { describe, expect, it } from "vitest";
import type { EnrichedListing, ListingAttribute } from "./types";
import { packListings, unpackListings, type WebPayloadV2 } from "./webPayload";

const attribute = (key: string, raw: string, state: boolean | null = true): ListingAttribute =>
  ({ key, category: "comfort", labelEn: key, labelJa: `日本語 ${key}`, state, raw });

const DESCRIPTION = "バス・トイレ別、フローリング、エアコン付、宅配ボックス、オートロック ".repeat(20);
const listing = (id: string, attributes: ListingAttribute[]) => ({ id, name: id, attributes }) as unknown as EnrichedListing;

describe("the web payload", () => {
  const listings = [
    listing("a", [attribute("flooring", DESCRIPTION), attribute("aircon", DESCRIPTION), attribute("floor", "3階", false)]),
    listing("b", [attribute("flooring", DESCRIPTION), attribute("floor", "11階", false)]),
    listing("c", []),
  ];

  it("round-trips losslessly through JSON", () => {
    expect(unpackListings(JSON.parse(JSON.stringify(packListings(listings))))).toEqual(listings);
  });

  it("writes a source text once, however many attributes carry it", () => {
    const packed = packListings(listings);
    expect(packed.schemaVersion).toBe(3);
    expect(packed.texts.filter((text) => text === DESCRIPTION)).toHaveLength(1);
    expect(JSON.stringify(packed).split(DESCRIPTION)).toHaveLength(2);
    // The same attribute with the same text is one entry, as before.
    expect(packed.attributes.filter((item) => item.key === "flooring")).toHaveLength(1);
  });

  it("still reads the earlier layout, which a cached or older published copy may use", () => {
    const v2: WebPayloadV2 = {
      schemaVersion: 2,
      attributes: [attribute("flooring", "x")],
      listings: [{ id: "a", name: "a", attributeIds: [0] } as unknown as WebPayloadV2["listings"][number]],
    };
    expect(unpackListings(v2)[0].attributes).toEqual([attribute("flooring", "x")]);
  });

  it("rejects ids that point nowhere, and layouts it does not know", () => {
    const packed = packListings(listings);
    expect(() => unpackListings({ ...packed, texts: [] })).toThrow(/Invalid text ID/);
    expect(() => unpackListings({ ...packed, listings: [{ ...packed.listings[0], attributeIds: [999] }] })).toThrow(/Invalid attribute ID: 999/);
    expect(() => unpackListings({ ...packed, schemaVersion: 9 } as never)).toThrow(/Unsupported listing payload/);
  });
});
