/**
 * Layer map and dependency rules from DATA_ARCHITECTURE.md
 * ("Target layers and dependency rules"). Paths are repo-relative, POSIX.
 */
import { builtinModules } from "node:module";

export type Layer =
  | "domain"
  | "data-layer"
  | "storage"
  | "collectors"
  | "refresh"
  | "web"
  | "cli"
  | "node"
  | "integrations"
  | "persisted-data"
  | "test";

/** Target directories (M4 end state). */
const TARGET_DIRS: [prefix: string, layer: Layer][] = [
  ["src/web/", "web"],
  ["src/domain/", "domain"],
  ["src/data-layer/", "data-layer"],
  ["src/storage/", "storage"],
  ["src/collectors/", "collectors"],
  ["src/refresh/", "refresh"],
  ["src/node/", "node"],
  ["src/integrations/", "integrations"],
  ["data/", "persisted-data"],
  // Published copies the web app fetches at runtime; never bundled.
  ["public/", "persisted-data"],
];

/** Tests and shared test harnesses (`*.contract.ts`): exempt as importers, never imported by production code. */
export function isTestFile(path: string): boolean {
  return /\.(test|contract)\.tsx?$/.test(path);
}

export function classify(path: string): Layer {
  if (isTestFile(path)) return "test";
  for (const [prefix, layer] of TARGET_DIRS) if (path.startsWith(prefix)) return layer;
  // Only CLI entry points live in scripts/; shared code belongs in a src/ layer.
  if (path.startsWith("scripts/") && !path.slice("scripts/".length).includes("/")) return "cli";
  throw new Error(`${path} has no layer: place it in a target directory from DATA_ARCHITECTURE.md`);
}

/** Data-layer modules that collectors and (type-only) the web app may use. */
export function isDataLayerPublic(path: string): boolean {
  if (classify(path) !== "data-layer") return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "contracts.ts" || name === "errors.ts" || name === "contentIdentity.ts";
}

function isDataLayerContract(path: string): boolean {
  return isDataLayerPublic(path) && path.endsWith("/contracts.ts");
}

const ALLOWED: Record<Exclude<Layer, "test" | "cli" | "persisted-data">, Layer[]> = {
  domain: ["domain"],
  "data-layer": ["data-layer", "domain"],
  storage: ["storage", "data-layer", "domain", "node"],
  collectors: ["collectors", "domain", "integrations", "node"],
  refresh: ["refresh", "collectors", "data-layer", "storage", "domain", "node"],
  web: ["web", "domain", "integrations"],
  node: ["node"],
  integrations: ["integrations", "domain"],
};

const NO_NODE: Layer[] = ["domain", "data-layer", "web", "integrations"];
const NODE_BUILTINS = new Set(builtinModules);

/** npm packages each layer may use; layers not listed may use none. The CLI may use any. */
const PACKAGES: Partial<Record<Layer, string[]>> = {
  web: ["react", "react-dom"],
  collectors: ["cheerio", "domhandler"],
};

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export interface ImportEdge {
  /** Importing file. */
  from: string;
  /** Resolved repo-relative file for relative imports; the bare specifier otherwise. */
  to: string;
  external: boolean;
  typeOnly: boolean;
}

/** Returns why an import breaks the layer rules, or null when it is allowed. */
export function violation(edge: ImportEdge): string | null {
  const fromLayer = classify(edge.from);
  if (fromLayer === "test") return null;

  if (edge.external) {
    const isBuiltin = edge.to.startsWith("node:") || NODE_BUILTINS.has(packageName(edge.to));
    if (isBuiltin) return NO_NODE.includes(fromLayer) ? `${fromLayer} may not use Node built-in ${edge.to}` : null;
    if (fromLayer === "cli" || PACKAGES[fromLayer]?.includes(packageName(edge.to))) return null;
    return `${fromLayer} may not use package ${packageName(edge.to)}`;
  }

  const toLayer = classify(edge.to);
  if (toLayer === "test") return `${fromLayer} imports a test file`;
  if (toLayer === "cli") return "nothing but tests may import a CLI entry point";
  if (toLayer === "persisted-data") return "persisted data is read through storage or fetched, not imported";
  if (fromLayer === "cli") return null;
  if (fromLayer === "persisted-data") return null;

  if (ALLOWED[fromLayer].includes(toLayer)) return null;
  if (toLayer === "data-layer" && isDataLayerPublic(edge.to)) {
    if (fromLayer === "collectors") return null;
    if (fromLayer === "web" && edge.typeOnly && isDataLayerContract(edge.to)) return null;
  }
  const detail = toLayer === "data-layer" && (fromLayer === "collectors" || fromLayer === "web")
    ? fromLayer === "web"
      ? " (only type-only imports of data-layer contracts)"
      : " (only data-layer contracts, errors, and contentIdentity are public)"
    : "";
  return `${fromLayer} may not import ${toLayer}${detail}`;
}
