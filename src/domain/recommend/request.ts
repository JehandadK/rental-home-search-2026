/**
 * Turning a caller's request into resolved `Criteria`.
 *
 * Values resolve in three layers: the defaults, then the preset, then what the
 * request sets. Every field records which layer it came from, so a response
 * can say "weights.station came from the commuter preset".
 *
 * Errors say exactly what to fix: the path, what was wrong, and the allowed
 * values or the closest valid name. Nothing is silently dropped.
 */
import { LISTING_MARKS } from "../marks";
import { SCORE_PARAMETERS } from "../scoringConfig";
import type { ScoreParameterKey } from "../types";
import { applyPreset, BUILT_IN_PRESETS } from "../weightPresets";
import {
  CRITERION_KEYS,
  defaultCriteria,
  FIELD_BY_PATH,
  FIELD_SPECS,
  PARAMETER_ANCHORS,
  parameterDirection,
  type Criteria,
  type DataValues,
  type FieldSpec,
  type FieldType,
} from "./criteriaSchema";

export interface FieldError {
  /** Dotted request path; "" for the request itself. */
  path: string;
  message: string;
  allowed?: readonly (string | number)[];
  didYouMean?: string;
}

/** Where a resolved value came from. */
export type ValueSource = "request" | `preset:${string}` | "default";

/** The data-derived values a request is checked against. */
export interface DecodeContext {
  values: Partial<Record<DataValues, readonly string[]>>;
  /** Every place id in a catalog category. */
  placeIds(category: string): ReadonlySet<string>;
}

export interface DecodedRequest {
  criteria: Criteria;
  /** Per field path, where its value came from. */
  sources: Record<string, ValueSource>;
  /** Things that are allowed but probably not meant. */
  warnings: string[];
}

export type DecodeResult =
  | { ok: true; value: DecodedRequest }
  | { ok: false; errors: FieldError[] };

type PlainObject = Record<string, unknown>;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lists this long are not echoed whole in an error; the closest match is. */
const MAX_ALLOWED_IN_ERROR = 60;

export function decodeRequest(body: unknown, context: DecodeContext): DecodeResult {
  if (body == null) body = {};
  if (!isPlainObject(body)) return { ok: false, errors: [{ path: "", message: "the request must be a JSON object" }] };

  const errors: FieldError[] = [];
  const leaves: [FieldSpec, unknown][] = [];
  collectLeaves(body, "", leaves, errors);
  const values = new Map<FieldSpec, unknown>();
  for (const [spec, raw] of leaves) {
    const result = checkValue(spec.path, spec.type, raw, context);
    if ("error" in result) errors.push(...result.error);
    else values.set(spec, result.value);
  }
  if (errors.length) return { ok: false, errors };

  const criteria = defaultCriteria();
  const sources: Record<string, ValueSource> = Object.fromEntries(FIELD_SPECS.map((spec) => [spec.path, "default" as const]));

  const presetSpec = FIELD_BY_PATH.get("preset")!;
  if (values.has(presetSpec)) {
    const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === values.get(presetSpec))!;
    criteria.config = applyPreset(criteria.config, preset);
    criteria.presetId = preset.id;
    sources.preset = "request";
    const layer: ValueSource = `preset:${preset.id}`;
    for (const spec of FIELD_SPECS) {
      if (spec.group === "weights" || (spec.group === "features" && preset.featureWeights)) sources[spec.path] = layer;
    }
  }
  for (const [spec, value] of values) {
    if (spec === presetSpec) continue;
    spec.write(criteria, value);
    sources[spec.path] = "request";
  }

  const crossErrors = checkAcrossFields(criteria);
  if (crossErrors.length) return { ok: false, errors: crossErrors };
  return { ok: true, value: { criteria, sources, warnings: warningsFor(criteria) } };
}

/**
 * The query-string form: dotted keys with string values, as in
 * `?weights.station=14&filters.layouts=3,4&ranking.minPartScores.station=50`.
 * Lists may repeat a key or separate values with commas; `null` clears a
 * bound; the `state.*` maps take JSON. Decoded with the same rules as a body.
 */
