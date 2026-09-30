/** Reads every import/re-export/dynamic import in the source tree with the TypeScript parser. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { ImportEdge } from "./layers";

const SCANNED_ROOTS = ["src", "scripts"];
const SKIPPED_DIRS = ["src/data"];
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];
/** Repo directories: a bare specifier starting with one is an unsupported path alias, not a package. */
const REPO_DIRS = ["src", "scripts", "tools", "data", "public"];

function toRepoPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const scanned of SCANNED_ROOTS) {
    for (const entry of readdirSync(join(root, scanned), { recursive: true, encoding: "utf8" })) {
      const path = `${scanned}/${entry.split(sep).join("/")}`;
      if (SKIPPED_DIRS.some((dir) => path.startsWith(`${dir}/`))) continue;
      if (/\.tsx?$/.test(path)) files.push(path);
    }
  }
  return files.sort();
}

function resolveRelative(root: string, from: string, specifier: string): string {
  const base = resolve(root, dirname(from), specifier);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return toRepoPath(root, candidate);
  }
  throw new Error(`${from}: cannot resolve import "${specifier}"`);
}

function elementsAreTypeOnly(elements: readonly { isTypeOnly: boolean }[]): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false; // side-effect import
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return !clause.name && !!bindings && ts.isNamedImports(bindings) && elementsAreTypeOnly(bindings.elements);
}

export function importsOf(root: string, from: string): ImportEdge[] {
  const text = readFileSync(join(root, from), "utf8");
  const file = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, false,
    from.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];
  const add = (specifier: string, typeOnly: boolean) => {
    if (specifier.startsWith("/") || REPO_DIRS.includes(specifier.split("/")[0])) {
      throw new Error(`${from}: use a relative path instead of "${specifier}" so layers can be checked`);
    }
    const external = !specifier.startsWith(".");
    edges.push({ from, to: external ? specifier : resolveRelative(root, from, specifier), external, typeOnly });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, importClauseIsTypeOnly(node.importClause));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      add(node.moduleSpecifier.text, node.isTypeOnly || (!!clause && ts.isNamedExports(clause) && elementsAreTypeOnly(clause.elements)));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [argument] = node.arguments;
      if (!argument || !ts.isStringLiteralLike(argument)) {
        throw new Error(`${from}: module specifiers must be string literals so layers can be checked`);
      }
      add(argument.text, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return edges;
}
