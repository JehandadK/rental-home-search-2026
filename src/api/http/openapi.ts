/**
 * The OpenAPI 3.1 description of the HTTP API. Request bodies and the GET
 * query parameters are generated from the same field specs the decoder uses;
 * response schemas are written out here and checked against real responses by
 * the tests. Paths are relative to the server URL "." — the directory the
 * document is served from (`/v1/`) — so the API can be mounted under a prefix.
 */
import { FIELD_SPECS, MAX_PAGE_LIMIT } from "../../domain/recommend/criteriaSchema";
import { fieldJsonSchema, requestJsonSchema, type JsonSchema } from "../../domain/recommend/jsonSchema";
import { MAX_COMPARE_HOMES } from "../../domain/recommend/rankHomes";
import { API_VERSION } from "../service";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" };
const num = { type: "number" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const strings = { type: "array", items: str };
const object = (properties: Record<string, JsonSchema>, optional: string[] = [], description?: string): JsonSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  properties,
  additionalProperties: false,
});
/** An object whose keys are data (ad keys, field paths), or whose shape belongs to the listing data. */
const openObject = (description: string): JsonSchema => ({ type: "object", description });

const ENVELOPE = {
  apiVersion: { type: "string", const: API_VERSION },
  dataRevision: { type: "string", description: "Changes whenever the published data changes" },
  generatedAt: { type: "string", format: "date-time" },
};
const enveloped = (properties: Record<string, JsonSchema>, optional: string[] = []) => object({ ...ENVELOPE, ...properties }, optional);