export function decodeQuery(entries: Iterable<[string, string]>, context: DecodeContext): DecodeResult {
  const body: PlainObject = {};
  const errors: FieldError[] = [];
  const lists = new Map<string, string[]>();
  for (const [key, raw] of entries) {
    const { spec, rest } = specForQueryKey(key);
    if (!spec) {
      errors.push(unknownField(key));
      continue;
    }
    if (rest !== undefined && !(CRITERION_KEYS as readonly string[]).includes(rest)) {
      errors.push({ path: key, message: "is not a criterion key", didYouMean: closest(rest, CRITERION_KEYS) });
      continue;
    }
    if (spec.type.kind === "stringList" || spec.type.kind === "placeIds") {
      lists.set(key, [...(lists.get(key) ?? []), ...splitList(raw)]);
      continue;
    }
    const parsed = parseQueryValue(key, spec.type, raw, rest);
    if ("error" in parsed) errors.push(parsed.error);
    else if (!setPath(body, key, parsed.value)) errors.push({ path: key, message: "conflicts with another value given for the same field" });
  }
  for (const [key, items] of lists) {
    const spec = FIELD_BY_PATH.get(key)!;
    const nullish = items.length === 1 && items[0] === "null";
    if (!setPath(body, key, spec.type.kind === "placeIds" && nullish ? null : items)) {
      errors.push({ path: key, message: "conflicts with another value given for the same field" });
    }
  }
  if (errors.length) return { ok: false, errors };
  return decodeRequest(body, context);
}

function specForQueryKey(key: string): { spec?: FieldSpec; rest?: string } {
  const exact = FIELD_BY_PATH.get(key);
  if (exact) return { spec: exact };
  // ranking.minPartScores.<criterion>
  const dot = key.lastIndexOf(".");
  const parent = dot > 0 ? FIELD_BY_PATH.get(key.slice(0, dot)) : undefined;
  return parent?.type.kind === "criterionScores" ? { spec: parent, rest: key.slice(dot + 1) } : {};
}

const splitList = (raw: string): string[] => raw.split(",").map((item) => item.trim()).filter((item) => item !== "");

function parseQueryValue(key: string, type: FieldType, raw: string, rest?: string): { value: unknown } | { error: FieldError } {
  switch (type.kind) {
    case "number":
    case "nullableNumber": {
      if (type.kind === "nullableNumber" && (raw === "null" || raw === "")) return { value: null };
      const value = Number(raw);
      return raw.trim() !== "" && Number.isFinite(value) ? { value } : { error: { path: key, message: `"${raw}" is not a number` } };
    }
    case "boolean":
      if (raw === "true" || raw === "1") return { value: true };
      if (raw === "false" || raw === "0") return { value: false };
      return { error: { path: key, message: `"${raw}" is not a boolean`, allowed: ["true", "false"] } };
    case "criterionScores": {
      // Either one criterion per key (ranking.minPartScores.station=50) or the whole map as JSON.
      if (rest === undefined) return parseJson(key, raw);
      const value = Number(raw);
      return raw.trim() !== "" && Number.isFinite(value) ? { value } : { error: { path: key, message: `"${raw}" is not a number` } };
    }
    case "markMap":
    case "duplicateDecisions":
    case "availabilityMarks":
      return parseJson(key, raw);
    default:
      return { value: raw };
  }
}

function parseJson(key: string, raw: string): { value: unknown } | { error: FieldError } {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: { path: key, message: "must be a JSON object" } };
  }
}

/** Walk the body down to field paths; anything that is not a field is an error with a suggestion. */
function collectLeaves(node: PlainObject, prefix: string, leaves: [FieldSpec, unknown][], errors: FieldError[]): void {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const spec = FIELD_BY_PATH.get(path);
    if (spec) {
      leaves.push([spec, value]);
    } else if (isGroupPath(path)) {
      if (isPlainObject(value)) collectLeaves(value, path, leaves, errors);
      else errors.push({ path, message: "must be an object", allowed: childNames(path) });
    } else {
      errors.push(unknownField(path));
    }
  }
}

/** An unknown path, with the closest name at the deepest level that does exist. */
function unknownField(path: string): FieldError {
  const parts = path.split(".");
  let depth = 0;
  while (depth < parts.length - 1 && isGroupPath(parts.slice(0, depth + 1).join("."))) depth++;
  const siblings = childNames(parts.slice(0, depth).join("."));
  return { path, message: "is not a known field", didYouMean: closest(parts[depth], siblings), allowed: cap(siblings) };
}

