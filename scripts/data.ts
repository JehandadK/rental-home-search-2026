/**
 * Data store CLI — inspect and rebuild the listing sources.
 *
 *   npm run data:status   what each source holds, when it was captured
 *   npm run data:build    rebuild listings_raw.json from all source files
 *
 * `listings_raw.json` is derived; never edit it by hand. Each source file
 * under src/data/sources/ is owned by its own importer.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BACKUP_DIR, MANIFEST_PATH, RAW_PATH, buildRaw, listSources } from "./lib/dataStore";
import type { BuildManifest } from "./lib/dataStore";
import { sourceSnapshotCaptureTime } from "../src/data-layer/sourceObservationTime";

const ago = (iso: string): string => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

async function status(): Promise<void> {
  const sources = await listSources();
  if (sources.length === 0) {
    console.log("No source files yet. Run `npm run scrape` or `npm run import:nifty`.");
    return;
  }

  console.log("Sources (each owned by one importer):\n");
  for (const source of sources) {
    const capturedAt = sourceSnapshotCaptureTime(source);
    console.log(
      `  ${source.source.padEnd(8)} ${String(source.count).padStart(4)} listings   ${capturedAt ? `captured ${ago(capturedAt)}` : "historical import (capture time unknown)"}`,
    );
    for (const [key, value] of Object.entries(source.provenance ?? {})) {
      // Internal identity lists can contain hundreds of values; status should
      // summarize them rather than dumping an unreadable terminal wall.
      if (Array.isArray(value) && key.endsWith("Keys")) {
        console.log(`           ${key}: ${value.length} tracked`);
      } else if (Array.isArray(value) && key.endsWith("Ids")) {
        console.log(`           ${key}: ${value.length}${value.length <= 5 ? ` (${value.join(", ")})` : ""}`);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        console.log(`           ${key}: ${Object.keys(value).length} entries`);
      } else {
        console.log(`           ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
    }
  }

  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as BuildManifest;
    console.log(`\nlistings_raw.json — ${manifest.total} listings, built ${ago(manifest.builtAt)}`);
    for (const entry of manifest.sources) {
      console.log(
        `  ${entry.source.padEnd(8)} contributed ${String(entry.contributed).padStart(4)}` +
          (entry.duplicatesDropped ? `   (${entry.duplicatesDropped} dropped as duplicates)` : ""),
      );
    }
    const stale = sources.filter((s) => new Date(s.scrapedAt) > new Date(manifest.builtAt));
    if (stale.length > 0) {
      console.log(`\n  ! ${stale.map((s) => s.source).join(", ")} changed since the last build — run \`npm run data:build\``);
    }
  } else {
    console.log(`\nlistings_raw.json has never been built from sources — run \`npm run data:build\``);
  }

  console.log(`\nBackups: ${BACKUP_DIR}`);
}

async function build(): Promise<void> {
  const manifest = await buildRaw();
  console.log(`Built ${RAW_PATH}`);
  console.log(`  ${manifest.total} listings from ${manifest.sources.length} source(s)`);
  for (const entry of manifest.sources) {
    console.log(
      `  ${entry.source.padEnd(8)} ${String(entry.count).padStart(4)} captured → ${String(entry.contributed).padStart(4)} kept` +
        (entry.duplicatesDropped ? `, ${entry.duplicatesDropped} duplicate(s) dropped` : ""),
    );
  }
  if (manifest.lifecycle) {
    const { continued, added, sold, reactivated } = manifest.lifecycle;
    console.log(
      `\nLifecycle vs previous build: ${continued} still listed, ${added} NEW, ${sold} sold (kept)` +
        (reactivated ? `, ${reactivated} re-listed` : ""),
    );
  }
  console.log(`\nNext: npm run enrich`);
}

const command = process.argv[2] ?? "status";
if (command === "build") void build();
else if (command === "status") void status();
else {
  console.error(`Unknown command "${command}". Use: status | build`);
  process.exit(1);
}
