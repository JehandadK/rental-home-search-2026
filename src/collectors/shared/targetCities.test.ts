import { describe, expect, it } from "vitest";
import { TARGET_CITIES, cityForAddress, selectCities, withPrefecture } from "./targetCities";

describe("target cities", () => {
  it("keeps one entry per city with unique portal identifiers", () => {
    for (const key of ["label", "code", "suumo", "athome", "nifty"] as const) {
      expect(new Set(TARGET_CITIES.map((city) => city[key])).size).toBe(TARGET_CITIES.length);
    }
    expect(TARGET_CITIES.every((city) => city.code.startsWith(city.prefecture === "東京都" ? "13" : "11"))).toBe(true);
  });

  it("recognises a city from an address with or without its prefecture", () => {
    expect(cityForAddress("東京都葛飾区高砂7丁目14-24")?.label).toBe("Katsushika");
    expect(cityForAddress("葛飾区お花茶屋3")?.label).toBe("Katsushika");
    expect(cityForAddress("埼玉県越谷市蒲生1")?.label).toBe("Koshigaya");
    expect(cityForAddress("東京都足立区千住1")).toBeUndefined();
  });

  it("adds the searched city's prefecture only when the portal left it out", () => {
    expect(withPrefecture("葛飾区高砂7丁目", "Katsushika")).toBe("東京都葛飾区高砂7丁目");
    expect(withPrefecture("草加市金明町", "Soka")).toBe("埼玉県草加市金明町");
    expect(withPrefecture("東京都葛飾区高砂7丁目", "Katsushika")).toBe("東京都葛飾区高砂7丁目");
  });

  it("scopes to one city with --city and rejects an unknown one", () => {
    expect(selectCities([], TARGET_CITIES, (city) => city.label)).toHaveLength(TARGET_CITIES.length);
    expect(selectCities(["--city", "Katsushika"], TARGET_CITIES, (city) => city.label).map((city) => city.suumo)).toEqual(["sc_katsushika"]);
    expect(() => selectCities(["--city", "Adachi"], TARGET_CITIES, (city) => city.label)).toThrow("Unknown --city Adachi");
  });
});
