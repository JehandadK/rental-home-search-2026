import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf, sourceFiles } from "./imports";
import { KNOWN_VIOLATIONS } from "./knownViolations";
import { classify, violation, type ImportEdge } from "./layers";

const ROOT = resolve(import.meta.dirname, "..", "..");

const edge = (from: string, to: string, options: Partial<ImportEdge> = {}): ImportEdge =>
  ({ from, to, external: false, typeOnly: false, ...options });

describe("layer rules", () => {
  it("rejects imports against the dependency direction", () => {
    expect(violation(edge("src/domain/scoring.ts", "src/web/App.tsx"))).toMatch(/domain may not import web/);
    expect(violation(edge("src/data-layer/ingestion/service.ts", "src/storage/json/dataStore.ts"))).toMatch(/data-layer may not import storage/);
    expect(violation(edge("src/web/App.tsx", "src/storage/json/dataStore.ts"))).toMatch(/web may not import storage/);
    expect(violation(edge("src/web/App.tsx", "src/collectors/athome/parse.ts"))).toMatch(/web may not import collectors/);
    expect(violation(edge("src/collectors/athome/parse.ts", "src/storage/json/dataStore.ts"))).toMatch(/collectors may not import storage/);
    expect(violation(edge("src/collectors/athome/parse.ts", "src/refresh/refreshPlan.ts"))).toMatch(/collectors may not import refresh/);
    expect(violation(edge("src/node/jsonFile.ts", "src/domain/types.ts"))).toMatch(/node may not import domain/);
  });

  it("allows the dependency direction", () => {
    expect(violation(edge("src/web/App.tsx", "src/domain/scoring.ts"))).toBeNull();
    expect(violation(edge("src/data-layer/ingestion/service.ts", "src/domain/listingDedup.ts"))).toBeNull();
    expect(violation(edge("src/storage/json/dataStore.ts", "src/data-layer/contracts.ts"))).toBeNull();
    expect(violation(edge("src/storage/json/dataStore.ts", "src/node/jsonFile.ts"))).toBeNull();
    expect(violation(edge("src/refresh/refreshPlan.ts", "src/collectors/shared/captureStore.ts"))).toBeNull();
    expect(violation(edge("scripts/scrape.ts", "src/storage/json/dataStore.ts"))).toBeNull();
  });

  it("limits collectors and the web app to the public data-layer modules", () => {
    expect(violation(edge("src/collectors/athome/parse.ts", "src/data-layer/ingestion/contracts.ts"))).toBeNull();
    expect(violation(edge("src/collectors/athome/parse.ts", "src/data-layer/ingestion/errors.ts"))).toBeNull();
    expect(violation(edge("src/collectors/athome/parse.ts", "src/data-layer/contentIdentity.ts"))).toBeNull();
    expect(violation(edge("src/collectors/athome/parse.ts", "src/data-layer/ingestion/portalPolicy.ts"))).toMatch(/only data-layer contracts/);
    expect(violation(edge("src/web/App.tsx", "src/data-layer/contracts.ts", { typeOnly: true }))).toBeNull();
    expect(violation(edge("src/web/App.tsx", "src/data-layer/contracts.ts"))).toMatch(/only type-only imports of data-layer contracts/);
    expect(violation(edge("src/web/App.tsx", "src/data-layer/errors.ts", { typeOnly: true }))).toMatch(/web may not import data-layer/);
  });

  it("rejects CLI, test, and persisted-data imports; exempts tests", () => {
    expect(violation(edge("src/collectors/nifty/parse.ts", "scripts/merge-nifty.ts"))).toMatch(/CLI entry point/);
    expect(violation(edge("scripts/backfill-parking.ts", "scripts/enrich-details.ts"))).toMatch(/CLI entry point/);
    expect(violation(edge("src/domain/scoring.ts", "src/domain/scoring.test.ts"))).toMatch(/test file/);
    expect(violation(edge("src/domain/reference.ts", "src/data/pois.json"))).toMatch(/persisted data/);
    expect(violation(edge("scripts/data.ts", "data/reference/v1/manifest.json"))).toMatch(/persisted data/);
    // The web app fetches its published assets; it never bundles them (M5).
    expect(violation(edge("src/web/data/httpClient.ts", "public/data/listings.json"))).toMatch(/persisted data/);
    expect(violation(edge("src/domain/places.ts", "public/data/reference.json"))).toMatch(/persisted data/);
    expect(violation(edge("src/web/App.tsx", "src/data/pois.json"))).toMatch(/persisted data/);
    expect(violation(edge("scripts/scrape.test.ts", "scripts/scrape.ts"))).toBeNull();
    expect(violation(edge("src/domain/scoring.test.ts", "src/storage/json/dataStore.ts"))).toBeNull();
    expect(violation(edge("src/storage/json/dataStore.ts", "src/storage/json/listingRepository.contract.ts"))).toMatch(/test file/);
    expect(violation(edge("src/storage/json/listingRepository.contract.ts", "src/storage/json/dataStore.ts"))).toBeNull();
  });

  it("keeps Node built-ins out of browser-safe layers", () => {
    const node = (from: string, to: string) => violation(edge(from, to, { external: true }));
    for (const from of ["src/domain/geo.ts", "src/data-layer/contracts.ts", "src/web/App.tsx", "src/integrations/geocode.ts"]) {
      expect(node(from, "node:fs")).toMatch(/Node built-in/);
      expect(node(from, "path")).toMatch(/Node built-in/);
    }
    expect(node("src/storage/json/dataStore.ts", "node:fs")).toBeNull();
    expect(node("src/collectors/shared/captureStore.ts", "node:crypto")).toBeNull();
    expect(node("src/web/App.tsx", "react")).toBeNull();
  });

  it("limits npm packages per layer", () => {
    const pkg = (from: string, to: string) => violation(edge(from, to, { external: true }));
    expect(pkg("src/web/main.tsx", "react-dom/client")).toBeNull();
    expect(pkg("src/collectors/athome/parse.ts", "cheerio")).toBeNull();
    expect(pkg("scripts/scrape.ts", "anything")).toBeNull();
    expect(pkg("src/domain/scoring.ts", "react")).toMatch(/domain may not use package react/);
    expect(pkg("src/data-layer/contracts.ts", "cheerio")).toMatch(/may not use package cheerio/);
    expect(pkg("src/web/App.tsx", "cheerio")).toMatch(/may not use package cheerio/);
    expect(pkg("src/storage/json/dataStore.ts", "@scope/db/client")).toMatch(/may not use package @scope\/db/);
  });

  it("classifies layer directories and CLI entry points, and rejects unplaced files", () => {
    expect(classify("src/web/components/MapView.tsx")).toBe("web");
    expect(classify("src/storage/json/jsonListingRepository.ts")).toBe("storage");
    expect(classify("src/collectors/athome/athome.ts")).toBe("collectors");
    expect(classify("scripts/refresh.ts")).toBe("cli");
    expect(classify("src/collectors/suumo/parse.ts")).toBe("collectors");
    expect(() => classify("scripts/lib/unplaced.ts")).toThrow(/has no layer/);
    expect(() => classify("scripts/helpers/unplaced.ts")).toThrow(/has no layer/);
    expect(() => classify("src/unplaced.ts")).toThrow(/has no layer/);
  });
});

