import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS } from "../filters";
import { DISTANCE_PARAMETERS } from "../places";
import { DEFAULT_CONFIG, FEATURE_PARAMETERS, SCORE_PARAMETERS } from "../scoringConfig";
import { CRITERION_KEYS, defaultCriteria, FIELD_BY_PATH, FIELD_SPECS, toRequestObject } from "./criteriaSchema";
import { requestJsonSchema, type JsonSchema } from "./jsonSchema";
import { decodeRequest, type DecodeContext } from "./request";

const ANY_VALUES: DecodeContext = {
  values: {},
  placeIds: () => new Set(),
};

const paths = new Set(FIELD_SPECS.map((spec) => spec.path));

describe("criteria schema", () => {
  it("has a field for every scoring criterion", () => {
    for (const { key } of SCORE_PARAMETERS) expect(paths).toContain(`weights.${key}`);
    for (const { key } of FEATURE_PARAMETERS) {
      expect(paths).toContain(`features.${key}.weight`);
      expect(paths).toContain(`features.${key}.prefer`);
    }
    expect(CRITERION_KEYS).toHaveLength(SCORE_PARAMETERS.length + FEATURE_PARAMETERS.length);
  });

  it("has a field for every filter, with the minimum score under ranking", () => {
    for (const key of Object.keys(EMPTY_FILTERS)) {
      expect(paths).toContain(key === "minScore" ? "ranking.minScore" : `filters.${key}`);
    }
  });

  it("has a field for every number and switch in the scoring config", () => {
    const covered = (key: string) =>
      [`anchors.${key}`, `travel.${key}`].some((path) => paths.has(path)) || (key === "travelMode" && paths.has("travel.mode"));
    const nested = new Set(["weights", "featureWeights", "featurePreferences", "moveIn", "walkZeroMinutes"]);
    for (const key of Object.keys(DEFAULT_CONFIG).filter((key) => !nested.has(key))) expect(covered(key), key).toBe(true);
    for (const key of Object.keys(DEFAULT_CONFIG.walkZeroMinutes)) expect(paths).toContain(`anchors.walkZeroMinutes.${key}`);
    for (const key of Object.keys(DEFAULT_CONFIG.moveIn)) expect(paths).toContain(`moveIn.${key}`);
  });

  it("has a place selection for every distance criterion", () => {
    for (const key of DISTANCE_PARAMETERS) expect(FIELD_BY_PATH.get(`places.${key}`)?.type.kind).toBe("placeIds");
  });

  it("gives every field a label and a description, and unique paths", () => {
    expect(paths.size).toBe(FIELD_SPECS.length);
    for (const spec of FIELD_SPECS) {
      expect(spec.label, spec.path).not.toBe("");
      expect(spec.description, spec.path).not.toBe("");
    }
  });

  it("reads back every value it writes", () => {
    const criteria = defaultCriteria();
    for (const spec of FIELD_SPECS) {
      const value = spec.read(criteria);
      spec.write(criteria, value);
      expect(spec.read(criteria), spec.path).toEqual(value);
    }
  });

  it("decodes its own default request back to the defaults", () => {
    const request = toRequestObject(defaultCriteria());
    const decoded = decodeRequest(request, ANY_VALUES);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.criteria).toEqual(defaultCriteria());
  });

  it("does not share default objects between criteria", () => {
    const first = defaultCriteria();
    first.config.weights.station = 1;
    first.filters.layouts.push("3");
    expect(defaultCriteria().config.weights.station).toBe(DEFAULT_CONFIG.weights.station);
    expect(defaultCriteria().filters.layouts).toEqual([]);
  });
});

describe("request JSON Schema", () => {
  const schema = requestJsonSchema();
  const at = (path: string): JsonSchema | undefined => path.split(".").reduce<JsonSchema | undefined>(
    (node, part) => (node?.properties as Record<string, JsonSchema> | undefined)?.[part],
    schema,
  );

  it("describes every field, and nothing else", () => {
    for (const spec of FIELD_SPECS) expect(at(spec.path), spec.path).toBeDefined();
    const walk = (node: JsonSchema) => {
      if (node.type === "object" && node.properties) {
        expect(node.additionalProperties).toBe(false);
        for (const child of Object.values(node.properties as Record<string, JsonSchema>)) walk(child);
      }
    };
    walk(schema);
  });

  it("carries each field's range, choices and default", () => {
    expect(at("weights.station")).toMatchObject({ type: "number", minimum: 0, maximum: 20 });
    // Presets replace weights, so the schema states the default in words rather than as `default`.
    expect(at("weights.station")).not.toHaveProperty("default");
    expect(at("weights.station")?.description).toContain(`Default ${DEFAULT_CONFIG.weights.station}, or the preset's value`);
    expect(at("features.cityGas.weight")).not.toHaveProperty("default");
    expect(at("anchors.walkZeroMinutes.station")).toMatchObject({ default: DEFAULT_CONFIG.walkZeroMinutes.station });
    expect(at("filters.rentMax")).toMatchObject({ type: ["number", "null"], default: null });
    expect(at("travel.mode")).toMatchObject({ type: "string", enum: ["walk", "bicycle"] });
    expect(at("page.limit")).toMatchObject({ type: "integer", maximum: 100 });
    expect(at("ranking.sortBy")?.enum).toContain("station");
  });
});
