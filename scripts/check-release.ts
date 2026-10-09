/**
 * Check the static site `npm run build` wrote to dist/ before it is uploaded:
 *
 *   index.html          the page; every URL in it is relative
 *   assets/             the app bundle (hashed .js/.css), with no theme in it
 *   themes/default.css  the theme, linked from index.html, never bundled
 *   data/               listings.json and reference.json, loadable by the app
 *
 * Anything else in dist/ (source maps, stray files) fails the check, so the
 * upload is exactly the app, its theme, and its data. No server is needed:
 * any static host can serve the directory, from its root or a sub-path.
 *
 *   npm run check:release [dir]   (default: dist)
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHttpWebDataClient, LISTINGS_ASSET, REFERENCE_ASSET } from "../src/web/data/httpClient";

export const THEME_FILE = "themes/default.css";
const ALLOWED: readonly ((file: string) => boolean)[] = [
  (file) => file === "index.html",
  (file) => /^assets\/[\w-]+\.(js|css)$/.test(file),
  (file) => /^themes\/[\w-]+\.css$/.test(file),
  (file) => file === `data/${LISTINGS_ASSET}` || file === `data/${REFERENCE_ASSET}`,
];

/** Problems with the release in `dir`; empty when it is ready to upload. */
export async function checkRelease(dir: string): Promise<string[]> {
  const problems: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => null);
  if (!entries) return [`${dir} does not exist; run npm run build first`];
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  for (const file of files) if (!ALLOWED.some((allowed) => allowed(file))) problems.push(`${file} does not belong in the release`);
  if (!files.includes("index.html")) return [...problems, "index.html is missing"];

  const html = await readFile(join(dir, "index.html"), "utf8");
  const urls = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
  for (const url of urls) {
    if (/^(?:[a-z]+:|\/)/i.test(url)) problems.push(`index.html: ${url} is not a relative URL, so the site breaks under a sub-path`);
    else if (!files.includes(url.replace(/^\.\//, ""))) problems.push(`index.html: ${url} is not in the release`);
  }
  if (!urls.some((url) => url.replace(/^\.\//, "") === THEME_FILE)) problems.push(`index.html does not link ${THEME_FILE}`);

  for (const file of files.filter((name) => name.startsWith("assets/"))) {
    const text = await readFile(join(dir, file), "utf8");
    if (file.endsWith(".css") && /--rs-[\w-]+\s*:/.test(text)) problems.push(`${file} defines theme properties; they belong in ${THEME_FILE}`);
    if (/url\(\s*['"]?\/(?!\/)|["'`]\/(?:assets|data|themes)\//.test(text)) problems.push(`${file} refers to a root-relative URL, so the site breaks under a sub-path`);
  }

  const client = createHttpWebDataClient({
    baseUrl: "",
    fetch: (async (asset: string) => {
      try {
        return new Response(await readFile(join(dir, "data", asset)));
      } catch {
        return new Response(null, { status: 404 });
      }
    }) as typeof fetch,
  });
  await client.queryListings().then(
    ({ data }) => { if (!data.listings.length) problems.push(`data/${LISTINGS_ASSET} has no listings`); },
    (error: Error) => problems.push(`data/${LISTINGS_ASSET}: ${error.message}`),
  );
  await client.loadReferenceSnapshot().catch((error: Error) => problems.push(`data/${REFERENCE_ASSET}: ${error.message}`));
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.argv[2] ?? "dist");
  const problems = await checkRelease(dir);
  if (problems.length) {
    console.error(`${dir} is not ready to upload:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${dir} is ready to upload: the app, ${THEME_FILE}, and its data, all with relative URLs.`);
}
