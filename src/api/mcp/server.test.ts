import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIELD_SPECS } from "../../domain/recommend/criteriaSchema";
import { requestJsonSchema } from "../../domain/recommend/jsonSchema";
import { createRecommendationContext } from "../../domain/recommend/rankHomes";
import type { EnrichedListing } from "../../domain/types";
import { loadCurrentReferenceModel } from "../../storage/json/currentReference.contract";
import { createApiService, type ApiService } from "../service";
import { staticSnapshotSource, type Snapshot, type SnapshotSource } from "../snapshot";
import { createMcpServer, INSTRUCTIONS, MCP_SERVER_NAME } from "./server";

const make = (id: string, rent: number, layout = "3LDK"): EnrichedListing => ({
  id, name: `Home ${id}`, address: "埼玉県草加市金明町１", city: "Soka", rent, layout, sizeM2: 60,
  builtYear: 2015, stationWalkMin: 8, url: `https://www.athome.co.jp/chintai/${id.slice(7)}/`, source: "athome",
  geocoded: true, lat: 35.8282, lon: 139.8033,
});

let snapshot: Snapshot;
beforeAll(async () => {
  const { catalog } = await loadCurrentReferenceModel();
  snapshot = {
    context: createRecommendationContext([make("athome-1", 90_000), make("athome-2", 120_000), make("athome-3", 70_000, "1K")], catalog),
    dataRevision: "test.0001",
    loadedAt: "2026-10-12T00:00:00.000Z",
  };
});

const NOW = () => new Date("2026-10-12T00:00:00.000Z");
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(service: ApiService = createApiService(staticSnapshotSource(snapshot), { now: NOW }), log?: (line: string) => void) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(service, { log }).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

type Result = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: Result) => JSON.parse((result.content as { type: string; text: string }[])[0].text);

