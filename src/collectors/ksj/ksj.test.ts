import { describe, expect, it } from "vitest";
import type { Position } from "../../domain/referenceData";
import { ringAreaKm2, simplifyShared, type Polygon } from "./topology";
import { importMunicipalities, type N03Feature } from "./municipalities";
import { importStations, type N02StationFeature } from "./stations";

/** A wiggly line from (x0, y0) to (x1, y1) with `n` small zigzags (amplitude in degrees). */
function wiggle(from: Position, to: Position, n: number, amplitude: number): Position[] {
  const points: Position[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const offset = i % 2 === 0 || i === n ? 0 : amplitude;
    points.push([from[0] + (to[0] - from[0]) * t + offset, from[1] + (to[1] - from[1]) * t]);
  }
  return points;
}

/** Two cells side by side sharing a wiggly border at lon 1, from (1,0) up to (1,1). */
function neighbours(): { west: Polygon; east: Polygon; border: Position[] } {
  const border = wiggle([1, 0], [1, 1], 40, 0.00001);
  const west: Polygon = [[[0, 0], ...border, [0, 1], [0, 0]]];
  const east: Polygon = [[...[...border].reverse(), [2, 0], [2, 1], [1, 1]]];
  return { west, east, border };
}

const edgesOf = (polygons: readonly Polygon[]) => new Set(polygons.flatMap((polygon) => polygon.flatMap((ring) =>
  ring.slice(1).map((point, i) => [ring[i], point].map((p) => p.join(",")).sort().join("|")))));

describe("topology-preserving simplification", () => {
  it("simplifies a shared border identically on both sides", () => {
    const { west, east } = neighbours();
    const result = simplifyShared([{ key: "w", polygons: [west] }, { key: "e", polygons: [east] }], { tolerance: 0.0001, precision: 6 });
    const w = result.get("w")!;
    const e = result.get("e")!;
    // The 40 zigzags collapse to a straight border...
    expect(w[0][0].length).toBeLessThan(10);
    // ...and both cells keep exactly the same border edges.
    const shared = [...edgesOf(w)].filter((edge) => edgesOf(e).has(edge));
    expect(shared).toEqual([["1,0", "1,1"].join("|")]);
  });

  it("keeps the vertices of a border it cannot straighten the same on both sides", () => {
    const border = wiggle([1, 0], [1, 1], 41, 0.0005).map(([lon, lat], i): Position => [lon + (i % 3) * 0.0002, lat]);
    border[border.length - 1] = [1, 1];
    const west: Polygon = [[[0, 0], ...border, [0, 1], [0, 0]]];
    const east: Polygon = [[...[...border].reverse(), [2, 0], [2, 1], [1, 1]]];
    const result = simplifyShared([{ key: "w", polygons: [west] }, { key: "e", polygons: [east] }], { tolerance: 0.0003, precision: 6 });
    const onBorder = (polygons: readonly Polygon[]) =>
      [...edgesOf(polygons)].filter((edge) => edge.split("|").every((point) => Math.abs(Number(point.split(",")[0]) - 1) < 0.01));
    const w = onBorder(result.get("w")!);
    expect(w.length).toBeGreaterThan(5);
    expect(w.length).toBeLessThan(41);
    expect(new Set(onBorder(result.get("e")!))).toEqual(new Set(w));
  });

  it("keeps an enclave and its hole identical, and drops small islands", () => {
    const outer: Polygon = [
      [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
      wiggle([0.4, 0.4], [0.6, 0.4], 30, 0.000001).concat([[0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]),
    ];
    const enclave: Polygon = [[...outer[1]].reverse()];
    const islet: Polygon = [[[5, 5], [5.001, 5], [5.001, 5.001], [5, 5.001], [5, 5]]];
    const result = simplifyShared(
      [{ key: "outer", polygons: [outer] }, { key: "enclave", polygons: [enclave] }, { key: "islet", polygons: [islet] }],
      { tolerance: 0.0001, precision: 6, minIslandAreaKm2: 0.05 },
    );
    const hole = result.get("outer")![0][1];
    const inner = result.get("enclave")![0][0];
    expect(edgesOf([[hole]])).toEqual(edgesOf([[inner]]));
    expect(result.get("islet")).toEqual([]);
    expect(ringAreaKm2(islet[0])).toBeLessThan(0.05);
  });
});

const n03 = (code: string | null, municipality: string, ward: string | null, coordinates: Polygon, prefecture = "埼玉県"): N03Feature => ({
  type: "Feature",
  properties: { N03_001: prefecture, N03_003: null, N03_004: municipality, N03_005: ward, N03_007: code },
  geometry: { type: "Polygon", coordinates },
});
const box = (lon: number, lat: number, size = 0.1): Polygon =>
  [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]];

describe("N03 municipalities", () => {
  it("joins pieces by code, names wards, and leaves out remote islands and unassigned land", () => {
    const { municipalities, skipped } = importMunicipalities([{
      type: "FeatureCollection",
      features: [
        n03("11221", "草加市", null, box(139.8, 35.8)),
        n03("11221", "草加市", null, box(139.95, 35.8)),
        n03("11108", "さいたま市", "南区", box(139.6, 35.8)),
        n03("13421", "小笠原村", null, box(142.2, 27.1), "東京都"),
        n03("13000", "所属未定地", null, box(139.8, 35.6), "東京都"),
      ],
    }], { tolerance: 0.0002, precision: 5 });
    expect(municipalities.map((m) => [m.code, m.name, m.geometry.type])).toEqual([
      ["11108", "さいたま市南区", "Polygon"],
      ["11221", "草加市", "MultiPolygon"],
    ]);
    expect(skipped.map((entry) => entry.reason)).toEqual(["remote island", "not assigned to a municipality"]);
  });
});

const platform = (group: string, name: string, operator: string, line: string, [lon, lat]: Position): N02StationFeature => ({
  type: "Feature",
  properties: { N02_001: "12", N02_002: "5", N02_003: line, N02_004: operator, N02_005: name, N02_005g: group },
  geometry: { type: "LineString", coordinates: [[lon - 0.001, lat], [lon + 0.001, lat]] },
});

describe("N02 stations", () => {
  const areas = [{ key: "11221", geometry: { type: "Polygon" as const, coordinates: box(139.78, 35.8, 0.06) } }];

  it("makes one station per group, inside the given areas", () => {
    const stations = importStations({
      type: "FeatureCollection",
      features: [
        platform("003040", "草加", "東武鉄道", "伊勢崎線", [139.8034, 35.8283]),
        platform("003050", "谷塚", "東武鉄道", "伊勢崎線", [139.8011, 35.8142]),
        platform("003050", "谷塚", "東武鉄道", "伊勢崎線", [139.8013, 35.8144]),
        platform("009999", "遠く", "東日本旅客鉄道", "東北線", [140.5, 36.5]),
      ],
    }, areas);
    expect(stations.map((s) => [s.name, s.area, s.lines.length])).toEqual([["草加", "11221", 1], ["谷塚", "11221", 1]]);
    expect(stations[1].lon).toBeCloseTo(139.8012, 4);
  });

  it("joins a station just off the boundary (over water) to the nearest area", () => {
    const [station] = importStations({
      type: "FeatureCollection",
      features: [platform("004000", "運河", "東京モノレール", "東京モノレール羽田線", [139.8415, 35.83])],
    }, areas);
    expect(station?.area).toBe("11221");
  });
});
