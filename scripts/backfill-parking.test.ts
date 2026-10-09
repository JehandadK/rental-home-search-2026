import { describe, expect, it } from "vitest";
import { parseParking } from "./backfill-parking";

describe("parseParking", () => {
  it("parses on-site paid parking", () => {
    const p = parseParking("敷地内6600円");
    expect(p).toMatchObject({
      monthlyYen: 6600,
      available: true,
      location: "onsite",
      distanceM: null,
    });
  });

  it("parses nearby parking with a distance", () => {
    const p = parseParking("近隣143m9592円");
    expect(p).toMatchObject({
      monthlyYen: 9592,
      available: true,
      location: "nearby",
      distanceM: 143,
    });
  });

  it("handles thousands separators", () => {
    expect(parseParking("敷地内11,000円").monthlyYen).toBe(11_000);
  });

  it("treats free parking as a real value, not missing data", () => {
    const p = parseParking("敷地内無料");
    expect(p.monthlyYen).toBe(0);
    expect(p.available).toBe(true);
    expect(p.location).toBe("onsite");
  });

  it("reports no parking for empty and dash cells", () => {
    for (const raw of ["-", "−", "ー", "", "  "]) {
      const p = parseParking(raw);
      expect(p.available).toBe(false);
      expect(p.monthlyYen).toBeNull();
    }
  });

  it("treats 空無 (no vacancy) as unavailable", () => {
    expect(parseParking("空無").available).toBe(false);
  });

  it("keeps the raw text for auditing", () => {
    expect(parseParking("敷地内7700円").raw).toBe("敷地内7700円");
  });
});
