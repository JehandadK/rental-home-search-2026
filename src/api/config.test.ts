import { describe, expect, it } from "vitest";
import { isLoopback, parseApiConfig } from "./config";

describe("parseApiConfig", () => {
  it("defaults to loopback on 8787 with no auth", () => {
    expect(parseApiConfig([], {}, "/data")).toEqual({
      ok: true,
      config: { host: "127.0.0.1", port: 8787, dataDir: "/data", corsOrigins: [], rateLimitPerMinute: 120 },
    });
  });

  it("takes flags over the environment", () => {
    const result = parseApiConfig(["--port", "9000", "--data", "/x"], { API_PORT: "1", API_DATA: "/y", API_CORS_ORIGINS: "https://a, https://b" }, "/data");
    expect(result).toMatchObject({ ok: true, config: { port: 9000, dataDir: "/x", corsOrigins: ["https://a", "https://b"] } });
  });

  it("refuses to listen beyond this machine: there is no auth layer yet", () => {
    for (const host of ["0.0.0.0", "192.168.1.5", "::"]) {
      expect(parseApiConfig(["--host", host], {}, "/data"), host).toMatchObject({ ok: false, error: expect.stringContaining("no auth layer yet") });
    }
    expect(parseApiConfig(["--host", "localhost"], {}, "/data").ok).toBe(true);
  });

  it("rejects a flag given without a value instead of silently using a default", () => {
    for (const argv of [["--data"], ["--data="], ["--data", "--port", "9000"], ["--port"]]) {
      expect(parseApiConfig(argv, {}, "/data"), argv.join(" ")).toMatchObject({ ok: false, error: expect.stringContaining("needs a value") });
    }
  });

  it("refuses data URLs that are malformed or carry secrets, without echoing them", () => {
    for (const url of ["http:/x/data", "https://u:secret@x.example/data/", "https://x.example/data/?sig=secret"]) {
      const result = parseApiConfig(["--data", url], {}, "/data");
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.error).not.toContain("secret");
    }
    expect(parseApiConfig(["--data", "C:/rentals/data"], {}, "/data").ok).toBe(true);
  });

  it("takes the data from a directory or an http(s) URL, and nothing else", () => {
    expect(parseApiConfig(["--data", "https://example.com/rentals/data/"], {}, "/data")).toMatchObject({ ok: true, config: { dataDir: "https://example.com/rentals/data/" } });
    expect(parseApiConfig([], { API_DATA: "ftp://example.com/data/" }, "/data")).toMatchObject({ ok: false, error: expect.stringContaining("ftp:") });
    expect(parseApiConfig([], { API_DATA: "https://exa mple.com/" }, "/data")).toMatchObject({ ok: false, error: expect.stringContaining("not a valid URL") });
  });

  it("reads --name=value flags too", () => {
    expect(parseApiConfig(["--host=0.0.0.0"], {}, "/data")).toMatchObject({ ok: false, error: expect.stringContaining("0.0.0.0") });
    expect(parseApiConfig(["--port=9001"], {}, "/data")).toMatchObject({ ok: true, config: { port: 9001 } });
  });

  it("rejects bad ports and bad rate limits", () => {
    expect(parseApiConfig(["--port", "http"], {}, "/data").ok).toBe(false);
    expect(parseApiConfig([], { API_RATE_LIMIT: "-1" }, "/data").ok).toBe(false);
  });
});

describe("isLoopback", () => {
  it("knows which hosts only this machine can reach", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1"]) expect(isLoopback(host), host).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) expect(isLoopback(host), host).toBe(false);
  });
});