describe("MCP server", () => {
  it("introduces itself with the workflow and lists six read-only tools", async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["describe_criteria", "list_presets", "find_places", "rank_homes", "explain_home", "compare_homes"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.description!.length, tool.name).toBeGreaterThan(40);
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });

  it("takes rank_homes input in the generated request schema, every field included", async () => {
    const { tools } = await (await connect()).listTools();
    const rank = tools.find((tool) => tool.name === "rank_homes")!;
    expect(rank.inputSchema).toEqual(requestJsonSchema());
    const properties = rank.inputSchema.properties as Record<string, unknown>;
    for (const group of new Set(FIELD_SPECS.map((spec) => spec.path.split(".")[0]))) expect(properties, group).toHaveProperty(group);
  });

  it("ranks exactly as the HTTP API does, as structured content and as text", async () => {
    const service = createApiService(staticSnapshotSource(snapshot), { now: NOW });
    const body = { preset: "commuter", weights: { station: 14 }, page: { limit: 2 } };
    const result = await (await connect(service)).callTool({ name: "rank_homes", arguments: body });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(service.recommendations(body));
    expect(text(result)).toEqual(result.structuredContent);
  });

  it("supports the tweak loop: resend the echoed request with one path changed", async () => {
    const client = await connect();
    const first = (await client.callTool({ name: "rank_homes", arguments: { preset: "space" } })).structuredContent as { request: { weights: Record<string, number> } };
    const request = structuredClone(first.request);
    request.weights.station = 20;
    const second = (await client.callTool({ name: "rank_homes", arguments: request })).structuredContent as {
      scoring: { parameters: { key: string; weight: number; source: string }[] };
    };
    expect(second.scoring.parameters.find((parameter) => parameter.key === "station")).toMatchObject({ weight: 20, source: "request" });
  });

  it("answers a bad request as a tool error the agent can read and fix", async () => {
    const result = await (await connect()).callTool({ name: "rank_homes", arguments: { weights: { staton: 5 } } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ status: 400, errors: [{ path: "weights.staton", didYouMean: "station" }] });
  });

  it("explains, compares and finds places", async () => {
    const client = await connect();
    const explained = await client.callTool({ name: "explain_home", arguments: { key: "athome-3", criteria: { filters: { layouts: ["3"] } } } });
    expect(explained.structuredContent).toMatchObject({ ranked: false, home: { key: "athome-3", rank: null } });
    const missing = await client.callTool({ name: "explain_home", arguments: { key: "nope" } });
    expect(missing.isError).toBe(true);
    expect(text(missing).status).toBe(404);
    const compared = await client.callTool({ name: "compare_homes", arguments: { keys: ["athome-1", "athome-2"] } });
    expect((compared.structuredContent as { homes: unknown[] }).homes).toHaveLength(2);
    const places = await client.callTool({ name: "find_places", arguments: { category: "station", near: { lat: 35.8282, lon: 139.8033 }, limit: 2 } });
    expect((places.structuredContent as { places: unknown[] }).places).toHaveLength(2);
  });

  it("rejects arguments a tool does not take", async () => {
    const client = await connect();
    for (const [name, args] of [
      ["describe_criteria", { verbose: true }],
      ["explain_home", { key: "athome-1", extra: 1 }],
      ["explain_home", {}],
      ["find_places", { near: "here" }],
      ["compare_homes", { keys: [] }],
      ["find_places", { limit: "5" }],
      ["find_places", { near: { lat: 35.8, lon: 139.8, extra: 1 } }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(result).status).toBe(400);
    }
  });

  it("names explain_home's criteria errors from the tool's root, as compare_homes does", async () => {
    const client = await connect();
    const explain = await client.callTool({ name: "explain_home", arguments: { key: "athome-1", criteria: { weights: { staton: 1 } } } });
    const compare = await client.callTool({ name: "compare_homes", arguments: { keys: ["athome-1"], criteria: { weights: { staton: 1 } } } });
    expect(text(explain).errors[0].path).toBe("criteria.weights.staton");
    expect(text(compare).errors[0].path).toBe("criteria.weights.staton");
    expect(text(await client.callTool({ name: "explain_home", arguments: { key: "athome-1", criteria: "str" } })).errors[0].path).toBe("criteria");
  });

  it("keeps tools/list small: the request schema is described once, on rank_homes", async () => {
    const { tools } = await (await connect()).listTools();
    expect(JSON.stringify(tools).length).toBeLessThan(45_000);
    for (const name of ["explain_home", "compare_homes"]) {
      const criteria = (tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, { type: string; properties?: unknown }>).criteria;
      expect(criteria, name).toMatchObject({ type: "object" });
      expect(criteria.properties, name).toBeUndefined();
    }
  });

  it("says the data is still loading instead of failing", async () => {
    const loading: SnapshotSource = { current: () => null, status: () => ({ state: "loading", dataRevision: null, loadedAt: null, error: null }) };
    const result = await (await connect(createApiService(loading))).callTool({ name: "rank_homes", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ status: 503, detail: expect.stringContaining("still loading") });
  });

  it("reports an unknown tool as an invalid-params protocol error", async () => {
    await expect((await connect()).callTool({ name: "nope", arguments: {} })).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/Unknown tool nope/) });
  });

  it("returns an internal failure as a tool error the model sees, keeping the cause in the log", async () => {
    const lines: string[] = [];
    const service = createApiService(staticSnapshotSource(snapshot));
    const client = await connect({ ...service, presets: () => { throw new Error("secret detail"); } }, (line) => lines.push(line));
    const failure = await client.callTool({ name: "list_presets", arguments: {} });
    expect(failure.isError).toBe(true);
    expect(text(failure)).toMatchObject({ status: 500, detail: "Unexpected failure; see the server log" });
    expect(JSON.stringify(failure)).not.toContain("secret detail");
    expect(lines.join("\n")).toContain("secret detail");
  });

  it("serves the catalogue and presets as resources", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(["rental://criteria", "rental://presets"]);
    const read = await client.readResource({ uri: "rental://criteria" });
    const body = JSON.parse((read.contents[0] as { text: string }).text);
    expect(body.groups.length).toBeGreaterThan(5);
    await expect(client.readResource({ uri: "rental://nope" })).rejects.toThrow(/Unknown resource/);
  });
});
