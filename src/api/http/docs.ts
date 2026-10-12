/**
 * Swagger UI, served from the `swagger-ui-dist` package so the docs work
 * offline and the page loads nothing from outside this server. Only the files
 * listed here are served; nothing is looked up from the request path.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface DocsAsset {
  contentType: string;
  body: Buffer | string;
}

const PACKAGE_FILES: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "text/javascript; charset=utf-8",
  "favicon-32x32.png": "image/png",
  "favicon-16x16.png": "image/png",
};

/**
 * The page lives at `<base>/docs`, so its relative links resolve under
 * `<base>/`: assets at `<base>/docs/…`, the spec at `<base>/openapi.json`.
 */
export const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rental home recommendations API</title>
  <link rel="icon" type="image/png" href="./docs/favicon-32x32.png">
  <link rel="stylesheet" href="./docs/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="./docs/swagger-ui-bundle.js"></script>
  <script src="./docs/init.js"></script>
</body>
</html>
`;

/** A file rather than an inline script, so the page's CSP can forbid inline scripts. */
const INIT_SCRIPT = `window.ui = SwaggerUIBundle({
  url: "./openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  tryItOutEnabled: true,
  displayRequestDuration: true,
  defaultModelsExpandDepth: 0,
  docExpansion: "list",
  filter: true,
});
`;

/** Content-Security-Policy for the docs page and its assets: this server only. */
export const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // Swagger UI sets element styles at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Load every docs asset once, at startup. */
export async function loadDocsAssets(): Promise<ReadonlyMap<string, DocsAsset>> {
  const root = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));
  const assets = new Map<string, DocsAsset>([["init.js", { contentType: "text/javascript; charset=utf-8", body: INIT_SCRIPT }]]);
  await Promise.all(Object.entries(PACKAGE_FILES).map(async ([name, contentType]) => {
    assets.set(name, { contentType, body: await readFile(join(root, name)) });
  }));
  return assets;
}
