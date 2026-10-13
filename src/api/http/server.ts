/**
 * The HTTP transport: routes, JSON bodies, RFC 9457 problems, docs, and the
 * guards a server reachable from elsewhere needs (bearer tokens, CORS, body
 * limits, a rate limit, timeouts). Read-only: every handler is in service.ts.
 *
 *   GET  /v1                        index with links
 *   GET  /v1/docs                   Swagger UI        GET /v1/openapi.json
 *   GET  /v1/criteria  /v1/presets  /v1/places
 *   GET  /v1/rankings?…             POST /v1/recommendations
 *   POST /v1/homes/{key}/explain    POST /v1/homes/compare
 *   POST /v1/mcp                    the MCP tools over Streamable HTTP (stateless, JSON)
 *   GET  /v1/health  (and /healthz)
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleMcpHttp } from "../mcp/http";
import { ApiError, badRequest, type ApiService } from "../service";
import { DOCS_CSP, DOCS_PAGE, type DocsAsset } from "./docs";
import { openApiDocument } from "./openapi";

export const BASE = "/v1";
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

export interface ServerConfig {
  service: ApiService;
  docs: ReadonlyMap<string, DocsAsset>;
  /** Bearer tokens accepted on data endpoints; empty = no auth (loopback only, enforced by the CLI). */
  tokens?: readonly string[];
  /** Origins allowed to call from a browser; "*" for any. Empty = same-origin only. */
  corsOrigins?: readonly string[];
  maxBodyBytes?: number;
  /** Data requests per client per minute; 0 = unlimited. */
  rateLimitPerMinute?: number;
  /**
   * Where the API is mounted when another server strips a prefix before handing
   * requests over (the dev server mounts it at "/api"). Links and redirects include it.
   */
  mountPath?: string;
  log?: (line: string) => void;
}

interface Reply {
  status: number;
  body?: unknown;
  /** A non-JSON body, served as-is. */
  raw?: { contentType: string; body: Buffer | string };
  headers?: Record<string, string>;
  /** An RFC 9457 problem, served as application/problem+json. */
  problem?: true;
}

interface RequestContext {
  url: URL;
  headers: ApiRequest["headers"];
  params: string[];
  body(): Promise<unknown>;
}

/** One HTTP request, independent of sockets, so the handler can be tested without a port. */
export interface ApiRequest {
  method: string;
  /** Path and query, e.g. "/v1/rankings?preset=commuter". */
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  remoteAddress?: string;
  /** The raw body; rejects with a 413 ApiError past `maxBytes`. */
  body(maxBytes: number): Promise<Buffer>;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  /** Data endpoints need a token when tokens are set, and count against the rate limit. */
  data: boolean;
  handle(context: RequestContext): Reply | Promise<Reply>;
}

const ok = (body: unknown): Reply => ({ status: 200, body });

