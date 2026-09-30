/**
 * Browser storage is user state, and M6 put it behind one adapter. This finds
 * every direct use of localStorage/sessionStorage/indexedDB in a source file:
 * the bare global, a property access (`window.localStorage`), or an element
 * access with a literal name (`window["localStorage"]`). Comments and plain
 * strings are ignored.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isTestFile } from "./layers";

const STORAGE_GLOBALS = new Set(["localStorage", "sessionStorage", "indexedDB"]);

/** The only production file that may touch browser storage. */
export const BROWSER_STORAGE_ADAPTER = "src/web/userState/store.ts";

export interface StorageAccess {
  file: string;
  line: number;
  name: string;
}

export function browserStorageAccesses(root: string, file: string): StorageAccess[] {
  const text = readFileSync(join(root, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: StorageAccess[] = [];
  const add = (node: ts.Node, name: string) =>
    found.push({ file, name, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && STORAGE_GLOBALS.has(node.text)) add(node, node.text);
    else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      && STORAGE_GLOBALS.has(node.argumentExpression.text)) add(node, node.argumentExpression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Why a file's storage access breaks the rule, or null when it is allowed. */
export function storageViolation(access: StorageAccess): string | null {
  if (isTestFile(access.file) || access.file === BROWSER_STORAGE_ADAPTER) return null;
  return `${access.file}:${access.line} uses ${access.name}; read and write user state through ${BROWSER_STORAGE_ADAPTER}`;
}
