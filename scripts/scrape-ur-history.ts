/**
 * Read every UR room's listing history, so the rooms page can show closed rooms too.
 *
 *   npm run scrape:ur-history                    every UR estate in the catalog
 *   npm run scrape:ur-history -- --estate 50_4090  one estate (repeatable)
 *   npm run scrape:ur-history -- --dry-run       read and print; write nothing
 *
 * UR shows only vacant rooms. ラク賃不動産 (www.ur-s.jp) has recorded every
 * vacancy since about 2026-05-29 (Kanto): one estate page per UR estate holds
 * its rooms open now and every past listing period. Each page is loaded in
 * the headed browser, 8–14 s apart, and added to data/ur-history.json as it
 * is read, so a run that stops early keeps every page it finished.
 *
 * Our own UR sweeps (`npm run scrape:ur`) are the other half of the history.
 * The sweeps made before the history file existed are copied in from the
 * `ur` source's ingestion journal on every run (idempotent).
 * Next: npm run data:web
 */
import { pathToFileURL } from "node:url";
import { BACKUP_DIR, JsonSourceStore, REFERENCE_CATALOG_DIR, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { recordUrHistory } from "../src/storage/json/urHistoryStore";
import { UR_PLACE_CATEGORY, UR_SOURCE } from "../src/domain/ur";
import type { RakuchinEstatePage, RakuchinPeriod } from "../src/domain/urRooms";
import { parseRakuchinPage, rakuchinEstateUrl } from "../src/collectors/rakuchin/rakuchinPage";
import { RakuchinBrowser } from "../src/collectors/rakuchin/rakuchinBrowser";
import { journalSweeps } from "../src/data-layer/urRoomHistory";

const pause = () => new Promise((resolve) => setTimeout(resolve, 8000 + Math.random() * 6000));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const only = argv.flatMap((arg, index) => (arg === "--estate" && argv[index + 1] ? [argv[index + 1]] : []));

  const snapshot = await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot();
  const estates = snapshot.places.records
    .filter((place) => place.category === UR_PLACE_CATEGORY && place.status !== "retired")
    .flatMap((place) => {
      const code = typeof place.attributes?.urCode === "string" ? place.attributes.urCode : null;
      const url = typeof place.attributes?.url === "string" ? rakuchinEstateUrl(place.attributes.url) : null;
      return code && url && (!only.length || only.includes(code)) ? [{ code, name: place.name, url }] : [];
    });
  if (!estates.length) throw new Error(only.length ? `No UR estate ${only.join(", ")} in the catalog` : "No UR estates in the catalog; run npm run scrape:ur first");

  const source = await new JsonSourceStore(SOURCES_DIR, BACKUP_DIR).readSource(UR_SOURCE);
  const sweeps = source ? journalSweeps(source) : [];
  if (!dryRun && sweeps.length) {
    const added = await recordUrHistory({ sweeps });
    console.log(`Our UR sweeps: ${sweeps.length} in the journal, ${added.sweeps} new to the history`);
  }

  console.log(`Reading ${estates.length} estate pages on www.ur-s.jp (8–14 s apart)`);
  const browser = new RakuchinBrowser();
  let read = 0;
  const failed: string[] = [];
  try {
    for (const [index, estate] of estates.entries()) {
      if (index) await pause();
      const capturedAt = new Date().toISOString();
      let parsed: { page: RakuchinEstatePage; periods: [string, RakuchinPeriod][] };
      try {
        const loaded = await browser.load(estate.url);
        if (loaded.status && loaded.status >= 400) throw new Error(`HTTP ${loaded.status}`);
        parsed = parseRakuchinPage(loaded.html, { estateCode: estate.code, url: estate.url, capturedAt });
      } catch (error) {
        failed.push(estate.code);
        console.log(`  ${estate.code} ${estate.name}: not read (${(error as Error).message})`);
        continue;
      }
      read++;
      const { page, periods } = parsed;
      const added = dryRun ? null : await recordUrHistory({ estatePages: [page], periods });
      console.log(`  ${estate.code} ${estate.name}: ${page.openRooms.length} open, ${periods.length} past periods`
        + ` of ${new Set(periods.map(([, period]) => period.jkss)).size} rooms, ${page.totalUnits ?? "?"} units`
        + (added ? ` (+${added.periods} new periods)` : ""));
      for (const room of page.openRooms) console.log(`    open: ${room.label} ${room.layout ?? "?"} ${room.sizeM2 ?? "?"}㎡ ¥${room.rent?.toLocaleString("ja-JP") ?? "?"}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`Read ${read} of ${estates.length} estates${failed.length ? `; not read: ${failed.join(", ")}` : ""}${dryRun ? " (dry run: nothing written)" : ""}`);
  if (!dryRun) console.log("Next: npm run data:web");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