/** Every route and guard, as a function from request to response. */
export function createApiHandler(config: ServerConfig): (request: ApiRequest) => Promise<ApiResponse> {
  const { service, docs, log = () => {} } = config;
  const tokens = (config.tokens ?? []).map((token) => Buffer.from(token));
  const corsOrigins = new Set(config.corsOrigins ?? []);
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const limiter = rateLimiter(config.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE);
  const openApi = JSON.stringify(openApiDocument({ auth: tokens.length > 0 }));
  /** The API's public base path, e.g. "/v1", or "/api/v1" in the dev server. */
  const base = `${config.mountPath ?? ""}${BASE}`;

  const health = (): Reply => {
    const body = service.health();
    return { status: body.state === "ready" ? 200 : 503, body };
  };

  const routes: Route[] = [
    { method: "GET", pattern: /^\/$/, data: false, handle: () => ({ status: 302, headers: { Location: base } }) },
    { method: "GET", pattern: /^\/v1\/?$/, data: false, handle: () => ok(service.index(base)) },
    { method: "GET", pattern: /^\/v1\/openapi\.json$/, data: false, handle: () => ({ status: 200, raw: { contentType: "application/json; charset=utf-8", body: openApi } }) },
    { method: "GET", pattern: /^\/v1\/docs$/, data: false, handle: () => ({ status: 200, raw: { contentType: "text/html; charset=utf-8", body: DOCS_PAGE }, headers: { "Content-Security-Policy": DOCS_CSP } }) },
    // The page's relative links only resolve from /v1/docs.
    { method: "GET", pattern: /^\/v1\/docs\/$/, data: false, handle: () => ({ status: 301, headers: { Location: `${base}/docs` } }) },
    {
      method: "GET", pattern: /^\/v1\/docs\/([^/]+)$/, data: false,
      handle: ({ params: [name] }) => {
        const asset = docs.get(name);
        if (!asset) throw new ApiError(404, "Not found", `No docs asset ${name}`);
        return { status: 200, raw: asset, headers: { "Cache-Control": "public, max-age=3600", "Content-Security-Policy": DOCS_CSP } };
      },
    },
    { method: "GET", pattern: /^\/(?:v1\/health|healthz)$/, data: false, handle: health },
    { method: "GET", pattern: /^\/v1\/criteria$/, data: true, handle: () => ok(service.criteria()) },
    { method: "GET", pattern: /^\/v1\/presets$/, data: true, handle: () => ok(service.presets()) },
    { method: "GET", pattern: /^\/v1\/places$/, data: true, handle: ({ url }) => ok(service.places(url.searchParams)) },
    { method: "GET", pattern: /^\/v1\/rankings$/, data: true, handle: ({ url }) => ok(service.rankingsFromQuery(url.searchParams)) },
    { method: "POST", pattern: /^\/v1\/recommendations$/, data: true, handle: async ({ body }) => ok(service.recommendations(await body())) },
    { method: "POST", pattern: /^\/v1\/homes\/compare$/, data: true, handle: async ({ body }) => ok(service.compare(await body())) },
    {
      method: "POST", pattern: /^\/v1\/homes\/([^/]+)\/explain$/, data: true,
      handle: async ({ params: [key], body }) => ok(service.explain(decodeSegment(key), await body())),
    },
    {
      method: "POST", pattern: /^\/v1\/mcp$/, data: true,
      handle: async ({ url, headers, body }) => {
        const answer = await handleMcpHttp(service, { url: url.pathname + url.search, headers, body: await body() }, { log });
        const { "content-type": contentType, ...rest } = answer.headers;
        return {
          status: answer.status,
          headers: rest,
          ...(answer.body ? { raw: { contentType: contentType ?? "application/json", body: answer.body } } : {}),
        };
      },
    },
  ];

  /** The configured token the request presents, if any (the scheme is case-insensitive, RFC 9110). */
  const presentedToken = (request: ApiRequest): string | null => {
    const match = /^bearer +(\S+)\s*$/i.exec(request.headers.authorization ?? "");
    if (!match) return null;
    const given = Buffer.from(match[1]);
    const token = tokens.find((candidate) => candidate.length === given.length && timingSafeEqual(candidate, given));
    return token ? token.toString() : null;
  };

  const corsHeaders = (request: ApiRequest): Record<string, string> => {
    const origin = request.headers.origin;
    if (!origin || !(corsOrigins.has("*") || corsOrigins.has(origin))) return {};
    return { "Access-Control-Allow-Origin": corsOrigins.has("*") ? "*" : origin, Vary: "Origin" };
  };

  return async (request) => {
    const started = Date.now();
    const cors = corsHeaders(request);
    let url = new URL("http://localhost/");
    let reply: Reply;
    try {
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        throw badRequest("Malformed request target");
      }
      // Without tokens the API is for this machine only; a foreign Host is a DNS-rebinding page.
      if (!tokens.length && !isLoopbackHost(request.headers.host)) {
        throw new ApiError(421, "Misdirected request", "This API only answers requests addressed to localhost");
      }
      if (request.method === "OPTIONS") {
        reply = cors["Access-Control-Allow-Origin"]
          ? { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" } }
          : { status: 204 };
      } else {
        const matching = routes.filter((route) => route.pattern.test(url.pathname));
        if (!matching.length) throw new ApiError(404, "Not found", `Nothing at ${url.pathname}; the API lives under ${base}`);
        // HEAD is GET without the body.
        const method = request.method === "HEAD" ? "GET" : request.method;
        const route = matching.find((candidate) => candidate.method === method);
        if (!route) {
          const allow = [...new Set(matching.flatMap((r) => (r.method === "GET" ? ["GET", "HEAD"] : [r.method])))].join(", ");
          throw new ApiError(405, "Method not allowed", `${url.pathname} accepts ${allow}`, undefined, { Allow: allow });
        }
        if (route.data) {
          // Keyed by the matched token, never by anything else the client chooses; failed attempts count too.
          const token = tokens.length ? presentedToken(request) : null;
          const wait = token ? limiter.token(token) : limiter.address(addressKey(request.remoteAddress));
          if (wait > 0) throw new ApiError(429, "Too many requests", `Try again in ${wait} s`, undefined, { "Retry-After": String(wait) });
          if (tokens.length && !token) {
            throw new ApiError(401, "Unauthorized", "Send Authorization: Bearer <token>", undefined, { "WWW-Authenticate": "Bearer" });
          }
        }
        const params = route.pattern.exec(url.pathname)!.slice(1);
        reply = await route.handle({ url, headers: request.headers, params, body: async () => parseJsonBody(await request.body(maxBodyBytes), request.headers["content-type"]) });
      }
    } catch (error) {
      reply = problemReply(error, url.pathname, log);
    }
    log(`${request.method} ${url.pathname} ${reply.status} ${Date.now() - started}ms`);
    const rendered = render(reply, cors);
    return request.method === "HEAD" ? { ...rendered, body: "" } : rendered;
  };
}

