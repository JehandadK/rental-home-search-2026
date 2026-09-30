/** Local public-page capture spool. Never stores cookies, form secrets or browser storage. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, DATA_DIR } from "../../src/storage/json/dataStore";
export const CAPTURE_DIR = join(DATA_DIR, ".captures");
export interface PageCapture {
  schemaVersion: 1;
  source: "athome" | "roomspot" | "suumo" | "nifty";
  city: string;
  url: string;
  page: number;
  capturedAt: string;
  httpStatus: number;
  html: string;
  sha256?: string;
}
export function captureKey(source: string, url: string): string {
  return createHash("sha256").update(source + "|" + url).digest("hex");
}
export function validateCapture(c: PageCapture): void {
  const hosts = { athome: "www.athome.co.jp", roomspot: "www.roomspot.net", suumo: "suumo.jp", nifty: "myhome.nifty.com" };
  if (c.schemaVersion !== 1 || !(c.source in hosts) || new URL(c.url).hostname !== hosts[c.source] || !Number.isInteger(c.page) || c.page < 1 || !Number.isFinite(Date.parse(c.capturedAt))) throw new Error("Invalid capture metadata");
  if (c.httpStatus !== 200 || typeof c.html !== "string" || c.html.length > 12_000_000) throw new Error("Failed/oversized page capture");
  const marker = { athome: "p-property", roomspot: "kokoku-list", suumo: "cassetteitem", nifty: "detail_" }[c.source];
  if (!c.html.includes(marker)) throw new Error(`Unrecognized ${c.source} results; not evidence of an empty market`);
}
export async function saveCapture(c: PageCapture): Promise<string> {
  validateCapture(c);
  const path = join(CAPTURE_DIR, c.source, captureKey(c.source, c.url) + ".json");
  await atomicWriteJson(path, { ...c, sha256: createHash("sha256").update(c.html).digest("hex") });
  return path;
}
export async function readCapture(source: string, url: string, maxAgeMs = 6 * 3600000): Promise<PageCapture | null> {
  try {
    const c = JSON.parse(await readFile(join(CAPTURE_DIR, source, captureKey(source, url) + ".json"), "utf8")) as PageCapture;
    validateCapture(c);
    if (c.url !== url || c.sha256 !== createHash("sha256").update(c.html).digest("hex")) throw new Error("Capture checksum/identity mismatch");
    return Date.now() - Date.parse(c.capturedAt) <= maxAgeMs ? c : null;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export async function cachedPage(meta: Pick<PageCapture, "source" | "city" | "url" | "page">, fetcher: () => Promise<string>): Promise<PageCapture> {
  const cached = await readCapture(meta.source, meta.url);
  if (cached) return cached;
  const c: PageCapture = { ...meta, schemaVersion: 1, capturedAt: new Date().toISOString(), httpStatus: 200, html: await fetcher() };
  await saveCapture(c);
  return c;
}
