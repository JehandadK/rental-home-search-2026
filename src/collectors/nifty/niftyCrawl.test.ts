import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageCapture } from "../shared/captureStore";
import { EndOfResultsError } from "../shared/resultPages";
import { asEndOfResults, crawlNiftyCity, NIFTY_NOT_FOUND } from "./niftyCrawl";
import { niftyCaptureExpression } from "./niftyCapture";

const capture = (page: number): PageCapture => ({ schemaVersion: 1, source: "nifty", city: "Koshigaya", page, url: `u${page}`,
  capturedAt: "2026-10-12T11:28:48.705Z", httpStatus: 200, html: "" });

function harness(pages: Array<{ novel: number } | Error>) {
  const log = vi.fn();
  const dependencies = {
    page: vi.fn(async (page: number) => { const entry = pages[page - 1]; if (entry instanceof Error || !entry) throw entry ?? new Error("unexpected page"); return capture(page); }),
    ingest: vi.fn(async (c: PageCapture) => ({ parsedCount: 40, novel: (pages[c.page - 1] as { novel: number }).novel, added: (pages[c.page - 1] as { novel: number }).novel })),
    sleep: vi.fn(async () => {}),
    log,
  };
  return dependencies;
}

describe("Nifty city crawl", () => {
  it("ends a city on Nifty's not-found page past its last page, keeping every page read", async () => {
    const deps = harness([{ novel: 30 }, { novel: 12 }, asEndOfResults(new Error(NIFTY_NOT_FOUND), 3) as Error]);
    await expect(crawlNiftyCity({ limit: 100, deep: false }, deps)).resolves.toEqual({ added: 42, pages: 2, end: "end-of-results" });
    expect(deps.ingest).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith("  page 3: no results; end of the city's results");
  });

  it("still stops after two all-known pages", async () => {
    const deps = harness([{ novel: 3 }, { novel: 0 }, { novel: 0 }, { novel: 9 }]);
    await expect(crawlNiftyCity({ limit: 100, deep: false }, deps)).resolves.toMatchObject({ pages: 3, end: "overlap" });
  });

  it("fails on a missing page 1 and on any other error past it", async () => {
    await expect(crawlNiftyCity({ limit: 100, deep: false }, harness([new EndOfResultsError("none")]))).rejects.toThrow("none");
    await expect(crawlNiftyCity({ limit: 100, deep: false }, harness([{ novel: 5 }, new Error("Nifty HTTP 503")]))).rejects.toThrow("Nifty HTTP 503");
  });

  it("maps only the not-found message to the end of results", () => {
    expect(asEndOfResults(new Error(`page.evaluate: Error: ${NIFTY_NOT_FOUND}`), 8)).toBeInstanceOf(EndOfResultsError);
    const other = new Error("Nifty HTTP 404");
    expect(asEndOfResults(other, 8)).toBe(other);
  });
});

describe("Nifty capture expression", () => {
  afterEach(() => vi.unstubAllGlobals());
  const run = async (status: number, body: string) => {
    vi.stubGlobal("location", { href: "https://myhome.nifty.com/rent/saitama/koshigayashi_ct/?sort=regDate-desc&r10=60" });
    vi.stubGlobal("document", {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ status, ok: status < 400, text: async () => body })));
    return (0, eval)(niftyCaptureExpression("https://myhome.nifty.com/rent/saitama/koshigayashi_ct/8/?sort=regDate-desc&r10=60"));
  };

  it("reports Nifty's not-found page distinctly from other failures", async () => {
    await expect(run(404, "<title>ページが見つかりません。ニフティ不動産</title>")).rejects.toThrow(NIFTY_NOT_FOUND);
    await expect(run(404, "<title>Blocked</title>")).rejects.toThrow("Nifty HTTP 404");
    await expect(run(503, "busy")).rejects.toThrow("Nifty HTTP 503");
  });
});
