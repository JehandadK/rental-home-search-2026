import { describe, expect, it } from "vitest";
import { listingPhotos, suumoPhotos } from "./listingPhotos";
import type { RawListing } from "./types";

const SUUMO = "https://suumo.jp/chintai/jnc_000108661952/?bc=100502889245";
const SUUMO_PADDED = "https://suumo.jp/chintai/jnc_000067921155/?bc=000078305405";
const ATHOME = "https://www.athome.co.jp/chintai/1132839134/?DOWN=1&BKLISTID=001LPC";

function listing(over: Partial<RawListing> = {}): RawListing {
  return {
    name: "Home", address: "埼玉県草加市金明町1", rent: 80000, layout: "2LDK", sizeM2: 50, builtYear: 2010,
    stationWalkMin: 5, url: SUUMO, source: "suumo",
    ...over,
  } as RawListing;
}

describe("suumoPhotos", () => {
  it("builds the exterior and floor-plan paths from the ad's property code", () => {
    expect(suumoPhotos(SUUMO)).toEqual([
      { url: "https://img01.suumo.com/front/gazo/fr/bukken/245/100502889245/100502889245_gw.jpg", kind: "exterior", source: "suumo" },
      { url: "https://img01.suumo.com/front/gazo/fr/bukken/245/100502889245/100502889245_co.jpg", kind: "floorPlan", source: "suumo" },
    ]);
  });
  it("drops the leading zeros SUUMO prints in ad URLs but not in image paths", () => {
    expect(suumoPhotos(SUUMO_PADDED)[1].url).toBe(
      "https://img01.suumo.com/front/gazo/fr/bukken/405/78305405/78305405_co.jpg",
    );
  });
  it("returns nothing for URLs without a property code", () => {
    expect(suumoPhotos("https://suumo.jp/chintai/jnc_000108661952/")).toEqual([]);
    expect(suumoPhotos(null)).toEqual([]);
  });
});

describe("listingPhotos", () => {
  it("lists every exterior before any floor plan, preferred ad first", () => {
    const second = "https://suumo.jp/chintai/jnc_000108656513/?bc=100502993608";
    const photos = listingPhotos(listing({
      sourceListings: [{ source: "suumo", url: SUUMO }, { source: "suumo", url: second }, { source: "athome", url: ATHOME }],
    }));
    expect(photos.map(({ kind, url }) => `${kind}:${url.slice(-16)}`)).toEqual([
      "exterior:502889245_gw.jpg",
      "exterior:502993608_gw.jpg",
      "floorPlan:502889245_co.jpg",
      "floorPlan:502993608_co.jpg",
    ]);
  });
  it("falls back to the listing's own URL and de-duplicates repeated ads", () => {
    expect(listingPhotos(listing())).toHaveLength(2);
    expect(listingPhotos(listing({ sourceListings: [{ source: "suumo", url: SUUMO }, { source: "suumo", url: `${SUUMO}&utm=x` }] }))).toHaveLength(2);
  });
  it("has no photos for portals whose ad URLs carry no image path", () => {
    expect(listingPhotos(listing({ source: "athome", url: ATHOME }))).toEqual([]);
  });
  it("uses collected photos, ordered exterior → photo → floor plan, before derived ones", () => {
    const photos = listingPhotos(listing({
      sourceListings: [{ source: "athome", url: ATHOME }, { source: "suumo", url: SUUMO }],
      photos: [
        { url: "https://www.athome.co.jp/image_files/path/plan", kind: "floorPlan", source: "athome" },
        { url: "https://www.athome.co.jp/image_files/path/room", kind: "photo", source: "athome" },
        { url: "https://property.es-img.jp/rent/img/1/1_10.jpg", kind: "exterior", source: "roomspot" },
      ],
    }));
    expect(photos.map(({ kind, source }) => `${kind}:${source}`)).toEqual([
      "exterior:roomspot", "exterior:suumo", "photo:athome", "floorPlan:athome", "floorPlan:suumo",
    ]);
  });
});