describe("import extraction", () => {
  const withFixture = (files: Record<string, string>, run: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "architecture-"));
    try {
      mkdirSync(join(root, "scripts"));
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("finds every import form and whether it is type-only", () => {
    withFixture({
      "src/domain/a.ts": [
        'import { x } from "./b";',
        'import type { T } from "./c";',
        'import { type U, type V } from "./d";',
        'import { type W, y } from "./e";',
        'export * from "./f";',
        'export { type G } from "./g";',
        'export { h, type H } from "./h";',
        'import i = require("./i");',
        'const j = require("./j");',
        'const k = import("./k");',
        'type L = import("./l").L;',
        'import "node:fs";',
      ].join("\n"),
      ...Object.fromEntries("bcdefghijkl".split("").map((name) => [`src/domain/${name}.ts`, ""])),
    }, (root) => {
      expect(sourceFiles(root)).toContain("src/domain/a.ts");
      const found = importsOf(root, "src/domain/a.ts").map(({ to, typeOnly }) => `${to}${typeOnly ? " (type)" : ""}`);
      expect(found).toEqual([
        "src/domain/b.ts", "src/domain/c.ts (type)", "src/domain/d.ts (type)", "src/domain/e.ts",
        "src/domain/f.ts", "src/domain/g.ts (type)", "src/domain/h.ts", "src/domain/i.ts", "src/domain/j.ts",
        "src/domain/k.ts", "src/domain/l.ts (type)", "node:fs",
      ]);
    });
  });

  it("rejects specifiers it cannot check", () => {
    const fails = (text: string, message: RegExp) => withFixture({ "src/domain/a.ts": text },
      (root) => expect(() => importsOf(root, "src/domain/a.ts")).toThrow(message));
    fails('import { x } from "/src/storage/json/dataStore";', /use a relative path/);
    fails('import { x } from "src/storage/json/dataStore";', /use a relative path/);
    fails("const k = import(`./${name}`);", /string literals/);
    fails("const k = require(name);", /string literals/);
    fails('import { x } from "./missing";', /cannot resolve/);
  });
});

describe("source tree", () => {
  const edges = sourceFiles(ROOT).flatMap((file) => importsOf(ROOT, file));
  const key = (from: string, to: string) => `${from} -> ${to}`;
  const actual = new Map<string, string>();
  for (const found of edges) {
    const reason = violation(found);
    if (reason) actual.set(key(found.from, found.to), reason);
  }
  const known = new Set(KNOWN_VIOLATIONS.map((entry) => key(entry.from, entry.to)));

  it("has a layer for every source file", () => {
    expect(() => sourceFiles(ROOT).forEach(classify)).not.toThrow();
  });

  it("follows the layer rules, apart from listed known violations", () => {
    const unexpected = [...actual].filter(([edgeKey]) => !known.has(edgeKey)).map(([edgeKey, reason]) => `${edgeKey}: ${reason}`);
    expect(unexpected).toEqual([]);
  });

  it("lists only violations that still occur", () => {
    expect([...known].filter((edgeKey) => !actual.has(edgeKey))).toEqual([]);
    expect(known.size).toBe(KNOWN_VIOLATIONS.length);
  });
});
