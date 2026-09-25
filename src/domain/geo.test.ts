import { describe, expect, it } from "vitest";
import { estimateWalkMinutes, haversineM, nearestPlace, toProximity } from "./geo";

describe("haversineM", () => {
  it("returns 0 for identical points", () => {
    expect(haversineM({ lat: 35.83, lon: 139.8 }, { lat: 35.83, lon: 139.8 })).toBe(0);
  });

  it("computes a plausible distance between Soka station and Al Sanad School", () => {
    const soka = { lat: 35.828252, lon: 139.803362 };
    const alSanad = { lat: 35.846389, lon: 139.7767021 };
    const d = haversineM(soka, alSanad);
    expect(d).toBeGreaterThan(2900);
    expect(d).toBeLessThan(3300);
  });

  it("is symmetric", () => {
    const a = { lat: 35.85, lon: 139.79 };
    const b = { lat: 35.86, lon: 139.81 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 10);
  });
});

describe("estimateWalkMinutes", () => {
  it("applies the detour factor over walking speed", () => {
    // 800 m straight line × 1.3 detour ÷ 80 m/min = 13 min
    expect(estimateWalkMinutes(800, 80, 1.3)).toBeCloseTo(13, 10);
  });
});

describe("nearestPlace", () => {
  const places = [
    { name: "far", lat: 35.9, lon: 139.9 },
    { name: "near", lat: 35.801, lon: 139.801 },
    { name: "mid", lat: 35.85, lon: 139.85 },
  ];

  it("picks the closest place", () => {
    const result = nearestPlace({ lat: 35.8, lon: 139.8 }, places);
    expect(result?.place.name).toBe("near");
  });

  it("returns null for an empty list", () => {
    expect(nearestPlace({ lat: 35.8, lon: 139.8 }, [])).toBeNull();
  });
});

describe("toProximity", () => {
  it("rounds distance to metres and walk time to 0.1 min", () => {
    const p = toProximity(
      { lat: 35.8, lon: 139.8 },
      { name: "x", lat: 35.8, lon: 139.809 }, // ~820 m
      80,
      1.3,
    );
    expect(p.name).toBe("x");
    expect(Number.isInteger(p.distM)).toBe(true);
    expect(p.walkMin).toBeCloseTo(13.3, 0);
  });
});