function schemas(): Record<string, JsonSchema> {
  const request = requestJsonSchema();
  const requestFilters = (request.properties as Record<string, JsonSchema>).filters;
  const valueSource = { type: "string", description: '"request", "preset:<id>" or "default"', pattern: "^(request|default|preset:.+)$" };

  return {
    RecommendationRequest: request,
    FieldError: object({
      path: { type: "string", description: 'Dotted request path, e.g. "weights.station" or "filters.cities[0]"; "" for the whole request' },
      message: str,
      allowed: { type: "array", items: { type: ["string", "number"] } },
      didYouMean: str,
    }, ["allowed", "didYouMean"]),
    Problem: object({
      type: str, title: str, status: int, detail: str, instance: str,
      errors: { type: "array", items: ref("FieldError") },
    }, ["errors"], "An RFC 9457 problem. For a bad request, `errors` lists every field to fix."),

    BreakdownItem: object({
      key: str, label: str, labelJa: str, unit: str,
      value: nullable(num), score: nullable(num), weight: num,
      contribution: { ...nullable(num), description: "Points this criterion adds to the total; they sum to the total" },
      lost: { ...nullable(num), description: "Points it cost compared with a perfect score here" },
      detail: str,
      set: { type: "string", description: "The request path that changes this criterion's weight" },
    }, ["detail"]),
    HomeSummary: object({
      name: str, address: str, city: nullable(str), area: str, layout: nullable(str),
      sizeM2: nullable(num), builtYear: nullable(int), rent: num, monthlyTotal: num, parkingYen: nullable(num),
      station: object({ name: nullable(str), minutes: nullable(num) }),
      status: { type: "string", enum: ["active", "sold"] },
      isNew: bool, rentedOut: bool, ur: bool,
      ads: { type: "array", items: object({ source: str, url: nullable(str) }) },
      photo: nullable(str), firstSeenAt: nullable(str), lastSeenAt: nullable(str),
    }),
    HomeDetails: object({
      moveIn: openObject("Move-in cost estimate in yen, with which figures were estimated"),
      costs: nullable(openObject("Fees as the ads state them")),
      tenancy: nullable(openObject("Lease terms")),
      building: nullable(openObject("Building facts")),
      attributes: { type: "array", items: openObject("One bilingual property attribute") },
      photos: { type: "array", items: openObject("A photo URL and what it shows") },
      sources: { type: "array", items: openObject("One portal ad") },
      location: nullable(object({ lat: num, lon: num })),
      agency: nullable(str),
    }),
    RankedHome: object({
      rank: { ...nullable(int), description: "1 = best; null for a home explained outside the ranking" },
      key: { type: "string", description: "Stable key for explain, compare and state.excludeKeys" },
      score: { ...nullable(num), description: "Weighted total, 0–100" },
      sortScore: { ...nullable(num), description: "When ranking.sortBy is a criterion: its 0–100 score" },
      home: ref("HomeSummary"),
      reasons: strings,
      concerns: strings,
      breakdown: { type: "array", items: ref("BreakdownItem") },
      gaps: { ...strings, description: "Weighted criteria with no data for this home; their weight was left out of its average" },
      details: ref("HomeDetails"),
    }, ["sortScore", "details"]),
    RequestHint: object({
      id: str, label: str,
      set: openObject("Request paths and the values that would bring homes back"),
      count: int,
    }),
    ScoringParameter: object({
      key: str, label: str, labelJa: str, unit: str, weight: num,
      share: { type: "number", description: "This weight ÷ all weights" },
      source: valueSource,
      set: str,
      range: object({ min: num, max: num }),
      direction: { type: "string", enum: ["lower-is-better", "higher-is-better"] },
      anchors: object({
        fullScoreAt: num, zeroScoreAt: num,
        set: object({ fullScoreAt: str, zeroScoreAt: str }, ["fullScoreAt"]),
        source: valueSource,
      }),
      places: object({ selection: str, ids: nullable(strings), set: str, source: valueSource }),
    }, ["places"]),
    ScoringFeature: object({
      key: str, label: str, labelJa: str, category: str, weight: num, share: num,
      prefer: { type: "string", enum: ["prefer", "avoid"] }, source: valueSource, set: str, setPrefer: str,
    }),
    Scoring: object({
      parameters: { type: "array", items: ref("ScoringParameter") },
      features: { type: "array", items: ref("ScoringFeature"), description: "The weighted features (every feature with view \"full\")" },
      unweightedFeatures: object({
        keys: { ...strings, description: "Features at weight 0: they show on homes but do not count" },
        set: str, setPrefer: str, describe: str,
      }, [], "The features at weight 0, by key, with the path pattern that turns one on"),
      travel: object({ mode: { type: "string", enum: ["walk", "bicycle"] }, speedMPerMin: num, detourFactor: num, includeParking: bool, includeHoikuen: bool }),
      moveIn: openObject("The move-in assumptions used"),
      preset: nullable(str),
    }, [], "The scoring this response used, per criterion, with the request path that changes each value"),
    RankingResult: enveloped({
      scoring: ref("Scoring"),
      filters: { ...requestFilters, required: Object.keys(requestFilters.properties as object) },
      ranking: object({
        sortBy: str, order: { type: "string", enum: ["desc", "asc"] },
        minPartScores: { type: "object", additionalProperties: num }, minScore: num,
      }),
      request: { ...ref("RecommendationRequest"), description: "The fully resolved request: resend it, or change one path to tweak" },
      counts: object({ listings: int, available: int, afterFilters: int, ranked: int, returned: int }),
      results: { type: "array", items: ref("RankedHome") },
      nextOffset: { ...nullable(int), description: "page.offset for the next page; null on the last" },
      relaxationHints: { type: "array", items: ref("RequestHint") },
      warnings: strings,
    }),
    HomeExplanation: object({ home: ref("RankedHome"), ranked: bool, rankAmongRanked: nullable(int) }),
    HomeExplanationResult: enveloped({ home: ref("RankedHome"), ranked: bool, rankAmongRanked: nullable(int) }),
    HomeComparison: enveloped({
      homes: { type: "array", items: { anyOf: [ref("HomeExplanation"), object({ key: str, missing: { type: "boolean", const: true } })] } },
      sharedGaps: strings,
    }),
    CompareRequest: object({
      keys: { type: "array", items: str, minItems: 1, maxItems: MAX_COMPARE_HOMES },
      criteria: ref("RecommendationRequest"),
    }, ["criteria"]),
    Place: object({ id: str, name: str, category: str, subtitle: str, lat: num, lon: num, distM: num }, ["subtitle", "distM"]),
    PlacesResult: enveloped({ places: { type: "array", items: ref("Place") } }),
    Preset: object({ id: str, label: str, description: str, weights: openObject("Weight per numeric criterion") }),
    PresetsResult: enveloped({ presets: { type: "array", items: ref("Preset") } }),
    FieldDescription: object({
      path: str, label: str, labelJa: str, unit: str, description: str,
      type: { type: "string", enum: ["number", "integer", "number|null", "boolean", "enum", "string[]", "placeIds|null", "object"] },
      min: num, max: num, step: num, allowed: { type: "array", items: str }, allowedCount: int, placeCategory: str,
      default: {},
    }, ["labelJa", "unit", "min", "max", "step", "allowed", "allowedCount", "placeCategory"]),
    CriteriaCatalogue: enveloped({
      summary: str,
      howToUse: strings,
      groups: { type: "array", items: object({ group: str, description: str, fields: { type: "array", items: ref("FieldDescription") } }) },
      presets: { type: "array", items: ref("Preset") },
      placeCategories: { type: "array", items: object({ parameter: str, set: str, category: str, label: str, count: int }) },
      criterionKeys: strings,
    }),
    ApiIndex: object({ name: str, description: str, apiVersion: str, dataRevision: nullable(str), links: openObject("Absolute paths to every endpoint") }),
    Health: object({
      status: { type: "string", enum: ["ok", "loading", "failed"] },
      state: { type: "string", enum: ["ready", "loading", "failed"] },
      dataRevision: nullable(str), loadedAt: nullable(str), error: nullable(str),
    }),
  };
}

