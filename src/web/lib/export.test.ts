import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../domain/scoringConfig";
import { scoreListing } from "../../domain/scoring";
import { listingKey } from "../../domain/listingKey";
import type { EnrichedListing } from "../../domain/types";
import { toCsv, toMarkdown } from "./export";

const listing: EnrichedListing = {
  name: "Noted | Home",
  address: "埼玉県草加市",
  rent: 80_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2010,
  stationWalkMin: 8,
  url: null,
  source: "test",
  geocoded: true,
};
const rows = [{ listing, score: scoreListing(listing, DEFAULT_CONFIG) }];
const notes = { [listingKey(listing)]: { text: "Damp bathroom\nask about 更新料", viewingAt: "2026-10-05T14:00", updatedAt: "" } };

describe("export", () => {
  it("adds the note, on one line, beside the decision mark", () => {
    const [header, line] = toCsv(rows, {}, notes).split("\n");
    const columns = header.split(",");
    expect(columns.indexOf("note")).toBe(columns.indexOf("decision_mark") + 1);
    expect(line).toContain("Viewing Mon 5 Oct 14:00 — Damp bathroom / ask about 更新料");
  });

  it("leaves the note empty when there is none", () => {
    const line = toCsv(rows).split("\n")[1];
    expect(line.split(",")[4]).toBe("");
  });

  it("escapes pipes so Markdown cells stay in their columns", () => {
    const body = toMarkdown(rows, {}, notes).split("\n")[2];
    expect(body).toContain("Noted \\| Home");
  });
});
