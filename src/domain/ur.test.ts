import { describe, expect, it } from "vitest";
import { isUrListing } from "./ur";

describe("isUrListing", () => {
  it("knows UR's own ads and portal ads named for UR", () => {
    expect(isUrListing({ source: "ur", name: "コンフォール松原" })).toBe(true);
    expect(isUrListing({ source: "suumo", name: "ＵＲコンフォール松原" })).toBe(true);
    expect(isUrListing({ source: "athome", name: "URせんげん台パークタウン三番街 0-03-0008-0401" })).toBe(true);
    expect(isUrListing({ source: "suumo", name: "x", sourceListings: [{ source: "ur", id: "1", url: null }] })).toBe(true);
  });

  it("does not take a name that merely starts with the letters", () => {
    expect(isUrListing({ source: "suumo", name: "URBAN HOUSE" })).toBe(false);
    expect(isUrListing({ source: "suumo", name: "ユーアール" })).toBe(false);
    expect(isUrListing({ source: "suumo", name: "コンフォール松原" })).toBe(false);
  });
});