const isGroupPath = (path: string) => FIELD_SPECS.some((spec) => spec.path.startsWith(`${path}.`));

/** The names directly under a path ("" = the top level). */
function childNames(path: string): string[] {
  const names = new Set<string>();
  for (const spec of FIELD_SPECS) {
    const rest = path ? (spec.path.startsWith(`${path}.`) ? spec.path.slice(path.length + 1) : null) : spec.path;
    if (rest) names.add(rest.split(".")[0]);
  }
  return [...names];
}

type Checked = { value: unknown } | { error: FieldError[] };
const fail = (path: string, message: string, extra: Omit<FieldError, "path" | "message"> = {}): Checked =>
  ({ error: [{ path, message, ...extra }] });

function checkValue(path: string, type: FieldType, raw: unknown, context: DecodeContext): Checked {
  switch (type.kind) {
    case "number":
      return checkNumber(path, raw, type.min, type.max, type.integer);
    case "nullableNumber":
      return raw === null ? { value: null } : checkNumber(path, raw, type.min, type.max);
    case "boolean":
      return typeof raw === "boolean" ? { value: raw } : fail(path, "must be true or false");
    case "enum":
      return typeof raw === "string" && type.values.includes(raw)
        ? { value: raw }
        : fail(path, `must be one of the allowed values`, { allowed: cap(type.values), didYouMean: closest(String(raw), type.values) });
    case "stringList":
      return checkStrings(path, raw, type.values ? context.values[type.values] : undefined, type.values === "agencies");
    case "placeIds": {
      if (raw === null) return { value: null };
      const ids = context.placeIds(type.category);
      return checkStrings(path, raw, [...ids], false, `is not a "${type.category}" place id; look ids up with find_places`);
    }
    case "criterionScores": {
      if (!isPlainObject(raw)) return fail(path, 'must be an object of criterion key → 0–100, e.g. {"station": 50}');
      const errors: FieldError[] = [];
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!(CRITERION_KEYS as readonly string[]).includes(key)) {
          errors.push({ path: `${path}.${key}`, message: "is not a criterion key", didYouMean: closest(key, CRITERION_KEYS) });
          continue;
        }
        const checked = checkNumber(`${path}.${key}`, value, 0, 100);
        if ("error" in checked) errors.push(...checked.error);
        else out[key] = checked.value as number;
      }
      return errors.length ? { error: errors } : { value: out };
    }
    case "markMap":
      return checkRecord(path, raw, (key, value) => typeof value === "string" && LISTING_MARKS.some((mark) => mark.key === value)
        ? null
        : { path: `${path}.${key}`, message: "is not a mark", allowed: LISTING_MARKS.map((mark) => mark.key) });
    case "duplicateDecisions":
      return checkRecord(path, raw, (key, value) => {
        const strings = (items: unknown) => Array.isArray(items) && items.length > 0 && items.every((item) => typeof item === "string");
        return isPlainObject(value)
          && (value.verdict === "same" || value.verdict === "different")
          && strings(value.a) && strings(value.b) && typeof value.decidedAt === "string"
          ? null
          : { path: `${path}.${key}`, message: 'must be {verdict: "same"|"different", a: [ad keys], b: [ad keys], decidedAt}' };
      });
    case "availabilityMarks":
      return checkRecord(path, raw, (key, value) => isPlainObject(value)
        && (value.state === "gone" || value.state === "listed")
        && typeof value.source === "string" && typeof value.url === "string"
        && typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt))
        && typeof value.evidence === "string" && value.method === "manual"
        ? null
        : { path: `${path}.${key}`, message: 'must be {state: "gone"|"listed", source, url, checkedAt (ISO), evidence, method: "manual"}' });
  }
}

function checkNumber(path: string, raw: unknown, min: number, max: number, integer = false): Checked {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fail(path, "must be a number");
  if (integer && !Number.isInteger(raw)) return fail(path, "must be a whole number");
  if (raw < min || raw > max) return fail(path, `must be between ${min} and ${max}`);
  return { value: raw };
}

