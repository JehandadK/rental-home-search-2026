import { describe, expect, it } from "vitest";
import { isLoopback, parseApiConfig } from "./config";

const TOKEN = "0123456789abcdef-token";

describe("parseApiConfig", () => {
  it("defaults to loopback on 8787 with no auth", () => {
    expect(parseApiConfig([], {}, "/data")).toEqual({
      ok: true,
      config: { host: "127.0.0.1", port: 8787, dataDir: "/data", tokens: [], corsOrigins: [], rateLimitPerMinute: 120 },
    });
  });

  it("takes flags over the environment", () => {
    const result = parseApiConfig(["--port", "9000", "--data", "/x"], { API_PORT: "1", API_DATA: "/y", API_CORS_ORIGINS: "https://a, https://b" }, "/data");
    expect(result).toMatchObject({ ok: true, config: { port: 9000, dataDir: "/x", corsOrigins: ["https://a", "https://b"] } });
  });

  it("refuses to listen beyond this machine without tokens", () => {
    expect(parseApiConfig(["--host", "0.0.0.0"], {}, "/data")).toMatchObject({ ok: false, error: expect.stringContaining("without API_TOKENS") });
    expect(parseApiConfig(["--host", "0.0.0.0"], { API_TOKENS: TOKEN }, "/data")).toMatchObject({ ok: true, config: { tokens: [TOKEN] } });
  });

  it("reads --name=value flags too", () => {
    expect(parseApiConfig(["--host=0.0.0.0"], {}, "/data")).toMatchObject({ ok: false, error: expect.stringContaining("0.0.0.0") });
    expect(parseApiConfig(["--port=9001"], {}, "/data")).toMatchObject({ ok: true, config: { port: 9001 } });
  });

  it("rejects weak tokens, bad ports and bad rate limits", () => {
    expect(parseApiConfig([], { API_TOKENS: "short" }, "/data").ok).toBe(false);
    expect(parseApiConfig([], { API_TOKENS: "a".repeat(32) }, "/data").ok).toBe(false);
    expect(parseApiConfig([], { API_TOKENS: "abc def ghi jkl mno" }, "/data").ok).toBe(false);
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
