/**
 * The theme is a separate stylesheet (public/themes/default.css) that a host
 * site may replace or merge. That only works if the app itself carries no
 * colours and the default theme defines every property the app reads.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isTestFile } from "./layers";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DEFAULT_THEME = "public/themes/default.css";

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]/g;
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");
const webFiles = () => readdirSync(resolve(ROOT, "src/web"), { recursive: true, encoding: "utf8" })
  .map((entry) => `src/web/${entry.split(sep).join("/")}`)
  .filter((file) => /\.(tsx?|css)$/.test(file) && !isTestFile(file));

describe("theme separation", () => {
  it("keeps colour literals out of the app's styles and components", () => {
    const found = webFiles().flatMap((file) =>
      [...withoutComments(read(file)).matchAll(COLOUR_LITERAL)].map((match) => `${file}: ${match[0]}`));
    expect(found).toEqual([]);
  });

  it("defines every theme property the app reads in the default theme", () => {
    const defined = new Set([...read(DEFAULT_THEME).matchAll(/(--rs-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const used = new Set(webFiles().flatMap((file) =>
      [...withoutComments(read(file)).matchAll(/--rs-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((match) => match[0])));
    expect([...used].filter((property) => !defined.has(property))).toEqual([]);
  });

  it("defines theme properties only in the theme", () => {
    const definitions = webFiles().flatMap((file) =>
      [...withoutComments(read(file)).matchAll(/(--rs-[a-z0-9-]+)\s*:/g)].map((match) => `${file}: ${match[1]}`));
    expect(definitions).toEqual([]);
  });
});
