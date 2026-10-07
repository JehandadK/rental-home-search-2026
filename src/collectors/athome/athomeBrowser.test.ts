import { beforeEach, describe, expect, it, vi } from "vitest";
import { AthomeBrowser } from "./athomeBrowser";

const bridge = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn(), close: vi.fn() }));
vi.mock("../shared/chromeBridge", () => ({
  createBridge: () => ({ connect: bridge.connect, request: bridge.request, close: bridge.close }),
}));

const HOME = "https://www.athome.co.jp/";
const SEARCH = "https://www.athome.co.jp/chintai/saitama/soka-city/list/?sort=33";
const NEXT_CITY = "https://www.athome.co.jp/chintai/saitama/koshigaya-city/list/";
const homeTab = { id: 17, url: HOME, tabFence: "tab:owned", incarnation: "homepage" };
const html = '<html><body><div class="p-property"></div></body></html>';

beforeEach(() => {
  vi.resetAllMocks();
  bridge.connect.mockResolvedValue(undefined);
  bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "new_tab") return { tab: homeTab };
    if (method === "navigate") return { tab: { ...homeTab, url: params.url, incarnation: String(params.url) } };
    if (method === "evaluate") return { result: { result: { value: html } } };
    if (method === "close_tab") return {};
    throw new Error(`Unexpected Bridge method: ${method}`);
  });
});

describe("AtHome homepage-first collection", () => {
  it("opens only the homepage, then navigates the same tab with the original filters", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    expect(bridge.request.mock.calls.map(([method]) => method)).toEqual(["new_tab", "navigate"]);
    const [open, navigate] = bridge.request.mock.calls;
    expect(open).toEqual(["new_tab", expect.objectContaining({
      url: HOME, active: false, wait: "domcontentloaded", allowRedirects: false, timeoutMs: 30_000,
    }), 35_000]);
    expect(navigate).toEqual(["navigate", expect.objectContaining({
      url: SEARCH, tabId: homeTab.id, tabFence: homeTab.tabFence,
      incarnation: homeTab.incarnation, sessionId: open[1].sessionId,
      wait: "domcontentloaded", timeoutMs: 30_000,
    }), 35_000]);
  });

  it("does not dispatch search navigation until the homepage load completes", async () => {
    let finishHome!: (value: unknown) => void;
    bridge.request.mockImplementationOnce(() => new Promise((resolve) => { finishHome = resolve; }));
    const connecting = new AthomeBrowser().connect(SEARCH);
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(1));
    expect(bridge.request.mock.calls[0][1].url).toBe(HOME);
    finishHome({ tab: homeTab });
    await connecting;
    expect(bridge.request).toHaveBeenCalledTimes(2);
    expect(bridge.request.mock.calls[1][0]).toBe("navigate");
  });

  it("also bootstraps through the homepage when navigate is called first", async () => {
    await new AthomeBrowser().navigate(SEARCH);
    expect(bridge.request.mock.calls.map(([method, params]) => [method, params.url])).toEqual([
      ["new_tab", HOME], ["navigate", SEARCH],
    ]);
  });

  it("reuses the warm tab for later cities and captures using the new document identity", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    await browser.navigate(NEXT_CITY);
    expect(await browser.fetchPage(2)).toBe(html);
    expect(bridge.request.mock.calls.map(([method]) => method)).toEqual([
      "new_tab", "navigate", "navigate", "evaluate",
    ]);
    expect(bridge.request.mock.calls[2][1]).toMatchObject({ tabId: 17, incarnation: SEARCH, url: NEXT_CITY, wait: "domcontentloaded" });
    expect(bridge.request.mock.calls[3]).toEqual(["evaluate", expect.objectContaining({
      tabId: 17, incarnation: NEXT_CITY, awaitPromise: true,
      expression: expect.stringContaining("AbortSignal.timeout(20000)"),
    }), 35_000]);
  });

  it("fails closed without navigation or capture when the homepage times out", async () => {
    bridge.request.mockRejectedValueOnce(new Error("Homepage load timed out"));
    const browser = new AthomeBrowser();
    await expect(browser.connect(SEARCH)).rejects.toThrow("Homepage load timed out");
    await expect(browser.fetchPage(1)).rejects.toThrow("navigation has not completed");
    expect(bridge.request.mock.calls.map(([method]) => method)).toEqual(["new_tab"]);
  });

  it("does not evaluate or replay a failed search navigation", async () => {
    bridge.request.mockResolvedValueOnce({ tab: homeTab }).mockRejectedValueOnce(new Error("Navigation uncertain"));
    const browser = new AthomeBrowser();
    await expect(browser.connect(SEARCH)).rejects.toThrow("Navigation uncertain");
    await expect(browser.fetchPage(1)).rejects.toThrow("navigation has not completed");
    expect(bridge.request.mock.calls.map(([method]) => method)).toEqual(["new_tab", "navigate"]);
  });

  it("invalidates old-city readiness before a later navigation that fails", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    bridge.request.mockRejectedValueOnce(new Error("Navigation timeout"));
    await expect(browser.navigate(NEXT_CITY)).rejects.toThrow("Navigation timeout");
    await expect(browser.fetchPage(1)).rejects.toThrow("navigation has not completed");
    expect(bridge.request.mock.calls.some(([method]) => method === "evaluate")).toBe(false);
  });

  it("rejects blocked/unsupported documents immediately without polling or AJAX", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    await browser.fetchPage(1);
    const expression = bridge.request.mock.calls.find(([method]) => method === "evaluate")![1].expression;
    const fetch = vi.fn();
    const evaluate = new Function("document", "fetch", `return ${expression}`);
    await expect(evaluate({ querySelector: () => null }, fetch)).rejects.toThrow("blocked or unsupported page");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports page exceptions and requires navigation before another capture", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    bridge.request.mockResolvedValueOnce({ result: { exceptionDetails: {
      exception: { description: "Error: blocked or unsupported page\n    at capture" },
    } } });
    await expect(browser.fetchPage(1)).rejects.toThrow("AtHome capture stopped: Error: blocked or unsupported page");
    await expect(browser.fetchPage(1)).rejects.toThrow("navigation has not completed");
    expect(bridge.request.mock.calls.filter(([method]) => method === "evaluate")).toHaveLength(1);
    await browser.navigate(SEARCH);
    expect(await browser.fetchPage(1)).toBe(html);
  });

  it("does not repeat evaluation after a transport timeout", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    bridge.request.mockRejectedValueOnce(new Error("Browser request timed out: evaluate"));
    await expect(browser.fetchPage(1)).rejects.toThrow("Browser request timed out: evaluate");
    await expect(browser.fetchPage(1)).rejects.toThrow("navigation has not completed");
    expect(bridge.request.mock.calls.filter(([method]) => method === "evaluate")).toHaveLength(1);
  });

  it("does not leak another tab through an accidental repeated connect", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    await expect(browser.connect(SEARCH)).rejects.toThrow("tab already exists");
    expect(bridge.request).toHaveBeenCalledTimes(2);
  });

  it("resets readiness and closes the bridge even when tab cleanup fails", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(SEARCH);
    bridge.request.mockRejectedValueOnce(new Error("Cleanup timeout"));
    await browser.close();
    expect(bridge.close).toHaveBeenCalledOnce();
    await expect(browser.fetchPage(1)).rejects.toThrow("navigation has not completed");
    await browser.connect(SEARCH);
    expect(bridge.request.mock.calls.filter(([method]) => method === "new_tab")).toHaveLength(2);
  });
});