/** The handler as a node:http request listener, for this module's server and for the dev server's middleware. */
export function createNodeListener(config: ServerConfig): (request: IncomingMessage, response: ServerResponse) => void {
  const handle = createApiHandler(config);
  const log = config.log ?? (() => {});
  return (request, response) => {
    handle(fromNode(request))
      .catch((error: unknown): ApiResponse => {
        log(`unhandled: ${error instanceof Error ? error.stack : String(error)}`);
        return render({ status: 500, body: problemBody(500, "Internal error", "Unexpected failure", ""), problem: true }, {});
      })
      .then(({ status, headers, body }) => {
        response.writeHead(status, headers);
        response.end(body);
      });
  };
}

/** The handler on its own node:http server. */
export function createApiServer(config: ServerConfig): Server {
  // Check slow connections every 2 s, so the header and request timeouts bite on time.
  const server = createServer({ connectionsCheckingInterval: 2_000, headersTimeout: 10_000, requestTimeout: 15_000 }, createNodeListener(config));
  server.keepAliveTimeout = 5_000;
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest("The home key is not valid URL encoding");
  }
}

const MAX_CONNECTIONS = 256;

/**
 * True when a Host header names this machine: localhost (and *.localhost,
 * which browsers resolve to loopback themselves), 127.0.0.0/8, or ::1, in any
 * spelling the URL parser normalises (a trailing dot, 127.000.000.001,
 * [0:0:0:0:0:0:0:1], [::ffff:127.0.0.1]). A request with no Host is refused.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  // A Host header is host[:port]; anything else (a path, credentials, a list) is refused before parsing.
  if (!host || /[\s/\\@?#,]/.test(host)) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || /^127\.\d+\.\d+\.\d+$/.test(hostname)
    || hostname === "[::1]"
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname);
}

/**
 * The rate-limit key for a client without a token: its IPv4 address, or its
 * IPv6 /64 (one subscriber's whole allocation), so rotating addresses inside
 * a /64 does not buy a fresh window.
 */
