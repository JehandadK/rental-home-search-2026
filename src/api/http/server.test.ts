import { beforeAll, describe, expect, it } from "vitest";
import { createRecommendationContext } from "../../domain/recommend/rankHomes";
import type { EnrichedListing } from "../../domain/types";
import { loadCurrentReferenceModel } from "../../storage/json/currentReference.contract";
import { createApiService, type ApiService } from "../service";
import { staticSnapshotSource, type Snapshot, type SnapshotSource } from "../snapshot";
import { DOCS_CSP, loadDocsAssets, type DocsAsset } from "./docs";
import {
  addressKey, createApiHandler, isLoopbackHost, MAX_RATE_LIMIT_CLIENTS, rateLimiter, tooLarge, type ApiResponse, type ServerConfig,
} from "./server";

const make = (id: string, rent: number): EnrichedListing => ({
  id, name: `Home ${id}`, address: "埼玉県草加市金明町１", city: "Soka", rent, layout: "3LDK", sizeM2: 60,
  builtYear: 2015, stationWalkMin: 8, url: `https://www.athome.co.jp/chintai/${id.slice(7)}/`, source: "athome",
  geocoded: true, lat: 35.8282, lon: 139.8033,
});

let snapshot: Snapshot;
let docs: ReadonlyMap<string, DocsAsset>;
beforeAll(async () => {
  const { catalog } = await loadCurrentReferenceModel();
  snapshot = {
    context: createRecommendationContext([make("athome-1", 90_000), make("athome-2", 120_000), make("athome-3", 70_000)], catalog),
    dataRevision: "test.0001",
    loadedAt: "2026-10-12T00:00:00.000Z",
  };
  docs = await loadDocsAssets();
});

const NOW = () => new Date("2026-10-12T00:00:00.000Z");

function handler(over: Partial<ServerConfig> & { source?: SnapshotSource; service?: ApiService } = {}) {
  const service = over.service ?? createApiService(over.source ?? staticSnapshotSource(snapshot), { now: NOW });
  return createApiHandler({ docs, rateLimitPerMinute: 0, ...over, service });
}

interface Sent { status: number; headers: Record<string, string>; text: string; json: () => any }

async function send(
  handle: ReturnType<typeof createApiHandler>,
  method: string,
  url: string,
  { body, headers = {}, remoteAddress = "127.0.0.1" }: { body?: unknown; headers?: Record<string, string>; remoteAddress?: string } = {},
): Promise<Sent> {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries({ host: "127.0.0.1:8787", ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}), ...headers })
    .map(([name, value]) => [name.toLowerCase(), value]));
  const response: ApiResponse = await handle({
    method, url, headers: lower, remoteAddress,
    body: async (max) => {
      const bytes = Buffer.from(raw);
      if (bytes.length > max) throw tooLarge(max);
      return bytes;
    },
  });
  const text = response.body.toString();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

