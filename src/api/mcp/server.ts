/**
 * The recommendations API as MCP tools, for agents. Every tool calls the same
 * service the HTTP API does, so both give the same answers.
 *
 * Built on the SDK's low-level `Server` rather than `McpServer`: `McpServer`
 * takes tool inputs as zod schemas, and ours are JSON Schema generated from
 * the field specs (the same ones the decoder and OpenAPI use). Supplying our
 * own JSON Schema is the "advanced use" the low-level server exists for.
 *
 * A tool that gets a bad request, or runs before the data has loaded, answers
 * with `isError` and the same field errors the HTTP API gives, so the calling
 * agent can fix its request and try again.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { MAX_PAGE_LIMIT } from "../../domain/recommend/criteriaSchema";
import { requestJsonSchema } from "../../domain/recommend/jsonSchema";
import { MAX_COMPARE_HOMES } from "../../domain/recommend/rankHomes";
import { ApiError, badRequest, type ApiService } from "../service";

export const MCP_SERVER_NAME = "rental-recommendations";

export const INSTRUCTIONS = [
  "Ranks rental homes (Soka, Koshigaya, Kawaguchi and nearby, Saitama/Tokyo) by the caller's own weighted criteria, and explains every score.",
  "Workflow: call describe_criteria once to learn every field (labels, units, ranges, defaults, allowed values); call find_places if a criterion should measure to specific schools, mosques or stations; then call rank_homes.",
  "Every rank_homes result includes `scoring` (for each criterion: weight, share, where the value came from, and `set`, the request path that changes it) and `request` (the fully resolved request).",
  "To tweak, copy `request`, change one path (e.g. weights.station), and call rank_homes again. Keep view \"summary\" unless you need every detail.",
  "Use explain_home for one home in full (even one your filters hide) and compare_homes for a few side by side. Nothing you send is stored.",
].join("\n");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function tools(): Tool[] {
  const request = requestJsonSchema() as Tool["inputSchema"];
  // The full request schema is ~32 kB; describing it once (on rank_homes) keeps tools/list affordable.
  const criteria = {
    type: "object",
    description: "The same criteria object you pass to rank_homes (see its input schema); omit for the defaults",
  };
  return [
    {
      name: "describe_criteria",
      title: "Describe the criteria",
      description:
        "Every field rank_homes accepts, grouped (preset, weights, features, anchors, travel, moveIn, places, filters, ranking, page, view, state), " +
        "with EN/JA labels, units, ranges, defaults and the values the data allows (cities, layouts, areas). Call this first.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Describe the criteria", ...READ_ONLY },
    },
    {
      name: "list_presets",
      title: "List presets",
      description: "Named starting weights (balanced, school-run, commuter, cheapest, space), each with what it optimises for. Pass one as `preset` to rank_homes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List presets", ...READ_ONLY },
    },
    {
      name: "find_places",
      title: "Find places",
      description:
        "Look up place ids for the places.* fields of rank_homes: private schools (poi), mosques, stations, bus stops, childcare and elementary schools. " +
        "Search by name, by category, and nearest first from a point.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: "poi, mosque, station, busStop, childcare, school, railStation, urDanchi" },
          q: { type: "string", description: "Part of the name, case- and width-insensitive" },
          near: {
            type: "object",
            properties: { lat: { type: "number", minimum: -90, maximum: 90 }, lon: { type: "number", minimum: -180, maximum: 180 } },
            required: ["lat", "lon"],
            additionalProperties: false,
            description: "Sort nearest first from this point",
          },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: { title: "Find places", ...READ_ONLY },
    },
    {
      name: "rank_homes",
      title: "Rank homes",
      description:
        "Rank homes by your criteria; every field is optional (omitted = preset or default). Returns ranked homes with reasons, concerns and a per-criterion " +
        `breakdown, plus \`scoring\` and \`request\` for tweaking. Page with page.limit (≤ ${MAX_PAGE_LIMIT}) and page.offset = nextOffset. ` +
        "When nothing matches, relaxationHints say which single change brings homes back.",
      inputSchema: request,
      annotations: { title: "Rank homes", ...READ_ONLY },
    },
    {
      name: "explain_home",
      title: "Explain one home",
      description: "One home in full under your criteria (costs, attributes, every criterion), even when your filters would hide it, and whether and where it ranks.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "results[].key from rank_homes" },
          criteria,
        },
        required: ["key"],
        additionalProperties: false,
      },
      annotations: { title: "Explain one home", ...READ_ONLY },
    },
    {
      name: "compare_homes",
      title: "Compare homes",
      description: `Up to ${MAX_COMPARE_HOMES} homes side by side under your criteria, each explained in full, with the data gaps they share.`,
      inputSchema: {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_COMPARE_HOMES, description: "results[].key values" },
          criteria,
        },
        required: ["keys"],
        additionalProperties: false,
      },
      annotations: { title: "Compare homes", ...READ_ONLY },
    },
  ];
}

/** Built once: an HTTP request makes a fresh server, and the tool list never changes. */
let cachedTools: Tool[] | undefined;
const toolsOnce = (): Tool[] => (cachedTools ??= tools());