export function addressKey(address: string | undefined): string {
  if (!address) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.split("%")[0].toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = address.includes("::") && tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function fromNode(request: IncomingMessage): ApiRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  return {
    method: request.method ?? "GET",
    url: request.url ?? "/",
    headers,
    remoteAddress: request.socket.remoteAddress,
    body: async (maxBytes) => {
      if (Number(headers["content-length"] ?? 0) > maxBytes) throw tooLarge(maxBytes);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) throw tooLarge(maxBytes);
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    },
  };
}

export const tooLarge = (maxBytes: number) => new ApiError(413, "Body too large", `The body may be at most ${maxBytes} bytes`);

export const MAX_RATE_LIMIT_CLIENTS = 10_000;

export interface RateLimiter {
  /** A request presenting a valid token. Bounded by the configured tokens, so never refused for space. */
  token(token: string): number;
  /** A request without a valid token, by addressKey. A full table turns new addresses away rather than growing. */
  address(key: string): number;
}

/**
 * A fixed one-minute window per client; each call returns seconds to wait,
 * or 0. Token holders and anonymous addresses keep separate tables, so
 * addresses filling theirs can never lock a token holder out. Expired windows
 * are swept at most every 10 s.
 */
export function rateLimiter(perMinute: number, clock: () => number = Date.now): RateLimiter {
  const tokens = new Map<string, { start: number; count: number }>();
  const addresses = new Map<string, { start: number; count: number }>();
  let lastSweep = 0;
  const hit = (windows: typeof tokens, key: string, capped: boolean) => {
    if (perMinute <= 0) return 0;
    const now = clock();
    if (now - lastSweep >= 10_000) {
      lastSweep = now;
      for (const table of [tokens, addresses]) for (const [k, w] of table) if (now - w.start >= 60_000) table.delete(k);
    }
    const window = windows.get(key);
    if (!window || now - window.start >= 60_000) {
      if (!window && capped && windows.size >= MAX_RATE_LIMIT_CLIENTS) return 60;
      windows.set(key, { start: now, count: 1 });
      return 0;
    }
    window.count++;
    return window.count > perMinute ? Math.ceil((window.start + 60_000 - now) / 1000) : 0;
  };
  return { token: (token) => hit(tokens, token, false), address: (key) => hit(addresses, key, true) };
}

function parseJsonBody(bytes: Buffer, contentType: string | undefined): unknown {
  const text = bytes.toString("utf-8");
  if (text.trim() === "") return undefined;
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new ApiError(415, "Unsupported media type", "Send the body as application/json");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw badRequest(`The body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function problemBody(status: number, title: string, detail: string, instance: string, errors?: unknown) {
  return { type: "about:blank", title, status, detail, instance, ...(errors ? { errors } : {}) };
}

function problemReply(error: unknown, instance: string, log: (line: string) => void): Reply {
  if (error instanceof ApiError) {
    return { status: error.status, body: problemBody(error.status, error.title, error.message, instance, error.errors), headers: error.headers, problem: true };
  }
  log(`error on ${instance}: ${error instanceof Error ? error.stack : String(error)}`);
  return { status: 500, body: problemBody(500, "Internal error", "Unexpected failure; see the server log", instance), problem: true };
}

function render(reply: Reply, cors: Record<string, string>): ApiResponse {
  return {
    status: reply.status,
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
      ...(reply.body !== undefined
        ? { "Content-Type": reply.problem ? "application/problem+json; charset=utf-8" : "application/json; charset=utf-8" }
        : reply.raw ? { "Content-Type": reply.raw.contentType } : {}),
      ...cors,
      ...reply.headers,
    },
    body: reply.raw?.body ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)),
  };
}