/** Request examples, shown in Swagger UI; the tests decode each one against the published data. */
export const REQUEST_EXAMPLES: Record<string, { summary: string; value: Record<string, unknown> }> = {
  defaults: { summary: "Default weights, top 10", value: {} },
  presetTweak: {
    summary: "A preset with one weight changed",
    value: { preset: "commuter", weights: { station: 14 }, filters: { rentMax: 130_000, layouts: ["3"] }, page: { limit: 5 } },
  },
  bicycleParking: {
    summary: "By bicycle, with a car: parking required and counted in rent",
    value: {
      travel: { mode: "bicycle", includeParking: true },
      filters: { parking: "required", layouts: ["3", "4"] },
      ranking: { minPartScores: { poi2: 40 } },
    },
  },
  sortByValue: {
    summary: "Best value per ㎡ first, at least 55 ㎡",
    value: { ranking: { sortBy: "rentPerM2" }, filters: { sizeMin: 55 }, view: "summary" },
  },
  nothingMatches: {
    summary: "Too tight: returns relaxationHints",
    value: { filters: { rentMax: 30_000, layouts: ["3"] } },
  },
  invalid: {
    summary: "A typo: returns 400 with a suggestion",
    value: { weights: { staton: 5 } },
  },
};

/** The criteria Swagger UI fills in for explain; the tests decode it too. */
export const EXPLAIN_EXAMPLE = { preset: "commuter", filters: { layouts: ["3"] } };

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ref("Problem") } },
});
const json = (description: string, schema: string) => ({ description, content: { "application/json": { schema: ref(schema) } } });

const DATA_ERRORS = {
  "400": problem("Invalid request: `errors` gives each path, what was wrong, the allowed values and a suggestion"),
  "429": problem("Too many requests; see Retry-After"),
  "503": problem("The data is still loading or could not be loaded; see Retry-After"),
};

/** One query parameter per request field (the `state.*` maps are body-only). */
function rankingParameters(): JsonSchema[] {
  return FIELD_SPECS.filter((spec) => spec.group !== "state").map((spec) => {
    const schema = fieldJsonSchema(spec.type);
    const list = spec.type.kind === "stringList" || spec.type.kind === "placeIds";
    return {
      name: spec.path,
      in: "query",
      required: false,
      description:
        spec.type.kind === "criterionScores"
          ? `${spec.description}. Give it as JSON, or one key at a time: ranking.minPartScores.station=50`
          : `${spec.labelJa ? `${spec.label} · ${spec.labelJa}. ` : ""}${spec.description}${spec.unit ? ` [${spec.unit}]` : ""}` +
            (list ? ". Comma-separated or repeated; " + (spec.type.kind === "placeIds" ? '"null" = every place' : "empty = any") : "") +
            (spec.type.kind === "nullableNumber" ? '. "null" = no bound' : ""),
      ...(list
        ? { schema: { type: "array", items: { type: "string" } }, style: "form", explode: false }
        : spec.type.kind === "criterionScores"
          ? { schema: { type: "string" }, example: '{"station":50}' }
          : { schema }),
    };
  });
}

