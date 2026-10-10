import { describe, expect, it } from "vitest";
import { lastResultsPage } from "./resultPages";
import type { PageCapture } from "./captureStore";

const capture = (source: PageCapture["source"], page: number, html: string): PageCapture =>
  ({ schemaVersion: 1, source, city: "Katsushika", url: "https://example.invalid/", page, capturedAt: "2026-10-10T00:00:00.000Z", httpStatus: 200, html });
const cards = (selector: string, count: number) => Array.from({ length: count }, () => selector).join("");

describe("lastResultsPage", () => {
  it("reads a short RoomSpot or AtHome page as the city's last", () => {
    expect(lastResultsPage(capture("roomspot", 1, cards('<article class="data"></article>', 22)))).toBe(1);
    expect(lastResultsPage(capture("roomspot", 3, cards('<article class="data"></article>', 30)))).toBeUndefined();
    expect(lastResultsPage(capture("athome", 4, cards('<div class="p-property"></div>', 7)))).toBe(4);
    expect(lastResultsPage(capture("athome", 4, cards('<div class="p-property"></div>', 30)))).toBeUndefined();
  });

  it("reads SUUMO's last numbered page, wherever the current page is", () => {
    // As SUUMO printed Katsushika page 1 on 2026-10-04 (trimmed).
    const first = '<p class="pagination-parts"><a href="?page=2">次へ</a></p><ol class="pagination-parts"><li class="pagination-current">1</li>' +
      '<li>&nbsp;</li><li><a href="?page=2">2</a></li><li><a href="?page=3">3</a></li><li>...</li><li><a href="?page=37">37</a></li></ol>';
    expect(lastResultsPage(capture("suumo", 1, first))).toBe(37);
    const last = '<ol class="pagination-parts"><li><a href="?page=1">1</a></li><li>...</li><li><a href="?page=36">36</a></li><li class="pagination-current">37</li></ol>';
    expect(lastResultsPage(capture("suumo", 37, last))).toBe(37);
    expect(lastResultsPage(capture("suumo", 1, '<div class="cassetteitem"></div>'))).toBeUndefined();
  });

  it("does not guess for Nifty", () => {
    expect(lastResultsPage(capture("nifty", 1, ""))).toBeUndefined();
  });
});
