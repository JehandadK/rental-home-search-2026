import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { REFRESH_LOCK_PATH, readRefreshLedger, type RefreshRunRecord } from "./lib/refreshLedger";

const argv = process.argv.slice(2);
const limitFlag = argv.indexOf("--limit");
const limit = limitFlag >= 0 ? Math.max(1, Number(argv[limitFlag + 1]) || 10) : 10;
const json = argv.includes("--json");
const ledger = await readRefreshLedger();
const runs = ledger.runs.slice(-limit).reverse();

if (json) {
  console.log(JSON.stringify(runs, null, 2));
  process.exit(0);
}

const formatTime = (iso?: string) => iso
  ? new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Tokyo", hour12: false,
    }).format(new Date(iso)) + " JST"
  : "—";
const duration = (run: RefreshRunRecord) => {
  const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};

if (existsSync(REFRESH_LOCK_PATH)) {
  try {
    const lock = JSON.parse(await readFile(REFRESH_LOCK_PATH, "utf8")) as { pid?: number; startedAt?: string };
    console.log(`Active lock: PID ${lock.pid ?? "?"}, started ${formatTime(lock.startedAt)}\n`);
  } catch {
    console.log("Active refresh lock exists (metadata unreadable).\n");
  }
}

if (!runs.length) {
  console.log("No audited refresh runs yet. Start one with `npm run refresh`.");
  process.exit(0);
}

for (const run of runs) {
  const failed = run.stages.filter((stage) => stage.status === "failed").map((stage) => stage.label);
  console.log(
    `${run.status.toUpperCase().padEnd(11)} ${formatTime(run.startedAt)} · ${duration(run)} · ` +
      `${run.beforeTotal} → ${run.afterTotal ?? "?"}` +
      (run.netUniqueAdded == null ? "" : ` · +${run.netUniqueAdded} unique`) +
      ` · ${run.mode} · ${run.id}`,
  );
  if (failed.length) console.log(`             retry: ${failed.join(", ")}`);
}

const latest = runs[0];
if (latest.status === "success") {
  console.log(`\nLatest run completed successfully at ${formatTime(latest.completedAt)}; no resume is required.`);
} else {
  console.log(`\nLatest run is ${latest.status}. Continue it with \`npm run refresh -- --resume\`.`);
}
