/** Convert a completed native Chrome HTML download into the standard capture envelope.
 * No network/browser access. Use the download's finalUrl and endTime as metadata.
 * Then run capture:import on the printed path to update/checkpoint the source.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { athomeDownloadedCapture } from "./lib/athomeCapture";
import { CAPTURE_DIR, captureKey, validateCapture } from "./lib/captureStore";
import { atomicWriteJson } from "./lib/dataStore";
import { parseAthomePage } from "./lib/athome";
import { assertParsedFamilies } from "./lib/captureValidation";

const args = process.argv.slice(2);
const flag = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const file = flag("--file"), url = flag("--url"), capturedAt = flag("--captured-at");
if (!file || !url || !capturedAt) throw new Error("Usage: import-athome-html --file <download.html> --url <finalUrl> --captured-at <download endTime>");
const capture = athomeDownloadedCapture(await readFile(file, "utf8"), url, capturedAt);
validateCapture(capture);
const parsed = parseAthomePage(capture.html, capture.city);
assertParsedFamilies(capture, parsed);
const path = join(CAPTURE_DIR, "exports", `athome-native-${captureKey("athome", capture.url)}.json`);
await atomicWriteJson(path, { captures: [capture], errors: [] });
console.log(JSON.stringify({ file: path, city: capture.city, page: capture.page, familyRows: parsed.length, htmlBytes: Buffer.byteLength(capture.html) }));
