import { describe, expect, it } from "vitest";
import { extractParkingCell, parseParking } from "./backfill-parking";

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

  it("does not mistake the distance for the price", () => {
    // "143m" must not be read as ¥143.
    expect(parseParking("近隣143m9592円").monthlyYen).toBe(9592);
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

describe("extractParkingCell", () => {
  it("pulls the 駐車場 cell out of a spec table", () => {
    const html = `
      <table>
        <tr><th>損保</th><td>要</td></tr>
        <tr><th>駐車場</th><td>近隣143m9592円</td></tr>
        <tr><th>入居</th><td>即</td></tr>
      </table>`;
    expect(extractParkingCell(html)).toBe("近隣143m9592円");
  });

  it("returns null when the page has no 駐車場 row", () => {
    expect(extractParkingCell("<table><tr><th>損保</th><td>要</td></tr></table>")).toBeNull();
  });
});
