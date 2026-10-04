import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRelease } from "./check-release";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const INDEX = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="./themes/default.css" />
<script type="module" crossorigin src="./assets/index-abc123.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-abc123.css">
</head><body><div id="root" class="rs-app"></div></body></html>`;

const reference = (records: unknown[]) => JSON.stringify({ revision: "r1", cities: { records }, boundaries: { records }, places: { records } });

async function release(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "release-check-")); roots.push(dir);
  const all = {
    "index.html": INDEX,
    "assets/index-abc123.js": "console.log(1)",
    "assets/index-abc123.css": ".a{color:var(--rs-ink)}",
    "themes/default.css": ":root{--rs-ink:#000}",
    "data/listings.json": JSON.stringify([{ id: "a", source: "suumo" }]),
    "data/reference.json": reference([]),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  }
  return dir;
}

describe("release check", () => {
  it("accepts the app, its theme, and its data with relative URLs", async () => {
    expect(await checkRelease(await release())).toEqual([]);
  });

  it("rejects files that are not part of the site", async () => {
    expect(await checkRelease(await release({ "assets/index-abc123.js.map": "{}", "notes.txt": "" }))).toEqual([
      "assets/index-abc123.js.map does not belong in the release",
      "notes.txt does not belong in the release",
    ]);
  });

  it("rejects root-relative and missing URLs and a missing theme link", async () => {
    const html = INDEX.replace("./assets/index-abc123.js", "/assets/index-abc123.js").replace(`<link rel="stylesheet" href="./themes/default.css" />`, "")
      .replace("./assets/index-abc123.css", "./assets/gone.css");
    expect(await checkRelease(await release({ "index.html": html }))).toEqual([
      "index.html: /assets/index-abc123.js is not a relative URL, so the site breaks under a sub-path",
      "index.html: ./assets/gone.css is not in the release",
      "index.html does not link themes/default.css",
    ]);
  });

  it("rejects a theme bundled into the app stylesheet", async () => {
    expect(await checkRelease(await release({ "assets/index-abc123.css": ":root{--rs-ink:#000}" })))
      .toEqual(["assets/index-abc123.css defines theme properties; they belong in themes/default.css"]);
  });

  it("rejects root-relative URLs inside the bundle", async () => {
    expect(await checkRelease(await release({
      "assets/index-abc123.js": 'fetch("/data/listings.json")',
      "assets/index-abc123.css": ".a{background:url(/assets/x.png)}",
    }))).toEqual([
      "assets/index-abc123.css refers to a root-relative URL, so the site breaks under a sub-path",
      "assets/index-abc123.js refers to a root-relative URL, so the site breaks under a sub-path",
    ]);
  });

  it("says when there is no release to check", async () => {
    const dir = join(await release(), "missing");
    expect(await checkRelease(dir)).toEqual([`${dir} does not exist; run npm run build first`]);
  });

  it("rejects data the app cannot load", async () => {
    expect(await checkRelease(await release({ "data/listings.json": "[]", "data/reference.json": "{}" }))).toEqual([
      "data/listings.json has no listings",
      "data/reference.json: reference.json is not a reference snapshot",
    ]);
  });
});
