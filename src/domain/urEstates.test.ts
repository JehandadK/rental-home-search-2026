import { describe, expect, it } from "vitest";
import { buildPlaceCatalog, type ReferencePlace } from "./places";
import type { EnrichedListing } from "./types";
import { isVacant, urEstate, urEstateDetails, urEstateLabel, urVacancies } from "./urEstates";

const room = (id: string, rent: number, over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  id, name: "コンフォール松原", address: "埼玉県草加市松原1", rent, layout: "2DK", sizeM2: 45, builtYear: 1988,
  stationWalkMin: 8, url: null, source: "ur", geocoded: true, ...over,
});

const estate = (name: string, attributes: ReferencePlace["attributes"], vacancies = new Map()) =>
  urEstate(buildPlaceCatalog([{ id: `ur:${name}`, category: "urDanchi", name, lat: 35.84, lon: 139.8, attributes }]).places[0], vacancies);

describe("UR estate vacancies", () => {
  it("counts each estate's available UR rooms with their rent range, from ids, room URLs and merged ads", () => {
    const vacancies = urVacancies([
      room("ur-50_4090-000010701", 72_500),
      room("x", 68_000, { url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000020302" }),
      room("suumo-1", 70_000, { source: "suumo", sourceListings: [{ source: "ur", id: "ur-50_4090-000030303", url: null }] }),
      room("ur-50_4091-000010101", 80_000),
      // Neither a sold nor a rented-out room is a vacancy; a portal ad alone names no estate.
      room("ur-50_4090-000040404", 60_000, { status: "sold" }),
      room("ur-50_4090-000050505", 60_000, { sourceListings: [{ source: "ur", id: "ur-50_4090-000050505", url: null,
        availability: { state: "gone", checkedAt: "2026-10-09T00:00:00.000Z", evidence: "404", method: "probe" } }] }),
      room("suumo-2", 60_000, { source: "suumo", name: "ＵＲコンフォール松原" }),
    ]);
    expect(Object.fromEntries(vacancies)).toEqual({
      "50_4090": { count: 3, rentMin: 68_000, rentMax: 72_500 },
      "50_4091": { count: 1, rentMin: 80_000, rentMax: 80_000 },
    });
  });
});

describe("UR estates on the map", () => {
  const vacancies = new Map([["50_4090", { count: 2, rentMin: 68_000, rentMax: 72_500 }]]);
  const vacant = estate("コンフォール松原", { urCode: "50_4090", cityId: "city:soka", url: "https://www.ur-net.go.jp/x", floors: 11, structure: "SRC" }, vacancies);
  const none = estate("草加松原団地", { urCode: "50_0001", cityId: "city:soka" }, vacancies);

  it("names each estate with its vacancies", () => {
    expect(urEstateLabel(vacant)).toBe("UR コンフォール松原 · 空室2");
    expect(urEstateLabel(none)).toBe("UR 草加松原団地");
    expect(urEstateLabel(estate("ＵＲ川口芝園", {}))).toBe("ＵＲ川口芝園");
  });

  it("reads its code, city and buildings from the catalog attributes", () => {
    expect(vacant).toMatchObject({ code: "50_4090", cityId: "city:soka", url: "https://www.ur-net.go.jp/x", floors: 11, structure: "SRC" });
    expect(isVacant(vacant)).toBe(true);
    expect(isVacant(none)).toBe(false);
    expect(estate("x", { urCode: 50, cityId: "" })).toMatchObject({ code: null, cityId: null, vacancy: null });
  });

  it("describes the vacancies, their rents and the buildings for the hover card", () => {
    expect(urEstateDetails(vacant)).toEqual(["空室 2 family rooms", "Rent ¥68,000–¥72,500 incl. 共益費", "11 floors · SRC"]);
    expect(urEstateDetails(none)).toEqual(["No family-size room advertised"]);
  });
});
