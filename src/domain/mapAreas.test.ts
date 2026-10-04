import { describe, expect, it } from "vitest";
import { cityName, defaultAreas, groupByPrefecture, listingAreas, shownAreas, matchesCity, prefectureName, prefectureSelection, setPrefecture, toggleCity } from "./mapAreas";
import type { ReferenceCity } from "./referenceData";

const city = (id: string, name: string, nameLocal: string, prefecture: string, prefectureEn: string, code: string): ReferenceCity =>
  ({ id, name, nameLocal, prefecture, prefectureEn, code });
const cities = [
  city("city:adachi", "Adachi", "足立区", "東京都", "Tokyo", "13121"),
  city("city:soka", "Soka", "草加市", "埼玉県", "Saitama", "11221"),
  city("city:jp-11108", "Saitama Minami-ku", "さいたま市南区", "埼玉県", "Saitama", "11108"),
];

describe("map areas", () => {
  const groups = groupByPrefecture(cities);

  it("groups cities by prefecture in code order", () => {
    expect(groups.map((group) => [group.name, group.nameEn, group.cities.map((c) => c.id)])).toEqual([
      ["埼玉県", "Saitama", ["city:jp-11108", "city:soka"]],
      ["東京都", "Tokyo", ["city:adachi"]],
    ]);
  });

  it("names cities and prefectures in either language", () => {
    expect(cityName(cities[1], "en")).toBe("Soka");
    expect(cityName(cities[1], "ja")).toBe("草加市");
    expect(prefectureName(groups[0], "en")).toBe("Saitama");
    expect(prefectureName(groups[0], "ja")).toBe("埼玉県");
  });

  it("defaults to the cities the listings are in, plus context neighbours the reference has", () => {
    const withListings = listingAreas(cities, ["Soka", "Saitama Minami-ku", "Soka"]);
    expect([...defaultAreas(cities, withListings)].sort()).toEqual(["city:adachi", "city:jp-11108", "city:soka"]);
    expect([...defaultAreas(cities)]).toEqual(["city:adachi"]);
    expect([...defaultAreas([cities[2]])]).toEqual(["city:jp-11108"]);
  });

  it("always draws the cities of the listings on show, on top of the default or a saved choice", () => {
    const katsushika = city("city:jp-13122", "Katsushika", "葛飾区", "東京都", "Tokyo", "13122");
    const all = [...cities, katsushika];
    const withListings = new Set(["city:soka", "city:jp-13122"]);
    // Nothing saved: the default already covers every city with listings.
    expect([...shownAreas(all, null, withListings, new Set(["city:jp-13122"]))].sort()).toEqual(["city:adachi", "city:jp-13122", "city:soka"]);
    // A choice saved before Katsushika existed still draws it while its listings show, and drops unknown ids.
    expect([...shownAreas(all, ["city:soka", "city:gone"], withListings, new Set(["city:soka", "city:jp-13122"]))].sort()).toEqual(["city:jp-13122", "city:soka"]);
    // Filtering Katsushika out lets a saved choice hide it again.
    expect([...shownAreas(all, ["city:soka"], withListings, new Set(["city:soka"]))]).toEqual(["city:soka"]);
  });

  it("finds a listing's city by its English name, skipping unnamed or unknown ones", () => {
    const katsushika = city("city:jp-13122", "Katsushika", "葛飾区", "東京都", "Tokyo", "13122");
    expect([...listingAreas([...cities, katsushika], ["Katsushika", undefined, null, "Atlantis", "Soka"])].sort())
      .toEqual(["city:jp-13122", "city:soka"]);
  });

  it("selects cities one at a time or a whole prefecture", () => {
    const saitama = groups[0];
    let selected: ReadonlySet<string> = new Set(["city:soka"]);
    expect(prefectureSelection(saitama, selected)).toBe("some");
    selected = setPrefecture(selected, saitama, true);
    expect(prefectureSelection(saitama, selected)).toBe("all");
    selected = toggleCity(selected, "city:soka");
    expect([...selected]).toEqual(["city:jp-11108"]);
    expect(prefectureSelection(saitama, setPrefecture(selected, saitama, false))).toBe("none");
  });

  it("finds cities by either name or their prefecture", () => {
    expect(matchesCity(cities[1], groups[0], "soka")).toBe(true);
    expect(matchesCity(cities[1], groups[0], "草加")).toBe(true);
    expect(matchesCity(cities[0], groups[1], "tokyo")).toBe(true);
    expect(matchesCity(cities[0], groups[1], "soka")).toBe(false);
  });
});
