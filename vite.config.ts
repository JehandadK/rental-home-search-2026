import { join, resolve } from "node:path";
import { defineConfig, type Connect, type Logger, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createDevApi, DEV_MOUNT_PATH } from "./src/api/http/devServer";
import { gzipMiddleware } from "./src/api/http/gzip";

/**
 * Compress what the dev and preview servers send. The published data is ~32 MB
 * raw and ~3.7 MB gzipped; uncompressed, the site crawls on another device.
 */
function gzipResponses(): Plugin {
  const compress = gzipMiddleware({ skipPrefix: DEV_MOUNT_PATH });
  return {
    name: "gzip-responses",
    configureServer(server) { server.middlewares.use(compress); },
    configurePreviewServer(server) { server.middlewares.use(compress); },
  };
}

/**
 * Serve the recommendations API beside the site in `npm run dev` and
 * `npm run preview`: http://localhost:5173/api/v1 (Swagger UI at /api/v1/docs,
 * MCP at /api/v1/mcp). It ranks the data the server itself serves. The built
 * site in dist/ stays static; this exists only while a Vite server runs.
 */
function recommendationsApi(): Plugin {
  const mount = async (middlewares: Connect.Server, dataDir: string, logger: Logger, onClose: (stop: () => void) => void) => {
    const api = await createDevApi({ dataDir, env: process.env, log: (line) => logger.info(`[api] ${line}`, { timestamp: true }) });
    if (!api) return;
    // Added before Vite's own middleware, so the site's fallback never answers /api.
    middlewares.use(DEV_MOUNT_PATH, api.handle);
    onClose(api.close);
  };
  return {
    name: "recommendations-api",
    async configureServer(server) {
      await mount(server.middlewares, join(server.config.publicDir, "data"), server.config.logger,
        (stop) => server.httpServer?.once("close", stop));
    },
    async configurePreviewServer(server) {
      // The preview serves the build, so the API ranks the build's data.
      await mount(server.middlewares, resolve(server.config.root, server.config.build.outDir, "data"), server.config.logger,
        (stop) => server.httpServer.once("close", stop));
    },
  };
}

export default defineConfig({
  plugins: [react(), gzipResponses(), recommendationsApi()],
  // Relative URLs everywhere, so the built site works from any sub-path
  // (e.g. https://example.com/rentals/) with no rebuild.
  base: "./",
  // Reachable from other devices on the network, for `npm run dev` and `npm run preview` alike.
  server: { port: 5173, host: true },
  preview: { host: true },
});
