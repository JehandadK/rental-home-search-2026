/**
 * MCP over HTTP (the Streamable HTTP transport) at POST /v1/mcp, for clients
 * that connect to a URL instead of starting a process.
 *
 * Stateless: every request gets its own MCP server and transport over the
 * shared, already-loaded data, and answers with JSON (no SSE stream, no
 * sessions). Each request is independent, as REST requests are. The HTTP
 * server's guards (localhost only, rate limit, body cap) apply before this runs.
 *
 * One JSON-RPC message per request: batches (dropped from MCP in 2025-06-18)
 * would multiply the work a rate-limited request can ask for, and a batch
 * holding a request and its own cancel never answers. Every request also has
 * a time limit, so nothing can hold a connection open.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ApiService } from "../service";
import { createMcpServer } from "./server";

export interface McpHttpRequest {
  /** Path and query as received, e.g. "/v1/mcp". */
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  /** The JSON-RPC message (or batch), already parsed. */
  body: unknown;
}

export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const MCP_REQUEST_TIMEOUT_MS = 10_000;

const jsonRpcError = (status: number, code: number, message: string): McpHttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
});

/** `work`'s result, or `fallback()` after `ms`; the timer never outlives the race. */
export async function withTimeout<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback()), ms); });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleMcpHttp(
  service: ApiService,
  request: McpHttpRequest,
  options: { log?: (line: string) => void; timeoutMs?: number } = {},
): Promise<McpHttpResponse> {
  if (Array.isArray(request.body)) {
    return jsonRpcError(400, -32600, "JSON-RPC batches are not supported; send one message per request");
  }
  const server = createMcpServer(service, options);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, value);
    const answered = (async (): Promise<McpHttpResponse> => {
      const response = await transport.handleRequest(
        new Request(new URL(request.url, "http://localhost"), { method: "POST", headers, body: JSON.stringify(request.body) }),
        { parsedBody: request.body },
      );
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => { out[name] = value; });
      return { status: response.status, headers: out, body: await response.text() };
    })();
    return await withTimeout(answered, options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS, () => jsonRpcError(504, -32001, "Request timed out"));
  } finally {
    await server.close().catch(() => {});
  }
}