function checkStrings(
  path: string,
  raw: unknown,
  allowed: readonly string[] | undefined,
  soft: boolean,
  unknownMessage = "is not a known value",
): Checked {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) return fail(path, "must be a list of strings");
  const items = [...new Set(raw as string[])];
  if (!allowed || soft) return { value: items };
  const known = new Set(allowed);
  const errors = items
    .map((item, i) => [item, i] as const)
    .filter(([item]) => !known.has(item))
    .map(([item, i]): FieldError => ({
      path: `${path}[${i}]`, message: `"${item}" ${unknownMessage}`,
      didYouMean: closest(item, allowed), allowed: cap(allowed),
    }));
  return errors.length ? { error: errors } : { value: items };
}

function checkRecord(path: string, raw: unknown, check: (key: string, value: unknown) => FieldError | null): Checked {
  if (!isPlainObject(raw)) return fail(path, "must be an object");
  const errors = Object.entries(raw).map(([key, value]) => check(key, value)).filter((error): error is FieldError => error != null);
  return errors.length ? { error: errors } : { value: raw };
}

/** An anchor pair must leave room between its 100 and 0 ends; a range must not be inverted. */
function checkAcrossFields(criteria: Criteria): FieldError[] {
  const errors: FieldError[] = [];
  const read = (path: string) => FIELD_BY_PATH.get(path)!.read(criteria) as number;
  for (const meta of SCORE_PARAMETERS) {
    const { full, zero } = PARAMETER_ANCHORS[meta.key as ScoreParameterKey];
    const fullValue = typeof full === "number" ? full : read(full);
    const zeroValue = read(zero);
    const ok = parameterDirection(meta.key) === "lower-is-better" ? fullValue < zeroValue : fullValue > zeroValue;
    if (!ok) {
      errors.push({
        path: typeof full === "string" ? full : zero,
        message: parameterDirection(meta.key) === "lower-is-better"
          ? `${meta.label}: the value scoring 100 (${fullValue}) must be below the value scoring 0 (${zeroValue})`
          : `${meta.label}: the value scoring 100 (${fullValue}) must be above the value scoring 0 (${zeroValue})`,
      });
    }
  }
  const { rentMin, rentMax, sizeMin, sizeMax } = criteria.filters;
  if (rentMin != null && rentMax != null && rentMin > rentMax) errors.push({ path: "filters.rentMin", message: `is above filters.rentMax (${rentMax})` });
  if (sizeMin != null && sizeMax != null && sizeMin > sizeMax) errors.push({ path: "filters.sizeMin", message: `is above filters.sizeMax (${sizeMax})` });
  return errors;
}

function warningsFor(criteria: Criteria): string[] {
  const warnings: string[] = [];
  const { weights, featureWeights } = criteria.config;
  if (![...Object.values(weights), ...Object.values(featureWeights)].some((weight) => weight > 0)) {
    warnings.push("Every weight is 0, so no home can be scored; set at least one weights.* or features.*.weight above 0");
  }
  if (criteria.filters.markFilter !== "all" && Object.keys(criteria.state.marks).length === 0) {
    warnings.push(`filters.markFilter is "${criteria.filters.markFilter}" but state.marks is empty`);
  }
  const { sortBy } = criteria.ranking;
  if (sortBy !== "score") {
    const weight = sortBy in weights ? weights[sortBy as ScoreParameterKey] : featureWeights[sortBy as keyof typeof featureWeights];
    if (weight === 0) warnings.push(`Sorting by ${sortBy}, which has weight 0: it orders the homes but does not count in their totals`);
  }
  return warnings;
}

/**
 * Write one query value into the body. Refuses (returns false) rather than
 * overwrite another value given for the same field, or write a segment that
 * could reach an object's prototype; callers only pass known field paths.
 */
function setPath(target: PlainObject, path: string, value: unknown): boolean {
  const parts = path.split(".");
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) return false;
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === undefined) node[part] = {};
    if (!isPlainObject(node[part])) return false;
    node = node[part] as PlainObject;
  }
  const last = parts[parts.length - 1];
  if (isPlainObject(node[last]) && isPlainObject(value)) node[last] = { ...node[last], ...value };
  else if (node[last] !== undefined) return false;
  else node[last] = value;
  return true;
}

const cap = <T>(values: readonly T[]): readonly T[] | undefined =>
  values.length <= MAX_ALLOWED_IN_ERROR ? values : undefined;

/** The closest candidate by edit distance, when it is close enough to be a typo. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}