type Args = Record<string, unknown>;

function noOtherArgs(args: Args, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) throw badRequest("Unknown arguments", extra.map((path) => ({ path, message: "is not a known argument", allowed })));
}

function placesQuery(args: Args): URLSearchParams {
  noOtherArgs(args, ["category", "q", "near", "limit"]);
  const query = new URLSearchParams();
  for (const key of ["category", "q"] as const) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== "string") throw badRequest("Invalid arguments", [{ path: key, message: "must be a string" }]);
    query.set(key, args[key] as string);
  }
  if (args.near !== undefined) {
    const near = args.near as { lat?: unknown; lon?: unknown } | null;
    const exact = near !== null && typeof near === "object" && Object.keys(near).every((key) => key === "lat" || key === "lon");
    if (!exact || typeof near?.lat !== "number" || typeof near?.lon !== "number") {
      throw badRequest("Invalid arguments", [{ path: "near", message: "must be {lat, lon} numbers and nothing else" }]);
    }
    query.set("near", `${near.lat},${near.lon}`);
  }
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number") throw badRequest("Invalid arguments", [{ path: "limit", message: "must be a whole number from 1 to 200" }]);
    query.set("limit", String(args.limit));
  }
  return query;
}

/** Errors about a nested argument name it from the tool's root, as compare_homes does. */
function withPathPrefix<T>(prefix: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof ApiError) || !error.errors) throw error;
    const errors = error.errors.map((field) => ({ ...field, path: field.path ? `${prefix}.${field.path}` : prefix }));
    throw new ApiError(error.status, error.title, error.message, errors, error.headers);
  }
}

const ok = (body: object): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  structuredContent: body as Record<string, unknown>,
});

/** A request the agent can fix, or data not loaded yet: answered as a tool error it can read. */
const problem = (error: ApiError): CallToolResult => ({
  isError: true,
  content: [{
    type: "text",
    text: JSON.stringify({ title: error.title, status: error.status, detail: error.message, ...(error.errors ? { errors: error.errors } : {}) }),
  }],
});

const RESOURCES = [
  { uri: "rental://criteria", name: "criteria", title: "Criteria catalogue", description: "Everything rank_homes accepts (the describe_criteria result)" },
  { uri: "rental://presets", name: "presets", title: "Presets", description: "Named starting weights (the list_presets result)" },
] as const;

export function createMcpServer(service: ApiService, options: { version?: string; log?: (line: string) => void } = {}): Server {
  const log = options.log ?? (() => {});
  const server = new Server(
    { name: MCP_SERVER_NAME, title: "Rental home recommendations", version: options.version ?? "1.0.0" },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const toolList = toolsOnce();

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList }));

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Args;
    try {
      switch (name) {
        case "describe_criteria":
          noOtherArgs(args, []);
          return ok(service.criteria());
        case "list_presets":
          noOtherArgs(args, []);
          return ok(service.presets());
        case "find_places":
          return ok(service.places(placesQuery(args)));
        case "rank_homes":
          return ok(service.recommendations(args));
        case "explain_home":
          noOtherArgs(args, ["key", "criteria"]);
          if (typeof args.key !== "string" || args.key === "") {
            throw badRequest("Invalid arguments", [{ path: "key", message: "must be a home key from rank_homes" }]);
          }
          return ok(withPathPrefix("criteria", () => service.explain(args.key as string, args.criteria)));
        case "compare_homes":
          return ok(service.compare(args));
        default:
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${name}; tools: ${toolList.map((tool) => tool.name).join(", ")}`);
      }
    } catch (error) {
      if (error instanceof ApiError) return problem(error);
      if (error instanceof McpError) throw error;
      // An execution failure is a tool result the model can see (MCP 2025-11-25), with the cause kept in the log.
      log(`tool ${name} failed: ${error instanceof Error ? error.stack : String(error)}`);
      return problem(new ApiError(500, "Internal error", "Unexpected failure; see the server log"));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: RESOURCES.map((resource) => ({ ...resource, mimeType: "application/json" })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const resource = RESOURCES.find((candidate) => candidate.uri === request.params.uri);
    if (!resource) throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${request.params.uri}; resources: ${RESOURCES.map((r) => r.uri).join(", ")}`);
    try {
      const body = resource.name === "criteria" ? service.criteria() : service.presets();
      return { contents: [{ uri: resource.uri, mimeType: "application/json", text: JSON.stringify(body) }] };
    } catch (error) {
      if (error instanceof ApiError) throw new McpError(ErrorCode.InternalError, error.message);
      throw error;
    }
  });

  return server;
}
