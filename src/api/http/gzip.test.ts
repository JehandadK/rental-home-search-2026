import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { gzipMiddleware } from "./gzip";

const BIG = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, text: "rental" })) });
let server: Server | undefined;
afterEach(() => void server?.close());

async function get(path: string, headers: Record<string, string> = { "accept-encoding": "gzip" }) {
  const middleware = gzipMiddleware({ skipPrefix: "/api" });
  server = createServer((req, res) => middleware(req, res, () => {
    if (req.url === "/small") { res.setHeader("Content-Type", "application/json"); res.end("{}"); }
    else if (req.url === "/image") { res.setHeader("Content-Type", "image/png"); res.end(Buffer.alloc(5000)); }
    else if (req.url === "/head-written") { res.writeHead(200, { "Content-Type": "text/css" }); res.end(BIG); }
    else if (req.url === "/piped") {
      // Like a static file server: headers first, then a stream far larger than gzip's buffer.
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": BIG.length * 400 });
      Readable.from(Array.from({ length: 400 }, () => BIG)).pipe(res);
    } else if (req.url === "/streamed") {
      res.setHeader("Content-Type", "application/json"); res.write(BIG); res.end(BIG);
    } else { res.setHeader("Content-Type", "application/json"); res.end(BIG); }
  }));
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return new Promise<{ headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
    request({ port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
}

describe("gzip for the dev and preview servers", () => {
  it("compresses a large JSON body and keeps it intact", async () => {
    const { headers, body } = await get("/data");
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers["vary"]).toBe("Accept-Encoding");
    expect(headers["content-length"]).toBeUndefined();
    expect(body.length).toBeLessThan(BIG.length / 5);
    expect(gunzipSync(body).toString()).toBe(BIG);
  });

  it("compresses a body sent in several writes and one given to writeHead", async () => {
    expect(gunzipSync((await get("/streamed")).body).toString()).toBe(BIG + BIG);
    const written = await get("/head-written");
    expect(written.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(written.body).toString()).toBe(BIG);
  });

  it("finishes a large piped file instead of stalling on backpressure", async () => {
    const { body } = await get("/piped");
    expect(gunzipSync(body).length).toBe(BIG.length * 400);
  });

  it("leaves alone small bodies, binary types, clients without gzip, and the API", async () => {
    expect((await get("/small")).headers["content-encoding"]).toBeUndefined();
    expect((await get("/image")).headers["content-encoding"]).toBeUndefined();
    expect((await get("/data", {})).body.toString()).toBe(BIG);
    expect((await get("/api/v1/x")).headers["content-encoding"]).toBeUndefined();
  });
});
