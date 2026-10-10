// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomspotBrowser } from "./roomspotBrowser";
import { EndOfResultsError } from "../shared/resultPages";

const bridge = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn(), close: vi.fn() }));
vi.mock("../shared/browserBridge", () => ({
  createBridge: () => ({ connect: bridge.connect, request: bridge.request, close: bridge.close }),
}));

const SEARCH = "https://www.roomspot.net/rent/search/area/pref_13/city_122/?ftlsflg=1";
const card = (id: number) => `<article class="data" data-x="1"><h2>テストハイツ${id}</h2><script>track()</script>` +
  `<table class="room_data"><tbody><tr><td><a href="/rent/${id}" onclick="x()">201</a></td></tr></tbody></table></article>`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let respond: (url: string) => Response;
/** Runs the adapter's in-page script in a DOM, reporting a throw as the Playwright bridge does. */
async function evaluateInPage(expression: string) {
  const page = { localize: { restRoute: "https://www.roomspot.net/wp-json/roomspot/v1/search", searchParams: { address: ["東京都葛飾区"] } } };
  try {
    const run = new Function("window", "fetch", `return ${expression};`);
    return { result: { result: { value: await run(page, async (url: string) => respond(String(url))) } } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: { exceptionDetails: { text: message, exception: { description: `Error: ${message}` } } } };
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  bridge.connect.mockResolvedValue(undefined);
  bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "new_tab") return { tab: { id: 3 }, httpStatus: 200 };
    if (method === "evaluate") return evaluateInPage(String(params.expression));
    throw new Error(`Unexpected Bridge method: ${method}`);
  });
});

async function browserAt(): Promise<RoomspotBrowser> {
  const browser = new RoomspotBrowser();
  await browser.connect(SEARCH);
  return browser;
}

describe("RoomSpot result pages", () => {
  it("requests 30 newest cards per page and returns them without scripts or tracking attributes", async () => {
    let requested = "";
    respond = (url) => { requested = url; return json({ html: card(1) + card(2) }); };
    const html = await (await browserAt()).fetchPage(1);
    expect(new URL(requested).searchParams.get("item_per_page")).toBe("30");
    expect(new URL(requested).searchParams.get("page_num")).toBe("1");
    expect(html).toBe('<article class="data"><h2>テストハイツ1</h2><table class="room_data"><tbody><tr><td><a href="/rent/1">201</a></td></tr></tbody></table></article>' +
      '<article class="data"><h2>テストハイツ2</h2><table class="room_data"><tbody><tr><td><a href="/rent/2">201</a></td></tr></tbody></table></article>');
  });

  it.each([
    ["empty results HTML", () => json({ html: "" })],
    ["missing results HTML", () => json({ found: 0 })],
    ["a results page without cards", () => json({ html: "<p>該当する物件がありません</p>" })],
    ["an HTTP 404", () => new Response("Not Found", { status: 404 })],
  ])("treats %s past page 1 as the end of results", async (_, response) => {
    respond = response;
    await expect((await browserAt()).fetchPage(2)).rejects.toBeInstanceOf(EndOfResultsError);
  });

  it.each([
    ["no cards on page 1", 1, () => json({ html: "<p>該当する物件がありません</p>" }), "no property cards; not verified exhaustion"],
    ["empty HTML on page 1", 1, () => json({ html: "" }), "no results HTML"],
    ["a block page", 2, () => new Response("<html><title>Access denied</title></html>", { status: 403 }), "HTTP 403 returned no JSON"],
    ["a verification page", 2, () => new Response("<html><title>確認</title></html>", { status: 200 }), "HTTP 200 returned no JSON"],
    ["rate limiting", 2, () => json({ message: "slow down" }, 429), "RoomSpot REST HTTP 429"],
    ["a REST error object", 2, () => json({ code: "rest_busy", message: "slow down" }), "no results HTML"],
  ])("still fails on %s, with the in-page reason", async (_, page, response, message) => {
    respond = response;
    const failure = (await browserAt()).fetchPage(page);
    await expect(failure).rejects.toThrow(`RoomSpot capture stopped on page ${page}: Error: `);
    await expect((await browserAt()).fetchPage(page)).rejects.toThrow(message);
    await expect(failure).rejects.not.toBeInstanceOf(EndOfResultsError);
  });

  it("reports a missing evaluation value as no response HTML", async () => {
    bridge.request.mockImplementation(async (method: string) => method === "new_tab" ? { tab: { id: 3 } } : { result: {} });
    await expect((await browserAt()).fetchPage(2)).rejects.toThrow("RoomSpot returned no response HTML");
  });
});
