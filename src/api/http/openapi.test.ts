import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FIELD_SPECS } from "../../domain/recommend/criteriaSchema";
import { createRecommendationContext } from "../../domain/recommend/rankHomes";
import { decodeRequest } from "../../domain/recommend/request";
import { unpackListings, type WebPayload } from "../../domain/webPayload";
import { loadCurrentReferenceModel } from "../../storage/json/currentReference.contract";
import { createApiService } from "../service";
import { staticSnapshotSource, type Snapshot } from "../snapshot";
import { openApiDocument, REQUEST_EXAMPLES } from "./openapi";

type Schema = Record<string, any>;
const doc = openApiDocument({ auth: false }) as Schema;
const components = doc.components.schemas as Record<string, Schema>;

/**
 * The JSON Schema subset the document uses: $ref, type (or a list of types),
 * const, enum, anyOf, properties/required/additionalProperties, items, and
 * numeric/length bounds. Returns every mismatch as "path: problem".
 */
function check(schema: Schema, value: unknown, path = "$"): string[] {
  if (schema.$ref) return check(components[schema.$ref.replace("#/components/schemas/", "")], value, path);
  if (schema.anyOf) {
    const results = (schema.anyOf as Schema[]).map((option) => check(option, value, path));
    return results.some((errors) => errors.length === 0) ? [] : [`${path}: matches no anyOf option (${results.map((r) => r[0]).join(" | ")})`];
  }
  const errors: string[] = [];
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const fits = types.some((type) => type === actual || (type === "integer" && Number.isInteger(value)) || (type === "number" && actual === "number"));
    if (!fits) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, i) => errors.push(...check(schema.items, item, `${path}[${i}]`)));
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}.${key}: missing`);
    for (const [key, child] of Object.entries(object)) {
      const declared = schema.properties?.[key];
      if (declared) errors.push(...check(declared, child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not in the schema`);
      else if (typeof schema.additionalProperties === "object") errors.push(...check(schema.additionalProperties, child, `${path}.${key}`));
    }
  }
  return errors;
}

let snapshot: Snapshot;
beforeAll(async () => {
  const { catalog } = await loadCurrentReferenceModel();
  const payload = JSON.parse(await readFile(join(process.cwd(), "public/data/listings.json"), "utf-8")) as WebPayload;
  // A sample of the published listings keeps the suite fast (the full index takes ~2 s).
  snapshot = { context: createRecommendationContext(unpackListings(payload).slice(0, 1_500), catalog), dataRevision: "r", loadedAt: "2026-10-12T00:00:00.000Z" };
});

describe("the OpenAPI document", () => {
  it("is OpenAPI 3.1 whose every $ref resolves and every operation has an id and responses", () => {
    expect(doc.openapi).toBe("3.1.0");
    const refs = JSON.stringify(doc).match(/"#\/components\/schemas\/[^"]+"/g) ?? [];
    for (const ref of refs) expect(components[ref.slice('"#/components/schemas/'.length, -1)], ref).toBeDefined();
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, Schema>>)) {
      for (const [method, operation] of Object.entries(item)) {
        expect(operation.operationId, `${method} ${path}`).toBeTruthy();
        expect(ids.has(operation.operationId)).toBe(false);
        ids.add(operation.operationId);
        expect(Object.keys(operation.responses), `${method} ${path}`).toContain("200");
      }
    }
  });

  it("offers every request field as a GET /rankings parameter, except the body-only state maps", () => {
    const names = (doc.paths["/rankings"].get.parameters as { name: string }[]).map((parameter) => parameter.name);
    expect(names).toEqual(FIELD_SPECS.filter((spec) => spec.group !== "state").map((spec) => spec.path));
  });

  it("has request examples the real decoder accepts (and the invalid one it rejects)", () => {
    for (const [name, { value }] of Object.entries(REQUEST_EXAMPLES)) {
      const decoded = decodeRequest(value, snapshot.context.decode);
      expect(decoded.ok, name).toBe(name !== "invalid");
      expect(check(components.RecommendationRequest, value), name).toEqual(name === "invalid" ? ["$.weights.staton: not in the schema"] : []);
    }
  });

  it("asks for a bearer token only when the server has tokens", () => {
    expect(doc.paths["/rankings"].get.security).toEqual([]);
    const withAuth = openApiDocument({ auth: true }) as Schema;
    expect(withAuth.paths["/rankings"].get.security).toEqual([{ bearer: [] }]);
    expect(withAuth.paths["/docs"]).toBeUndefined();
  });
});

describe("real responses match the documented schemas", () => {
  const service = () => createApiService(staticSnapshotSource(snapshot), { now: () => new Date("2026-10-12T00:00:00.000Z") });

  it("rankings: summary, full view, sorted by a criterion, and an empty result with hints", () => {
    const cases = [
      {},
      { view: "full", page: { limit: 3 } },
      { ranking: { sortBy: "size", order: "asc", minPartScores: { station: 10 } }, travel: { mode: "bicycle" } },
      { filters: { rentMax: 30_000, layouts: ["3"] } },
      { state: { marks: { a: "shortlisted" }, excludeKeys: ["b"] }, filters: { markFilter: "hideRuledOut" } },
      ...Object.values(REQUEST_EXAMPLES).filter((example) => example !== REQUEST_EXAMPLES.invalid).map((example) => example.value),
    ];
    for (const body of cases) {
      const result = service().recommendations(body);
      expect(check(components.RankingResult, result), JSON.stringify(body)).toEqual([]);
    }
    expect(service().recommendations({ filters: { rentMax: 30_000, layouts: ["3"] } }).relaxationHints.length).toBeGreaterThan(0);
  });

  it("criteria, presets, places, index and health", () => {
    const api = service();
    expect(check(components.CriteriaCatalogue, api.criteria())).toEqual([]);
    expect(check(components.PresetsResult, api.presets())).toEqual([]);
    expect(check(components.PlacesResult, api.places(new URLSearchParams("category=station&near=35.8,139.8&limit=3")))).toEqual([]);
    expect(check(components.PlacesResult, api.places(new URLSearchParams("q=masjid")))).toEqual([]);
    expect(check(components.ApiIndex, api.index("/v1"))).toEqual([]);
    expect(check(components.Health, api.health())).toEqual([]);
  });

  it("explain and compare, for ranked, unranked and missing homes", () => {
    const api = service();
    const [first, second] = api.recommendations({ page: { limit: 2 } }).results;
    expect(check(components.HomeExplanationResult, api.explain(first.key, {}))).toEqual([]);
    expect(check(components.HomeExplanationResult, api.explain(first.key, { filters: { rentMax: 1 } }))).toEqual([]);
    expect(check(components.HomeComparison, api.compare({ keys: [first.key, second.key, "missing"], criteria: { preset: "space" } }))).toEqual([]);
  });

  it("the checker itself catches missing, extra and mistyped fields", () => {
    const result = service().recommendations({ page: { limit: 1 } });
    const broken = structuredClone(result) as Record<string, any>;
    delete broken.counts;
    broken.extra = 1;
    broken.results[0].score = "high";
    expect(check(components.RankingResult, broken)).toEqual(expect.arrayContaining([
      "$.counts: missing", "$.extra: not in the schema", expect.stringContaining("$.results[0].score"),
    ]));
  });
});
