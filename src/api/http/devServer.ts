/**
 * The API inside the website's own dev and preview servers, so `npm run dev`
 * serves the site and the API together: the site at /, the API at /api/v1
 * (REST, Swagger UI at /api/v1/docs, MCP at /api/v1/mcp).
 *
 * It ranks the files the site itself serves (public/data), loading them in
 * the background so the site never waits for it; until then the API answers
 * 503. Settings come from the same API_* variables as `npm run api` (CORS,
 * rate limit, data); the host and port are the dev server's.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseApiConfig } from "../config";
import { createApiService } from "../service";
import { publishedSnapshotSource } from "../snapshot";
import { loadDocsAssets } from "./docs";
import { createNodeListener } from "./server";

export const DEV_MOUNT_PATH = "/api";

export interface DevApi {
  /** Connect-style middleware for requests under DEV_MOUNT_PATH (the prefix already stripped). */
  handle(request: IncomingMessage, response: ServerResponse): void;
  close(): void;
}

export async function createDevApi(options: {
  /** The directory the site publishes its data from (public/data). */
  dataDir: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}): Promise<DevApi | null> {
  const { env, log } = options;
  // Only the API's own settings: the dev server owns the host and port.
  const parsed = parseApiConfig([], {
    API_CORS_ORIGINS: env.API_CORS_ORIGINS, API_RATE_LIMIT: env.API_RATE_LIMIT, API_DATA: env.API_DATA,
  }, options.dataDir);
  if (!parsed.ok) {
    log(`recommendations API not mounted: ${parsed.error}`);
    return null;
  }
  const { config } = parsed;
  const source = publishedSnapshotSource({ from: config.dataDir, log });
  const listener = createNodeListener({
    service: createApiService(source),
    docs: await loadDocsAssets(),
    corsOrigins: config.corsOrigins,
    rateLimitPerMinute: config.rateLimitPerMinute,
    mountPath: DEV_MOUNT_PATH,
  });
  return { handle: listener, close: () => source.close() };
}
