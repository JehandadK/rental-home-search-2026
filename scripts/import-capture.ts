/** Import native-browser public captures; no browser control or network in this script. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { saveCapture, type PageCapture, CAPTURE_DIR } from "./lib/captureStore";
import { readSource, writeSource, atomicWriteJson } from "./lib/dataStore";
import { parseAthomePage, athomeMatchKeys, mergeAthomeIncremental } from "./lib/athome";
import { parseRoomspotPage, roomspotMatchKeys, mergeRoomspotIncremental } from "./lib/roomspot";
import { trackingKey } from "./lib/lifecycle";
import { parseNiftyPage, niftyMatchKeys, mergeNiftyIncremental } from "./lib/nifty";
import { acquireRefreshLock, latestResumableRun, readRefreshLedger, saveRefreshRun } from "./lib/refreshLedger";
import { DEFAULT_INCREMENTAL_PAGE_CEILING, DEPENDENCIES, positiveInteger } from "./lib/refreshPlan";
import { assertParsedFamilies, newerRows } from "./lib/captureValidation";
import { parsePage as parseSuumoPage } from "./scrape";
import { suumoMatchKeys, mergeSuumoIncremental } from "./lib/suumoIncremental";

interface Progress { imported: string[]; cities: Record<string, { pages: number; knownPages: number; added: number; updatedAt: string; done: boolean }> }
const args = process.argv.slice(2);
const input = args[args.indexOf("--file") + 1];
if (!args.includes("--file") || !input) throw new Error("Usage: npm run capture:import -- --file <native-browser-export.json> [--max-pages N]");
const maxPages = positiveInteger(
  args.includes("--max-pages") ? args[args.indexOf("--max-pages") + 1] : undefined,
  DEFAULT_INCREMENTAL_PAGE_CEILING,
);
const envelope = JSON.parse(await readFile(input, "utf8")) as { captures: Array<PageCapture & { sortedNewest?: boolean }>; errors?: string[] };
if (!Array.isArray(envelope.captures)) throw new Error("Expected captures array");
const release = await acquireRefreshLock();
try {
  const ledger = await readRefreshLedger();
  const requestedRun = args.includes("--run-id") ? args[args.indexOf("--run-id") + 1] : undefined;
  const run = requestedRun ? ledger.runs.find((r) => r.id === requestedRun) : latestResumableRun(ledger);
  if (requestedRun && !run) throw new Error("Unknown run ID");
  const progressPath = join(CAPTURE_DIR, `progress-${run?.id ?? new Date().toISOString().slice(0, 10)}.json`);
  let progress: Progress = { imported: [], cities: {} };
  try { progress = JSON.parse(await readFile(progressPath, "utf8")) as Progress; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  for (const c of envelope.captures) {
    if (!["athome", "roomspot", "nifty", "suumo"].includes(c.source)) throw new Error("Unsupported list source");
    if (!["Soka", "Koshigaya", "Kawaguchi"].includes(c.city)) throw new Error("Unknown city");
    await saveCapture(c);
    const receipt = createHash("sha256").update(c.url + c.capturedAt + c.html).digest("hex");
    if (progress.imported.includes(receipt)) { console.log(`${c.source}/${c.city} p${c.page}: already imported`); continue; }
    const key = `${c.source}/${c.city}`;
    const prior = progress.cities[key];
    if (c.page !== (prior?.pages ?? 0) + 1) throw new Error(`${key}: expected page ${(prior?.pages ?? 0) + 1}, got ${c.page}; replay missing pages before completing a city`);
    const previous = await readSource(c.source);
    const keys = c.source === "suumo" ? suumoMatchKeys : c.source === "athome" ? athomeMatchKeys : c.source === "nifty" ? niftyMatchKeys : roomspotMatchKeys;
    const merge = c.source === "suumo" ? mergeSuumoIncremental : c.source === "athome" ? mergeAthomeIncremental : c.source === "nifty" ? mergeNiftyIncremental : mergeRoomspotIncremental;
    const parsed = c.source === "suumo" ? parseSuumoPage(c.html, new Date(c.capturedAt).getFullYear()).map(l => ({ ...l, city: c.city })) : c.source === "nifty" ? parseNiftyPage(c.html, c.city, new Date(c.capturedAt).getFullYear()) : c.source === "athome" ? parseAthomePage(c.html, c.city) : parseRoomspotPage(c.html, c.city);
    assertParsedFamilies(c, parsed);
    const listings = newerRows(previous, parsed, c.capturedAt, keys);
    const known = new Set((previous?.listings ?? []).flatMap(keys));
    const novel = listings.filter((l) => !keys(l).some((k) => known.has(k))).length;
    const merged = merge(previous?.listings ?? [], listings);
    const observedAtByKey = { ...(previous?.provenance?.observedAtByKey as Record<string, string> ?? {}) };
    for (const l of listings) observedAtByKey[trackingKey(l)] = c.capturedAt;
    await writeSource({ source: c.source, scrapedAt: [previous?.scrapedAt ?? "", c.capturedAt].sort().at(-1)!, completeSnapshot: false,
      provenance: { ...previous?.provenance, mode: "bounded native-browser discovery", capturedBy: "scripts/import-capture.ts (native browser export)", observedTrackingKeys: listings.map(trackingKey), observedAtByKey }, listings: merged.listings });
    const knownPages = c.sortedNewest && listings.length > 0 && novel === 0 ? (prior?.knownPages ?? 0) + 1 : 0;
    progress.cities[key] = { pages: (prior?.pages ?? 0) + 1, knownPages, added: (prior?.added ?? 0) + merged.added, updatedAt: c.capturedAt, done: knownPages >= 2 || c.page >= maxPages };
    progress.imported.push(receipt);
    await atomicWriteJson(progressPath, progress); // every validated page survives later failures
    console.log(`${key} p${c.page}: ${listings.length} family rows; ${merged.added} added; ${merged.updated} refreshed; ${progress.cities[key].done ? "STOP (overlap/budget; not complete market)" : "continue"}`);
  }
  // Source metadata describes this capture run, not the previous day's crawl.
  for (const source of ["athome", "roomspot", "nifty", "suumo"]) {
    const cities = Object.entries(progress.cities).filter(([key]) => key.startsWith(source + "/"));
    if (!cities.length) continue;
    const file = await readSource(source);
    if (!file) continue;
    const provenance = { ...file.provenance, pagesFetched: cities.reduce((n, [, c]) => n + c.pages, 0), newListings: cities.reduce((n, [, c]) => n + c.added, 0), cities: cities.map(([key]) => key.split("/")[1]), captureRunId: run?.id };
    // Detail enrichment now has its own durable queue; a historical new-ID list
    // from an earlier collector is misleading and must not leak into this run.
    delete (provenance as Record<string, unknown>).newListingIds;
    if (JSON.stringify(file.provenance) !== JSON.stringify(provenance)) await writeSource({ ...file, provenance });
  }
  if (run) {
    const groups: Array<[string, string[]]> = [["suumo", ["suumo/Soka", "suumo/Koshigaya", "suumo/Kawaguchi"]], ["athome", ["athome/Soka", "athome/Koshigaya", "athome/Kawaguchi"]], ["roomspot", ["roomspot/Soka", "roomspot/Koshigaya", "roomspot/Kawaguchi"]], ...["Soka", "Koshigaya", "Kawaguchi"].map((c): [string, string[]] => [`nifty-${c.toLowerCase()}`, [`nifty/${c}`]])];
    for (const [source, cityKeys] of groups) {
      const cities = cityKeys.map((key) => progress.cities[key]);
      if (!cities.every((city) => city?.done)) continue;
      const stage = run.stages.find((s) => s.id === source);
      if (!stage || stage.status === "success") continue;
      const now = new Date().toISOString();
      const startedAt = cities.map((c) => c.updatedAt).sort()[0];
      const discovered = cities.reduce((n, c) => n + c.added, 0);
      Object.assign(stage, { status: "success", completedAt: now, startedAt, discovered, exitCode: 0, detail: "Validated native-browser captures; bounded discovery, no removal claims" });
      stage.attempts.push({ startedAt, completedAt: now, durationMs: Date.parse(now) - Date.parse(startedAt), exitCode: 0, status: "success", discovered });
      const dirty = new Set([source]);
      for (const s of run.stages) if ((DEPENDENCIES[s.id] ?? []).some((d) => dirty.has(d)) && s.status !== "skipped") { s.status = "pending"; dirty.add(s.id); }
    }
    run.updatedAt = new Date().toISOString();
    await saveRefreshRun(run);
  }
  for (const error of envelope.errors ?? []) console.error(`Capture failed: ${error}`);
  if (envelope.errors?.length) process.exitCode = 2;
} finally { await release(); }
