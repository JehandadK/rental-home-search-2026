/**
 * Rebuild property documents from every historical copy of the data we still
 * have, oldest first, then the current files:
 *
 *   npm run data:properties:backfill -- [--backups <dir>]... [--dry-run]
 *
 * Sources of history:
 *   - git: each commit in HEAD's history that changed listings_raw.json, a
 *     source file, or availability.json (data/ and the pre-M5 src/data/ paths);
 *     other branches and stashes are not replayed;
 *   - backup directories (`data/.backups` by default; from a worktree, pass the
 *     main checkout's `--backups <repo>/data/.backups`): the copies taken
 *     before each overwrite, named `<file>-<timestamp>-….json`.
 * Historical builds' grouping never merges documents; only today's build does.
 * The sync is additive and idempotent, so re-running only adds what is new.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PropertyEvidence } from "../src/data-layer/properties/contracts";
import { describePropertySync, syncPropertyDocuments } from "../src/data-layer/properties/service";
import type { RawListing } from "../src/domain/types";
import { parseAvailabilityFile } from "../src/storage/json/availabilityStore";
import { BACKUP_DIR, type BuildManifest, type SourceFile } from "../src/storage/json/dataStore";
import { JsonPropertyDocumentStore } from "../src/storage/json/propertyDocumentStore";
import { availabilityEvidence, readCurrentEvidence, sourceFileEvidence } from "../src/storage/json/propertyEvidence";
import { REPO_ROOT } from "../src/node/dataPaths";

interface Snapshot {
  at: string;
  label: string;
  load: () => Promise<Omit<PropertyEvidence, "recordedAt" | "via">>;
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 30 });
const gitJson = <T>(rev: string, path: string): T | undefined => {
  try {
    return JSON.parse(git("show", `${rev}:${path}`)) as T;
  } catch {
    return undefined;
  }
};

function gitSnapshots(): Snapshot[] {
  const paths = ["data/listings_raw.json", "data/sources", "data/availability.json", "src/data/listings_raw.json", "src/data/sources"];
  const commits = git("log", "HEAD", "--reverse", "--format=%H %cI", "--", ...paths).trim().split("\n").filter(Boolean);
  return commits.map((line) => {
    const [sha, at] = line.split(" ");
    return {
      at: new Date(at).toISOString(),
      label: `git:${sha.slice(0, 7)}`,
      load: async () => {
        const root = git("ls-tree", "--name-only", sha, "data/sources/").trim() ? "data" : "src/data";
        const files = git("ls-tree", "--name-only", sha, `${root}/sources/`).trim().split("\n")
          .filter((path) => path.endsWith(".json") && !path.endsWith("_manifest.json"));
        const rows = gitJson<RawListing[]>(sha, `${root}/listings_raw.json`);
        const manifest = gitJson<BuildManifest>(sha, `${root}/sources/_manifest.json`);
        const availability = gitJson<unknown>(sha, `${root}/availability.json`);
        return {
          canonical: rows ? { builtAt: manifest?.builtAt ?? null, rows, groupingAuthoritative: false } : undefined,
          sources: files.map((path) => gitJson<SourceFile>(sha, path)).filter((file): file is SourceFile => Boolean(file?.listings)).map(sourceFileEvidence),
          availability: availability ? availabilityEvidence(parseAvailabilityFile(JSON.stringify(availability))) : [],
        };
      },
    };
  });
}

/** `athome-2026-09-28T23-22-05-367Z-17826-<uuid>.json` → athome, 2026-09-28T23:22:05.367Z */
const BACKUP_NAME = /^(.+?)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/;

async function backupSnapshots(dir: string): Promise<Snapshot[]> {
  if (!existsSync(dir) || !(await readdir(dir)).some((file) => BACKUP_NAME.test(file))) {
    console.warn(`! No backups in ${dir}; from a worktree, pass --backups <main checkout>/data/.backups`);
    return [];
  }
  const snapshots: Snapshot[] = [];
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;
    const [, file, day, h, m, s, ms] = match;
    const at = `${day}T${h}:${m}:${s}.${ms}Z`;
    const read = async () => JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
    snapshots.push({
      at,
      label: `backup:${name}`,
      load: async () => {
        const content = await read();
        if (file === "listings_raw") return { canonical: { builtAt: at, rows: content as RawListing[], groupingAuthoritative: false } };
        if (file === "availability") return { availability: availabilityEvidence(parseAvailabilityFile(JSON.stringify(content))) };
        const source = content as SourceFile;
        return source?.listings ? { sources: [sourceFileEvidence(source)] } : {};
      },
    });
  }
  return snapshots;
}

const argv = process.argv.slice(2);
const backupDirs = argv.flatMap((arg, i) => (arg === "--backups" ? [argv[i + 1]] : []));
const dryRun = argv.includes("--dry-run");
const snapshots = [...gitSnapshots(), ...(await Promise.all((backupDirs.length ? backupDirs : [BACKUP_DIR]).map(backupSnapshots))).flat()]
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.label.localeCompare(b.label));

console.log(`${snapshots.length} historical snapshot(s), oldest first${dryRun ? " (dry run)" : ""}:`);
const store = new JsonPropertyDocumentStore();
const recordedAt = new Date().toISOString();
for (const snapshot of snapshots) {
  if (dryRun) {
    console.log(`  ${snapshot.at}  ${snapshot.label}`);
    continue;
  }
  const evidence = { ...(await snapshot.load()), recordedAt, asOf: snapshot.at, via: `backfill:${snapshot.label}` };
  console.log(`  ${snapshot.at}  ${describePropertySync(await syncPropertyDocuments(store, evidence))}`);
}
if (!dryRun) console.log(describePropertySync(await syncPropertyDocuments(store, await readCurrentEvidence("backfill:current", recordedAt))));