describe("AtHome modern template", () => {
  const CITY = "https://www.athome.co.jp/chintai/saitama/soka-city/list/";
  const modernDocument = `<html><body><select name="SORT"><option value="33" selected>新着順</option></select>
    <div class="property-card"><h2 class="property-title">テストホーム</h2>
      <div class="info-item--location">草加市金明町</div><div class="info-item--station">新田駅 徒歩6分</div>
      <div class="info-item--type">賃貸マンション 3階建2020年5月</div>
      <div class="room-info-section"><div class="price"><span class="rent">8.2万円</span><span>3,000円</span></div>
        <div class="fees"><span>なし</span><span>1ヶ月</span></div>
        <div class="layout-size"><span>3LDK</span><span>75.50m²</span></div>
        <a href="/chintai/1234567890/">詳細</a></div></div></body></html>`;
  let currentUrl = HOME;

  beforeEach(() => {
    currentUrl = HOME;
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "new_tab" || method === "navigate") {
        currentUrl = String(params.url);
        return { tab: { ...homeTab, url: currentUrl, incarnation: currentUrl } };
      }
      if (method === "evaluate") {
        const expression = String(params.expression);
        return { result: { result: { value: expression.includes("outerHTML") ? modernDocument : "__athome_modern_template__" } } };
      }
      return {};
    });
  });

  it("detects the template, navigates to ?sort=33 pages and returns projected legacy markup", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(CITY);
    const first = await browser.fetchPage(1);
    expect(first).toContain("p-property");
    expect(first).toContain("1234567890");
    expect(currentUrl).toBe(`${CITY}?sort=33`);
    await browser.fetchPage(2);
    expect(currentUrl).toBe(`${CITY}page2/?sort=33`);
    // After detection the legacy AJAX probe is skipped: one evaluate per modern page.
    const evaluations = bridge.request.mock.calls.filter(([method]) => method === "evaluate");
    expect(evaluations.map(([, params]) => String(params.expression).includes("outerHTML"))).toEqual([false, true, true]);
  });

  it("reports a verification page instead of retrying, and needs navigation before another capture", async () => {
    const browser = new AthomeBrowser();
    await browser.connect(CITY);
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "evaluate" && String(params.expression).includes("outerHTML")) {
        return { result: { exceptionDetails: { exception: { description: "Error: AtHome results not available (verification page or no results): 認証にご協力ください。" } } } };
      }
      if (method === "evaluate") return { result: { result: { value: "__athome_modern_template__" } } };
      return { tab: { ...homeTab, url: String(params.url) } };
    });
    await expect(browser.fetchPage(1)).rejects.toThrow("verification page");
    await expect(browser.fetchPage(1)).rejects.toThrow("navigation has not completed");
  });

  it("waits passively for a person to complete verification when opted in", async () => {
    vi.stubEnv("ATHOME_VERIFY_WAIT_SECONDS", "30");
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const titles = ["【アットホーム】認証中", "認証にご協力ください。", "アットホーム"];
      bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "evaluate") return { result: { result: { value: titles.length > 1 ? titles.shift() : titles[0] } } };
        return { tab: { ...homeTab, url: String(params.url) } };
      });
      const connecting = new AthomeBrowser().connect(SEARCH);
      await vi.advanceTimersByTimeAsync(10_000);
      await connecting;
      const methods = bridge.request.mock.calls.map(([method]) => method);
      // No reload/navigation while waiting: only title reads until the check clears.
      expect(methods.slice(0, 2)).toEqual(["new_tab", "evaluate"]);
      expect(methods.filter((method) => method === "navigate").length).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});
