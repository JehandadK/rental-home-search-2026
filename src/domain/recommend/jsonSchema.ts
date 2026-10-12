/**
 * JSON Schema (2020-12, as OpenAPI 3.1 and MCP tool inputs use it) for a
 * recommendation request, generated from the field specs so it accepts exactly
 * what the decoder accepts. Data-derived values (cities, place ids) are checked
 * by the decoder against the live data; the schema describes their shape.
 */
import { LISTING_MARKS } from "../marks";
import { CRITERION_KEYS, defaultCriteria, FIELD_SPECS, GROUP_DESCRIPTIONS, type FieldGroup, type FieldType } from "./criteriaSchema";

export type JsonSchema = Record<string, unknown>;

export function fieldJsonSchema(type: FieldType): JsonSchema {
  switch (type.kind) {
    case "number":
      return { type: type.integer ? "integer" : "number", minimum: type.min, maximum: type.max };
    case "nullableNumber":
      return { type: ["number", "null"], minimum: type.min, maximum: type.max };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", enum: [...type.values] };
    case "stringList":
      // Repeated values are accepted and counted once.
      return { type: "array", items: { type: "string" } };
    case "placeIds":
      return { type: ["array", "null"], items: { type: "string" } };
    case "criterionScores":
      return {
        type: "object",
        propertyNames: { enum: [...CRITERION_KEYS] },
        additionalProperties: { type: "number", minimum: 0, maximum: 100 },
      };
    case "markMap":
      return { type: "object", additionalProperties: { type: "string", enum: LISTING_MARKS.map((mark) => mark.key) } };
    case "duplicateDecisions":
      return {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["verdict", "a", "b", "decidedAt"],
          properties: {
            verdict: { type: "string", enum: ["same", "different"] },
            a: { type: "array", items: { type: "string" }, minItems: 1 },
            b: { type: "array", items: { type: "string" }, minItems: 1 },
            decidedAt: { type: "string" },
          },
        },
      };
    case "availabilityMarks":
      return {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["state", "source", "url", "checkedAt", "evidence", "method"],
          properties: {
            state: { type: "string", enum: ["gone", "listed"] },
            source: { type: "string" },
            url: { type: "string" },
            checkedAt: { type: "string", description: "A date or time, ISO 8601" },
            evidence: { type: "string" },
            method: { type: "string", const: "manual" },
          },
        },
      };
  }
}

/** The whole request as one nested object schema; every field optional, no unknown fields. */
export function requestJsonSchema(): JsonSchema {
  const defaults = defaultCriteria();
  const root: JsonSchema = {
    type: "object",
    additionalProperties: false,
    description: "Every field is optional; omitted fields keep the preset's or the default value.",
    properties: {},
  };
  for (const spec of FIELD_SPECS) {
    const parts = spec.path.split(".");
    let node = root;
    parts.slice(0, -1).forEach((part, depth) => {
      const properties = node.properties as Record<string, JsonSchema>;
      node = properties[part] ??= {
        type: "object",
        additionalProperties: false,
        ...(depth === 0 ? { description: GROUP_DESCRIPTIONS[part as FieldGroup] } : {}),
        properties: {},
      };
    });
    const unit = spec.unit ? ` [${spec.unit}]` : "";
    (node.properties as Record<string, JsonSchema>)[parts[parts.length - 1]] = {
      ...fieldJsonSchema(spec.type),
      title: spec.labelJa ? `${spec.label} · ${spec.labelJa}` : spec.label,
      description: `${spec.description}${unit}`,
      ...(spec.group !== "state" && spec.path !== "preset" ? { default: spec.read(defaults) } : {}),
    };
  }
  return root;
}
