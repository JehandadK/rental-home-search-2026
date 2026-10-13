import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRecommendationContext } from "../../domain/recommend/rankHomes";
import type { EnrichedListing } from "../../domain/types";
import { loadCurrentReferenceModel } from "../../storage/json/currentReference.contract";
import { loadDocsAssets, type DocsAsset } from "../http/docs";
import { createApiHandler, tooLarge, type ServerConfig } from "../http/server";
import { createApiService } from "../service";
import { staticSnapshotSource, type Snapshot } from "../snapshot";

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
const service = () => createApiService(staticSnapshotSource(snapshot), { now: NOW });
const BASE = "http://127.0.0.1:8787";

/** A fetch that answers from the HTTP handler in memory: real HTTP semantics, no socket. */
function inMemoryFetch(config: Partial<ServerConfig> = {}): typeof fetch {
  const handle = createApiHandler({ service: service(), docs, rateLimitPerMinute: 0, ...config });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = { host: url.host };
    request.headers.forEach((value, name) => { headers[name] = value; });
    const bytes = Buffer.from(await request.arrayBuffer());
    const response = await handle({
      method: request.method, url: url.pathname + url.search, headers, remoteAddress: "127.0.0.1",
      body: async (max) => { if (bytes.length > max) throw tooLarge(max); return bytes; },
    });
    const body = typeof response.body === "string" ? response.body : new Uint8Array(response.body);
    return new Response(response.status === 202 || response.status === 204 || body.length === 0 ? null : body,
      { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function connect(fetchImpl: typeof fetch, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/v1/mcp`), { fetch: fetchImpl, requestInit: { headers } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("MCP over HTTP at /v1/mcp", () => {
  it("serves the same six tools to the SDK's HTTP client", async () => {
    const client = await connect(inMemoryFetch());
    expect(client.getServerVersion()?.name).toBe("rental-recommendations");
    expect((await client.listTools()).tools.map((tool) => tool.name))
      .toEqual(["describe_criteria", "list_presets", "find_places", "rank_homes", "explain_home", "compare_homes"]);
  });

  it("ranks exactly as the REST API does, and supports the tweak loop", async () => {
    const client = await connect(inMemoryFetch());
    const body = { preset: "commuter", page: { limit: 2 } };
    const first = await client.callTool({ name: "rank_homes", arguments: body });
    expect(first.structuredContent).toEqual(service().recommendations(body));
    const request = structuredClone((first.structuredContent as { request: { weights: Record<string, number> } }).request);
    request.weights.station = 20;
    const second = await client.callTool({ name: "rank_homes", arguments: request });
    expect((second.structuredContent as { scoring: { parameters: { key: string; weight: number }[] } }).scoring.parameters
      .find((parameter) => parameter.key === "station")!.weight).toBe(20);
  });

  it("returns a bad request as a tool error the agent can fix", async () => {
    const result = await (await connect(inMemoryFetch())).callTool({ name: "rank_homes", arguments: { weights: { staton: 1 } } });
    expect(result.isError).toBe(true);
  });

  it("needs a bearer token when the server has tokens", async () => {
    const token = "test-token-0123456789";
    await expect(connect(inMemoryFetch({ tokens: [token] }))).rejects.toThrow();
    const client = await connect(inMemoryFetch({ tokens: [token] }), { Authorization: `Bearer ${token}` });
    expect((await client.listTools()).tools).toHaveLength(6);
  });

  it("speaks plain HTTP correctly: stateless, JSON, and guarded like the rest of the API", async () => {
    const fetchImpl = inMemoryFetch();
    const post = (body: unknown, headers: Record<string, string> = {}) => fetchImpl(`${BASE}/v1/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

    const listed = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("content-type")).toMatch(/application\/json/);
    expect(listed.headers.get("mcp-session-id")).toBeNull();
    expect((await listed.json()).result.tools).toHaveLength(6);

    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { accept: "application/json" })).status).toBe(406);
    expect((await post("x".repeat(70_000))).status).toBe(413);

    const get = await fetchImpl(`${BASE}/v1/mcp`, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const foreign = await fetchImpl("http://rebind.attacker.example:8787/v1/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(foreign.status).toBe(421);
  });

  it("takes one message per request: a batch is refused, so it cannot multiply work or hang", async () => {
    const fetchImpl = inMemoryFetch();
    const response = await fetchImpl(`${BASE}/v1/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      ]),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });
  });

  it("never waits past its time limit", async () => {
    const { withTimeout } = await import("./http");
    expect(await withTimeout(new Promise<string>(() => {}), 5, () => "timed out")).toBe("timed out");
    expect(await withTimeout(Promise.resolve("answered"), 1_000, () => "timed out")).toBe("answered");
  });

  it("is listed in the index and the OpenAPI document", async () => {
    const fetchImpl = inMemoryFetch();
    expect((await (await fetchImpl(`${BASE}/v1`)).json()).links.mcp).toBe("/v1/mcp");
    expect((await (await fetchImpl(`${BASE}/v1/openapi.json`)).json()).paths["/mcp"].post.operationId).toBe("mcp");
  });
});