export function openApiDocument(): JsonSchema {
  return {
    openapi: "3.1.0",
    info: {
      title: "Rental home recommendations API",
      version: API_VERSION,
      description: [
        "Rank rental homes by **your own** weighted criteria and see why each one scored what it did.",
        "",
        "1. `GET /criteria` lists every field you can set, with labels, units, ranges, defaults and the values the data allows.",
        "2. `GET /rankings?…` (query string) or `POST /recommendations` (JSON body) ranks homes. Every field is optional.",
        "3. Each response returns `scoring` (the weight, share, anchors and places used for every criterion, with the request path that changes each) and `request` (the fully resolved request).",
        "4. To tweak, change one path in `request` (e.g. `weights.station`) and send it again.",
        "",
        "Nothing you send is stored. Errors are RFC 9457 problems whose `errors` say exactly which field to fix.",
      ].join("\n"),
    },
    servers: [{ url: ".", description: "This server" }],
    paths: {
      "/": { get: { operationId: "index", summary: "What this API is, with links", tags: ["discover"], responses: { "200": json("The API index", "ApiIndex") } } },
      "/criteria": {
        get: {
          operationId: "describeCriteria", tags: ["discover"],
          summary: "Every field a request can set",
          description: "Grouped fields with EN/JA labels, units, ranges, defaults and, for data-backed fields (cities, layouts, areas), the values the data allows.",
          responses: { "200": json("The criteria catalogue", "CriteriaCatalogue"), "503": DATA_ERRORS["503"] },
        },
      },
      "/presets": {
        get: { operationId: "listPresets", tags: ["discover"], summary: "Named starting weights", responses: { "200": json("Presets", "PresetsResult"), "503": DATA_ERRORS["503"] } },
      },
      "/places": {
        get: {
          operationId: "findPlaces", tags: ["discover"],
          summary: "Look up place ids for places.*",
          description: "Find the schools, mosques, stations, bus stops, kindergartens and elementary schools a distance criterion can measure to.",
          parameters: [
            { name: "category", in: "query", schema: { type: "string" }, description: "poi, mosque, station, busStop, childcare, school, …", example: "mosque" },
            { name: "q", in: "query", schema: { type: "string" }, description: "Part of the name (case- and width-insensitive)" },
            { name: "near", in: "query", schema: { type: "string" }, description: '"lat,lon": nearest first', example: "35.8282,139.8033" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 20 } },
          ],
          responses: { "200": json("Matching places", "PlacesResult"), ...DATA_ERRORS },
        },
      },
      "/rankings": {
        get: {
          operationId: "rankHomesByQuery", tags: ["rank"],
          summary: "Rank homes (query string)",
          description: "The same as POST /recommendations, with each field as a dotted query key: `?preset=commuter&weights.station=14&filters.layouts=3,4`.",
          parameters: rankingParameters(),
          responses: { "200": json("Ranked, explained homes with the scoring used", "RankingResult"), ...DATA_ERRORS },
        },
      },
      "/recommendations": {
        post: {
          operationId: "rankHomes", tags: ["rank"],
          summary: "Rank homes (JSON body)",
          description: `Every field is optional. Page with page.limit (≤ ${MAX_PAGE_LIMIT}) and page.offset = the previous nextOffset.`,
          requestBody: {
            required: false,
            content: { "application/json": { schema: ref("RecommendationRequest"), examples: REQUEST_EXAMPLES } },
          },
          responses: { "200": json("Ranked, explained homes with the scoring used", "RankingResult"), "413": problem("The body is over 64 kB"), "415": problem("The body is not JSON"), ...DATA_ERRORS },
        },
      },
      "/homes/{key}/explain": {
        post: {
          operationId: "explainHome", tags: ["explain"],
          summary: "One home in full under your criteria",
          description: "Scores and explains the home even when your filters would hide it, and says whether (and where) it ranks.",
          parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" }, description: "results[].key from a ranking" }],
          // Without an example Swagger UI samples the schema, which sets every weight to 0.
          requestBody: { required: false, content: { "application/json": { schema: ref("RecommendationRequest"), example: EXPLAIN_EXAMPLE } } },
          responses: { "200": json("The home explained", "HomeExplanationResult"), "404": problem("No home has this key"), ...DATA_ERRORS },
        },
      },
      "/homes/compare": {
        post: {
          operationId: "compareHomes", tags: ["explain"],
          summary: `Up to ${MAX_COMPARE_HOMES} homes side by side`,
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CompareRequest"), example: { keys: ["athome-1173156536"], criteria: { preset: "commuter" } } } },
          },
          responses: { "200": json("Each home explained, and the data gaps they share", "HomeComparison"), ...DATA_ERRORS },
        },
      },
      "/mcp": {
        post: {
          operationId: "mcp", tags: ["agents"],
          summary: "The same tools for agents, over MCP (Streamable HTTP)",
          description:
            "Point an MCP client at this URL. Stateless JSON responses: no session or SSE stream, so GET and DELETE answer 405. " +
            "Tools: describe_criteria, list_presets, find_places, rank_homes, explain_home, compare_homes. " +
            "The body is a JSON-RPC 2.0 message; send `Accept: application/json, text/event-stream`.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", description: "A JSON-RPC 2.0 request or notification" }, example: { jsonrpc: "2.0", id: 1, method: "tools/list" } } },
          },
          responses: {
            "200": { description: "The JSON-RPC response", content: { "application/json": { schema: { type: "object" } } } },
            "202": { description: "A notification was accepted" },
            "406": { description: "The Accept header must list application/json and text/event-stream" },
            ...DATA_ERRORS,
          },
        },
      },
      "/health": {
        get: { operationId: "health", tags: ["discover"], summary: "Whether data is loaded, and which", responses: { "200": json("Ready", "Health"), "503": json("Loading or failed", "Health") } },
      },
    },
    components: {
      schemas: schemas(),
    },
    tags: [
      { name: "discover", description: "What you can ask for" },
      { name: "rank", description: "Ranked homes for your criteria" },
      { name: "explain", description: "One home, or a few side by side" },
      { name: "agents", description: "The same tools as MCP, for agents" },
    ],
  };
}
