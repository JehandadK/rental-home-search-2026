/**
 * gzip for the website's dev and preview servers. Vite sends everything
 * uncompressed, and the published data is ~32 MB (about 3.7 MB gzipped), which
 * is what makes the site crawl from another device on the network.
 *
 * Text responses only; streams (event-stream, the MCP endpoint under /api),
 * ranges, bodiless statuses and anything already encoded pass through.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { createGzip, constants, type Gzip } from "node:zlib";

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)|\+json\b/i;
/** Below this a gzip header costs more than it saves. */
const MIN_BYTES = 1024;

export function gzipMiddleware(options: { skipPrefix?: string } = {}) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const url = request.url ?? "";
    if (request.method === "HEAD" || !/\bgzip\b/i.test(String(request.headers["accept-encoding"] ?? ""))
      || (options.skipPrefix && url.startsWith(options.skipPrefix))) {
      return next();
    }

    // Loosely typed: Node's overloads of these three don't survive .call().
    const writeHead = response.writeHead as (...args: unknown[]) => ServerResponse;
    const write = response.write as (...args: unknown[]) => boolean;
    const end = response.end as (...args: unknown[]) => ServerResponse;
    let gzip: Gzip | null = null;
    let decided = false;

    const decide = () => {
      if (decided) return;
      decided = true;
      const type = String(response.getHeader("content-type") ?? "");
      const length = Number(response.getHeader("content-length") ?? Infinity);
      const noTransform = /no-transform/i.test(String(response.getHeader("cache-control") ?? ""));
      if (!COMPRESSIBLE.test(type) || /event-stream/i.test(type) || noTransform || length < MIN_BYTES
        || response.getHeader("content-encoding") || [204, 206, 304].includes(response.statusCode)) return;
      gzip = createGzip({ level: constants.Z_BEST_SPEED });
      // Both directions of backpressure: a piped source waits on the response's "drain", and
      // gzip waits for the socket's.
      gzip.on("data", (chunk: Buffer) => {
        if (write.call(response, chunk)) return;
        gzip?.pause();
        response.once("drain", () => gzip?.resume());
      });
      gzip.on("drain", () => void response.emit("drain"));
      gzip.on("end", () => void end.call(response));
      response.setHeader("Content-Encoding", "gzip");
      // The decoded size, for a client showing download progress (Content-Length no longer says it).
      if (Number.isFinite(length)) response.setHeader("X-Uncompressed-Length", length);
      response.removeHeader("Content-Length");
      const vary = String(response.getHeader("vary") ?? "");
      if (!/\baccept-encoding\b/i.test(vary)) response.setHeader("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
    };

    // Headers handed to writeHead() rather than setHeader() must be visible to decide().
    response.writeHead = function (this: ServerResponse, status: number, ...rest: unknown[]) {
      const headers = rest.find((arg): arg is OutgoingHttpHeaders => !!arg && typeof arg === "object" && !Array.isArray(arg));
      if (headers) for (const [name, value] of Object.entries(headers)) if (value !== undefined) this.setHeader(name, value);
      this.statusCode = status;
      decide();
      return writeHead.call(this, status);
    } as typeof response.writeHead;

    response.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
      decide();
      return gzip ? gzip.write(chunk as Buffer, ...(rest as [])) : write.call(this, chunk, ...rest);
    } as typeof response.write;

    response.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
      // A single known body is sized here, so the length check in decide() sees it.
      if (!decided && (typeof chunk === "string" || Buffer.isBuffer(chunk)) && response.getHeader("content-length") === undefined) {
        response.setHeader("Content-Length", Buffer.byteLength(chunk));
      }
      decide();
      if (!gzip) return end.call(this, chunk, ...rest);
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) gzip.end(chunk);
      else gzip.end();
      return this;
    } as typeof response.end;

    next();
  };
}
