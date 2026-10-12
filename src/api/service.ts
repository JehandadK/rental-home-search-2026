/**
 * What the recommendations API does, independent of transport. The HTTP
 * server (and later the MCP server) call these handlers; each returns a JSON
 * body or throws an ApiError, which a transport turns into its own error form.
 */
import { BUILT_IN_PRESETS } from "../domain/weightPresets";
import { describeCriteria, findPlaces } from "../domain/recommend/describe";
import { compareHomes, explainHome, MAX_COMPARE_HOMES, rankHomes } from "../domain/recommend/rankHomes";
import { decodeQuery, decodeRequest, type DecodeResult, type FieldError } from "../domain/recommend/request";
import type { Snapshot, SnapshotSource } from "./snapshot";

export const API_VERSION = "1";

/** A failure with an HTTP status and, for bad requests, the fields to fix. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    detail: string,
    readonly errors?: readonly FieldError[],
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
  }
}

export const badRequest = (detail: string, errors?: readonly FieldError[]) =>
  new ApiError(400, "Invalid request", detail, errors);

export interface ServiceOptions {
  now?: () => Date;
}

export type ApiService = ReturnType<typeof createApiService>;

export function createApiService(source: SnapshotSource, options: ServiceOptions = {}) {
  const now = options.now ?? (() => new Date());

  const snapshot = (): Snapshot => {
    const current = source.current();
    if (current) return current;
    // The load error names files on this machine: it stays in the server log.
    const { state } = source.status();
    throw new ApiError(503, "Data not available", state === "failed"
      ? "The listing data could not be loaded; see the server log"
      : "The listing data is still loading; try again in a few seconds", undefined, { "Retry-After": "5" });
  };

  /** Every data response says which data and API version produced it. */
  const envelope = <T extends object>(data: Snapshot, body: T) => ({
    apiVersion: API_VERSION,
    dataRevision: data.dataRevision,
    generatedAt: now().toISOString(),
    ...body,
  });

  const decoded = (result: DecodeResult) => {
    if (!result.ok) throw badRequest(`${result.errors.length} field${result.errors.length === 1 ? "" : "s"} to fix`, result.errors);
    return result.value;
  };

  return {
    /** `base` is where the API is mounted, e.g. "/v1"; links are absolute paths under it. */
    index(base: string) {
      const status = source.status();
      return {
        name: "Rental home recommendations API",
        description:
          "Ranks rental homes (Soka, Koshigaya, Kawaguchi and nearby) by your own weighted criteria, and explains every score. " +
          "Start with GET criteria to see what you can set, then GET rankings or POST recommendations. Every ranking returns " +
          "`scoring` (what was used for each criterion, with the request path that changes it) and `request` (resend it, " +
          "or change one path to tweak).",
        apiVersion: API_VERSION,
        dataRevision: status.dataRevision,
        links: Object.fromEntries(Object.entries({
          docs: "docs",
          openapi: "openapi.json",
          criteria: "criteria",
          presets: "presets",
          places: "places",
          rankings: "rankings",
          recommendations: "recommendations",
          explain: "homes/{key}/explain",
          compare: "homes/compare",
          health: "health",
        }).map(([name, path]) => [name, `${base}/${path}`])),
      };
    },

    /** Public, so it says whether a load failed but never why (the reason names local files; see the log). */
    health() {
      const { state, dataRevision, loadedAt, error } = source.status();
      return { status: state === "ready" ? "ok" : state, state, dataRevision, loadedAt, error: error ? "data load failed; see the server log" : null };
    },

    criteria() {
      const data = snapshot();
      return envelope(data, describeCriteria(data.context));
    },

    presets() {
      const data = snapshot();
      return envelope(data, {
        presets: BUILT_IN_PRESETS.map(({ id, label, description, weights }) => ({ id, label, description, weights: { ...weights } })),
      });
    },

    places(query: URLSearchParams) {
      const data = snapshot();
      const errors: FieldError[] = [];
      const category = query.get("category") ?? undefined;
      if (category !== undefined && !data.context.catalog.categories.includes(category)) {
        errors.push({ path: "category", message: "is not a place category", allowed: data.context.catalog.categories });
      }
      let near: { lat: number; lon: number } | undefined;
      const nearText = query.get("near");
      if (nearText != null) {
        const [lat, lon] = nearText.split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) near = { lat, lon };
        else errors.push({ path: "near", message: 'must be "lat,lon", e.g. "35.8282,139.8033"' });
      }
      const limitText = query.get("limit");
      const limit = limitText == null ? 20 : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) errors.push({ path: "limit", message: "must be a whole number from 1 to 200" });
      for (const key of query.keys()) {
        if (!["category", "q", "near", "limit"].includes(key)) errors.push({ path: key, message: "is not a known parameter", allowed: ["category", "q", "near", "limit"] });
      }
      if (errors.length) throw badRequest("Invalid place query", errors);
      const places = findPlaces(data.context.catalog, { category, q: query.get("q") ?? undefined, near, limit });
      return envelope(data, { places });
    },

    rankingsFromQuery(query: URLSearchParams) {
      const data = snapshot();
      return envelope(data, rankHomes(data.context, decoded(decodeQuery(query.entries(), data.context.decode)), { now: now() }));
    },

    recommendations(body: unknown) {
      const data = snapshot();
      return envelope(data, rankHomes(data.context, decoded(decodeRequest(body, data.context.decode)), { now: now() }));
    },

    explain(key: string, body: unknown) {
      const data = snapshot();
      const explained = explainHome(data.context, decoded(decodeRequest(body, data.context.decode)), key, { now: now() });
      if (!explained) throw new ApiError(404, "No such home", `No home has the key "${key}"; keys come from a ranking's results[].key`);
      return envelope(data, explained);
    },

    compare(body: unknown) {
      const data = snapshot();
      const { keys, criteria } = (body ?? {}) as { keys?: unknown; criteria?: unknown };
      const errors: FieldError[] = [];
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_COMPARE_HOMES || !keys.every((key) => typeof key === "string")) {
        errors.push({ path: "keys", message: `must be a list of 1 to ${MAX_COMPARE_HOMES} home keys` });
      }
      const extra = body && typeof body === "object" ? Object.keys(body).filter((key) => key !== "keys" && key !== "criteria") : [];
      for (const key of extra) errors.push({ path: key, message: "is not a known field", allowed: ["keys", "criteria"] });
      const request = decodeRequest(criteria, data.context.decode);
      if (!request.ok) errors.push(...request.errors.map((error) => ({ ...error, path: error.path ? `criteria.${error.path}` : "criteria" })));
      if (errors.length || !request.ok) throw badRequest("Invalid comparison", errors);
      return envelope(data, compareHomes(data.context, request.value, keys as string[], { now: now() }));
    },
  };
}
