import { describe, expect, it } from "vitest";
import { buildPlaceCatalog, type ReferencePlace } from "./places";
import { urEstateNearby } from "./urEstateNearby";
import { urEstateNameEn } from "./urEstateNames";

const place = (id: string, category: string, name: string, lat: number, lon: number, attributes: ReferencePlace["attributes"] = {}): ReferencePlace =>
  ({ id, category, name, lat, lon, attributes });

const estate = { lat: 35.843, lon: 139.8 };

describe("UR estate surroundings", () => {
  const catalog = buildPlaceCatalog([
    place("m1", "mosque", "Far Mosque", 35.9, 139.8),
    place("m2", "mosque", "Near Mosque", 35.85, 139.8),
    place("p1", "poi", "Al Sanad School Japan", 35.846, 139.7767),
    place("s1", "station", "草加", 35.828, 139.803, { nameEn: "Soka" }),
    // The rail-station twin of a curated station borrows its English name.
    place("r1", "railStation", "草加", 35.8281, 139.8031),
    place("r2", "railStation", "松原団地", 35.8435, 139.8002),
    place("k1", "childcare", "Far Daycare", 36.5, 139.8, { facilityType: "hoikuen" }),
    place("k2", "childcare", "Kinder", 35.844, 139.8, { facilityType: "kindergarten" }),
    place("b1", "busStop", "Remote stop", 36.0, 139.8),
  ]);

  it("measures the nearest of each kind", () => {
    const near = urEstateNearby(estate, catalog);
    expect(near.mosque).toMatchObject({ name: "Near Mosque", distM: 778 });
    expect(near.privateSchool?.name).toBe("Al Sanad School Japan");
    expect(near.station).toMatchObject({ name: "松原団地" });
    expect(near.kindergarten?.name).toBe("Kinder");
    expect(near.mosque!.walkMin).toBe(12.6);
  });

  it("names a curated station in English", () => {
    const near = urEstateNearby({ lat: 35.828, lon: 139.803 }, catalog);
    expect(near.station).toMatchObject({ name: "草加", nameEn: "Soka" });
  });

  it("leaves out schools, kindergartens and bus stops beyond the area they were collected for", () => {
    const near = urEstateNearby(estate, catalog);
    expect(near.school).toBeNull();
    expect(near.busStop).toBeNull();
  });
});

describe("UR estate English names", () => {
  it("names an estate by its UR code", () => {
    expect(urEstateNameEn("50_4090")).toBe("Comfort Matsubara");
    expect(urEstateNameEn("00_0000")).toBeNull();
    expect(urEstateNameEn(null)).toBeNull();
  });
});
