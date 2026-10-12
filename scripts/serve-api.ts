/**
 * Serves the recommendations API over the published data.
 *
 *   npm run api                         http://127.0.0.1:8787/v1 (docs at /v1/docs)
 *   npm run api -- --port 9000 --data public/data
 *
 * Env: API_HOST, API_PORT, API_DATA, API_TOKENS (comma-separated; required off
 * loopback), API_CORS_ORIGINS (comma-separated, or *), API_RATE_LIMIT (per minute).
 */
import { parseApiConfig } from "../src/api/config";
import { loadDocsAssets } from "../src/api/http/docs";
import { BASE, createApiServer } from "../src/api/http/server";
import { createApiService } from "../src/api/service";
import { fileSnapshotSource } from "../src/api/snapshot";
import { WEB_PUBLISH_DIR } from "../src/node/dataPaths";

const parsed = parseApiConfig(process.argv.slice(2), process.env, WEB_PUBLISH_DIR);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
const { config } = parsed;
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const source = fileSnapshotSource({ dir: config.dataDir, log });
const server = createApiServer({
  service: createApiService(source),
  docs: await loadDocsAssets(),
  tokens: config.tokens,
  corsOrigins: config.corsOrigins,
  rateLimitPerMinute: config.rateLimitPerMinute,
  log,
});

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`Cannot listen on ${config.host}:${config.port}: ${error.code === "EADDRINUSE" ? "the port is in use (try --port)" : error.message}`);
  source.close();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  log(`recommendations API on http://${host}:${port}${BASE} (docs: ${BASE}/docs) — loading data from ${config.dataDir}`);
  if (config.tokens.length) log(`bearer auth on (${config.tokens.length} token${config.tokens.length === 1 ? "" : "s"})`);
});

const stop = () => {
  source.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