describe("routes", () => {
  it("redirects / to the API and lists absolute links", async () => {
    const handle = handler();
    expect((await send(handle, "GET", "/")).headers.Location).toBe("/v1");
    const index = (await send(handle, "GET", "/v1")).json();
    expect(index.links).toMatchObject({ docs: "/v1/docs", rankings: "/v1/rankings", explain: "/v1/homes/{key}/explain", health: "/v1/health" });
    expect(index.dataRevision).toBe("test.0001");
  });

  it("puts its mount path into links and redirects when another server mounts it (the dev server's /api)", async () => {
    const handle = handler({ mountPath: "/api" });
    expect((await send(handle, "GET", "/")).headers.Location).toBe("/api/v1");
    expect((await send(handle, "GET", "/v1/docs/")).headers.Location).toBe("/api/v1/docs");
    expect((await send(handle, "GET", "/v1")).json().links).toMatchObject({ docs: "/api/v1/docs", mcp: "/api/v1/mcp" });
    expect((await send(handle, "GET", "/v2")).json().detail).toContain("/api/v1");
  });

  it("ranks the same from the query string and the JSON body, inside the data envelope", async () => {
    const handle = handler();
    const get = (await send(handle, "GET", "/v1/rankings?preset=commuter&weights.station=14&page.limit=2")).json();
    const post = (await send(handle, "POST", "/v1/recommendations", { body: { preset: "commuter", weights: { station: 14 }, page: { limit: 2 } } })).json();
    expect(get).toEqual(post);
    expect(get).toMatchObject({ apiVersion: "1", dataRevision: "test.0001", generatedAt: "2026-10-12T00:00:00.000Z" });
    expect(get.results).toHaveLength(2);
    expect(get.scoring.parameters.find((p: { key: string }) => p.key === "station")).toMatchObject({ weight: 14, source: "request" });
  });

  it("treats an empty body as the defaults", async () => {
    const response = await send(handler(), "POST", "/v1/recommendations");
    expect(response.status).toBe(200);
    expect(response.json().counts.ranked).toBe(3);
  });

  it("serves the catalogue, presets and places", async () => {
    const handle = handler();
    expect((await send(handle, "GET", "/v1/criteria")).json().groups.length).toBeGreaterThan(5);
    expect((await send(handle, "GET", "/v1/presets")).json().presets.map((p: { id: string }) => p.id)).toContain("commuter");
    const places = (await send(handle, "GET", "/v1/places?category=station&near=35.8282,139.8033&limit=2")).json().places;
    expect(places).toHaveLength(2);
    expect(places[0].distM).toBeLessThanOrEqual(places[1].distM);
  });

  it("explains one home, filtered out or not, and compares several", async () => {
    const handle = handler();
    const explained = (await send(handle, "POST", "/v1/homes/athome-2/explain", { body: { filters: { rentMax: 100_000 } } })).json();
    expect(explained).toMatchObject({ ranked: false, home: { key: "athome-2", rank: null } });
    expect((await send(handle, "POST", "/v1/homes/nope/explain")).status).toBe(404);
    const compared = (await send(handle, "POST", "/v1/homes/compare", { body: { keys: ["athome-1", "x"], criteria: { preset: "space" } } })).json();
    expect(compared.homes.map((home: { missing?: true }) => home.missing ?? false)).toEqual([false, true]);
  });

  it("serves Swagger UI from local assets under a strict CSP", async () => {
    const handle = handler();
    const page = await send(handle, "GET", "/v1/docs");
    expect(page.headers["Content-Type"]).toMatch(/text\/html/);
    expect(page.headers["Content-Security-Policy"]).toBe(DOCS_CSP);
    expect(page.text).toContain('src="./docs/swagger-ui-bundle.js"');
    expect(page.text).not.toMatch(/https?:\/\//);
    for (const asset of ["swagger-ui.css", "swagger-ui-bundle.js", "init.js", "favicon-32x32.png"]) {
      expect((await send(handle, "GET", `/v1/docs/${asset}`)).status, asset).toBe(200);
    }
    expect((await send(handle, "GET", "/v1/docs/index.html")).status).toBe(404);
    expect((await send(handle, "GET", "/v1/docs/..%2Fpackage.json")).status).toBe(404);
    expect((await send(handle, "GET", "/v1/docs/")).headers.Location).toBe("/v1/docs");
    expect((await send(handle, "GET", "/v1/openapi.json")).json().openapi).toBe("3.1.0");
  });

  it("answers HEAD like GET, without a body", async () => {
    const head = await send(handler(), "HEAD", "/v1/criteria");
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
  });
});

describe("errors", () => {
  it("returns RFC 9457 problems listing each field to fix", async () => {
    const response = await send(handler(), "GET", "/v1/rankings?weights.staton=5");
    expect(response.status).toBe(400);
    expect(response.headers["Content-Type"]).toBe("application/problem+json; charset=utf-8");
    expect(response.json()).toMatchObject({
      type: "about:blank", title: "Invalid request", status: 400, instance: "/v1/rankings",
      errors: [{ path: "weights.staton", didYouMean: "station" }],
    });
  });

  it("rejects bodies that are not JSON, too large, or of the wrong type", async () => {
    const handle = handler();
    expect((await send(handle, "POST", "/v1/recommendations", { body: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await send(handle, "POST", "/v1/recommendations", { body: "a=1", headers: { "content-type": "text/plain" } })).status).toBe(415);
    const big = { state: { excludeKeys: Array.from({ length: 10_000 }, (_, i) => `key-${i}`) } };
    expect((await send(handle, "POST", "/v1/recommendations", { body: big })).status).toBe(413);
  });

  it("says what exists for unknown paths and wrong methods", async () => {
    const handle = handler();
    expect((await send(handle, "GET", "/v2/rankings")).status).toBe(404);
    const wrong = await send(handle, "POST", "/v1/rankings");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.Allow).toBe("GET, HEAD");
  });

  it("prefixes comparison criteria errors with their place in the body", async () => {
    const response = await send(handler(), "POST", "/v1/homes/compare", { body: { keys: [], criteria: { weights: { staton: 1 } }, extra: 1 } });
    expect(response.json().errors.map((error: { path: string }) => error.path).sort()).toEqual(["criteria.weights.staton", "extra", "keys"]);
  });

  it("rejects bad place queries", async () => {
    const response = await send(handler(), "GET", "/v1/places?category=nowhere&near=north&limit=0&sort=x");
    expect(response.json().errors.map((error: { path: string }) => error.path)).toEqual(["category", "near", "limit", "sort"]);
  });

  it("answers 503 with Retry-After until the data has loaded", async () => {
    const loading: SnapshotSource = { current: () => null, status: () => ({ state: "loading", dataRevision: null, loadedAt: null, error: null }) };
    const handle = handler({ source: loading });
    const response = await send(handle, "GET", "/v1/rankings");
    expect(response.status).toBe(503);
    expect(response.headers["Retry-After"]).toBe("5");
    expect((await send(handle, "GET", "/v1/health")).json()).toMatchObject({ status: "loading", state: "loading" });
    expect((await send(handle, "GET", "/healthz")).status).toBe(503);
    expect((await send(handle, "GET", "/v1")).status).toBe(200);
  });

  it("answers a malformed request target with 400, not 500", async () => {
    for (const target of ["//[", "http://["]) {
      const response = await send(handler(), "GET", target);
      expect(response.status, target).toBe(400);
      expect(response.json().detail).toBe("Malformed request target");
    }
  });

  it("never reveals where the data lives when it fails to load", async () => {
    const failed: SnapshotSource = {
      current: () => null,
      status: () => ({ state: "failed", dataRevision: null, loadedAt: null, error: "ENOENT: no such file, stat '/Users/someone/secret/listings.json'" }),
    };
    const handle = handler({ source: failed });
    for (const path of ["/v1/health", "/healthz"]) {
      const health = await send(handle, "GET", path);
      expect(health.json()).toMatchObject({ state: "failed", error: "data load failed; see the server log" });
      expect(health.text).not.toContain("/Users");
    }
    const data = await send(handle, "GET", "/v1/presets");
    expect(data.status).toBe(503);
    expect(data.text).not.toContain("/Users");
  });

  it("hides internal failures behind a generic 500", async () => {
    const lines: string[] = [];
    const service = createApiService(staticSnapshotSource(snapshot));
    const handle = handler({ service: { ...service, criteria: () => { throw new Error("secret detail"); } }, log: (line) => lines.push(line) });
    const response = await send(handle, "GET", "/v1/criteria");
    expect(response.status).toBe(500);
    expect(response.text).not.toContain("secret detail");
    expect(lines.join("\n")).toContain("secret detail");
  });
});

describe("guards", () => {
  it("has no auth layer yet: it asks for no credentials and documents none", async () => {
    const handle = handler();
    expect((await send(handle, "GET", "/v1/rankings")).status).toBe(200);
    expect((await send(handle, "GET", "/v1/openapi.json")).json().components.securitySchemes).toBeUndefined();
  });

  it("answers only requests addressed to this machine (no DNS rebinding)", async () => {
    const handle = handler();
    for (const host of ["127.0.0.1:8787", "localhost:8787", "LOCALHOST", "[::1]:8787", "127.0.0.1", "localhost.:8787",
      "app.localhost:8787", "[0:0:0:0:0:0:0:1]:8787", "[::ffff:127.0.0.1]:8787", "127.000.000.001:8787"]) {
      expect((await send(handle, "GET", "/v1/presets", { headers: { host } })).status, host).toBe(200);
    }
    for (const host of ["rebind.attacker.example:8787", "127.0.0.1.attacker.example", "", "localhost.evil:8787",
      "localhost:8787, evil", "localhost:99999", "evil@localhost", "localhost/x", "[::2]:8787", "[::ffff:10.0.0.1]"]) {
      expect((await send(handle, "GET", "/v1/presets", { headers: { host } })).status, host).toBe(421);
    }
  });

  it("rate-limits by address, so made-up headers do not reset it", async () => {
    const open = handler({ rateLimitPerMinute: 2 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await send(open, "GET", "/v1/presets", { headers: { Authorization: `junk${i}` } })).status);
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it("keeps the rate-limit table bounded, sweeping windows once they expire", () => {
    let now = 0;
    const limit = rateLimiter(5, () => now);
    for (let i = 0; i < MAX_RATE_LIMIT_CLIENTS; i++) expect(limit(`client-${i}`)).toBe(0);
    expect(limit("one-too-many")).toBe(60);
    expect(limit("client-0")).toBe(0);
    now = 61_000;
    expect(limit("one-too-many")).toBe(0);
  });

  it("groups IPv6 clients by /64 and unwraps IPv4-mapped addresses", () => {
    expect(addressKey("2001:db8::1")).toBe(addressKey("2001:db8::270f"));
    expect(addressKey("2001:db8:0:0:abcd::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("2001:db8:0:1::1")).not.toBe(addressKey("2001:db8:0:2::1"));
    expect(addressKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(addressKey(undefined)).toBe("unknown");
  });

  it("recognises loopback Host headers in their normalised forms", () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost("127.255.0.1:1")).toBe(true);
  });

  it("allows only the configured origins", async () => {
    const handle = handler({ corsOrigins: ["https://agent.example"] });
    const allowed = await send(handle, "GET", "/v1/presets", { headers: { Origin: "https://agent.example" } });
    expect(allowed.headers["Access-Control-Allow-Origin"]).toBe("https://agent.example");
    expect((await send(handle, "GET", "/v1/presets", { headers: { Origin: "https://other.example" } })).headers["Access-Control-Allow-Origin"]).toBeUndefined();
    const preflight = await send(handle, "OPTIONS", "/v1/recommendations", { headers: { Origin: "https://agent.example" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["Access-Control-Allow-Headers"]).toBe("Content-Type");
  });

  it("limits requests per client per minute", async () => {
    const handle = handler({ rateLimitPerMinute: 2 });
    expect((await send(handle, "GET", "/v1/presets")).status).toBe(200);
    expect((await send(handle, "GET", "/v1/presets")).status).toBe(200);
    const limited = await send(handle, "GET", "/v1/presets");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["Retry-After"])).toBeGreaterThan(0);
    // Docs are not data requests.
    expect((await send(handle, "GET", "/v1/docs")).status).toBe(200);
  });

  it("sends security headers on every response", async () => {
    const response = await send(handler(), "GET", "/v1/rankings");
    expect(response.headers).toMatchObject({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "X-Frame-Options": "DENY" });
  });
});
