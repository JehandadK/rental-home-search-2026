import { describe, expect, it } from "vitest";
import { devToolsPort } from "./sharedBrowser";

describe("devToolsPort", () => {
  it("reads the port from the first line Chromium writes", () => {
    expect(devToolsPort("53114\n/devtools/browser/4f1c-…\n")).toBe(53114);
  });
  it("treats an empty, partly written or junk file as no port yet", () => {
    expect(devToolsPort("")).toBeUndefined();
    expect(devToolsPort("\n")).toBeUndefined();
    expect(devToolsPort("abc\n")).toBeUndefined();
    expect(devToolsPort("0\n")).toBeUndefined();
  });
});
