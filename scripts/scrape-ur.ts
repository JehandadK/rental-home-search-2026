/**
 * Collect UR賃貸住宅 (UR都市機構) estates and vacant rooms for the target cities.
 *
 *   npm run scrape:ur                     sweep every target city
 *   npm run scrape:ur -- --city Soka      one city (repeatable)
 *   npm run scrape:ur -- --dry-run        sweep and print; write nothing
 *
 * One UR city page is loaded in the headed browser and UR's API is called from
 * inside it (see src/collectors/ur/). Then:
 *   - every vacant 2-room-or-larger room is submitted to the `ur` source;
 *   - rooms we held that UR now says are gone get an availability record;
 *   - every estate of the swept cities, vacant or not, is upserted as a
 *     `urDanchi` reference place (the map always shows them);
 *   - each estate's coordinates are put in the geocode cache for its address.
 * Next: npm run data:build && npm run enrich && npm run data:web
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKUP_DIR, DATA_DIR, JsonSourceStore, REFERENCE_CATALOG_DIR, SOURCES_DIR, ShrinkGuardError, atomicWriteJson } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { readAvailability, recordAvailability, type AvailabilityEntry } from "../src/storage/json/availabilityStore";
import { recordUrHistory } from "../src/storage/json/urHistoryStore";
import { urSweepRecord } from "../src/data-layer/urRoomHistory";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import type { ScrapeBatch } from "../src/data-layer/ingestion/contracts";
import { planUrEstateImport } from "../src/data-layer/urEstateImport";
import type { CityBoundaryRecord } from "../src/data-layer/contracts";
import { withFileLock } from "../src/node/jsonFile";
import { adKey } from "../src/domain/availability";
import { UR_SOURCE } from "../src/domain/ur";
import { describeSettings } from "../src/collectors/shared/searchFilters";
import { addressKey, type GeocodeCache } from "../src/collectors/enrichment/geocodeCache";
import { TARGET_CITIES } from "../src/collectors/shared/targetCities";
import { UR_ORIGIN, roomUrl, type UrCityQuery } from "../src/collectors/ur/urApi";
import { UrBrowser } from "../src/collectors/ur/urBrowser";
import { sweepUr, type UrSweep } from "../src/collectors/ur/urCollector";

const CHANGED_BY = "scrape:ur";
const familyLayout = (layout: string | null) => Number(layout?.normalize("NFKC").match(/^\d+/)?.[0] ?? 0) >= 2;

export const urCities = (labels: readonly string[]): UrCityQuery[] => TARGET_CITIES
  .filter((city) => !labels.length || labels.includes(city.label))
  .map((city) => ({ label: city.label, code: city.code, block: "kanto", prefecture: city.prefectureSlug, prefectureName: city.prefecture }));

/** Bounding box of the cities' boundaries, with a small margin. */
export function boundingBox(boundaries: readonly CityBoundaryRecord[], cityIds: ReadonlySet<string>) {
  const points: number[][] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value) && typeof value[0] === "number") points.push(value as number[]);
    else if (Array.isArray(value)) value.forEach(walk);
  };
  for (const boundary of boundaries) if (boundary.status === "active" && cityIds.has(boundary.cityId)) walk(boundary.geometry.coordinates);
  if (!points.length) throw new Error("No boundaries for the UR cities in the reference catalog");
  const margin = 0.01;
  return {
    west: Math.min(...points.map((p) => p[0])) - margin, east: Math.max(...points.map((p) => p[0])) + margin,
    south: Math.min(...points.map((p) => p[1])) - margin, north: Math.max(...points.map((p) => p[1])) + margin,
  };
}

/** The `ur` discovery batch: one observation per vacant family room. */
export function urBatch(sweep: UrSweep, cities: readonly UrCityQuery[]): ScrapeBatch {
  const rooms = sweep.rooms.filter((room) => familyLayout(room.layout));
  return {
    schemaVersion: 1, source: UR_SOURCE, scraper: { name: `${UR_SOURCE}-list`, version: "1", parserVersion: "1" },
    runId: `ur-${sweep.capturedAt}`, batchId: "sweep", mode: "discovery", capturedAt: sweep.capturedAt,
    scope: { urls: rooms.map((room) => room.url!), cities: cities.map((city) => city.label), filters: { minRooms: 2 } },
    observations: rooms.map((room) => ({ sourceListingId: room.id!, observedAt: sweep.capturedAt, listing: room,
      evidence: { url: room.url!, captureId: `ur-api:${sweep.capturedAt}:${room.id}` } })),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const labels = argv.flatMap((arg, index) => (arg === "--city" && argv[index + 1] ? [argv[index + 1]] : []));
  const cities = urCities(labels);
  if (!cities.length) throw new Error(`No target city matches ${labels.join(", ")}`);

  const references = new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR);
  const snapshot = await references.loadSnapshot();
  const cityIds = new Set(snapshot.cities.records.filter((city) => cities.some((query) => query.code === city.code)).map((city) => city.id));
  const box = boundingBox(snapshot.boundaries.records, cityIds);

  const store = new JsonSourceStore(SOURCES_DIR, BACKUP_DIR);
  const knownRoomIds = ((await store.readSource(UR_SOURCE))?.listings ?? []).map((row) => row.id).filter((id): id is string => !!id);
  const known = await readAvailability();

  const first = cities[0];
  // UR has no area filter: one sweep sees every room, and a room it skipped would be recorded gone.
  console.log(describeSettings("ur", { minAreaM2: null }));
  const browser = new UrBrowser();
  let sweep: UrSweep;
  try {
    await browser.open(`${UR_ORIGIN}/chintai/${first.block}/${first.prefecture}/area/${first.code.slice(2)}.html`);
    sweep = await sweepUr(browser, {
      cities, box, knownRoomIds, now: () => new Date().toISOString(), log: (line) => console.log(`  ${line}`),
      pause: () => new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1500)),
    });
  } finally {
    await browser.close();
  }

  const family = sweep.rooms.filter((room) => familyLayout(room.layout));
  console.log(`UR sweep ${sweep.capturedAt}: ${sweep.estates.length} estates, ${sweep.rooms.length} vacant rooms (${family.length} with 2+ rooms), ${sweep.calls} API calls`);
  for (const room of family) console.log(`  ${room.name} ${room.notes?.split(" · ")[0]} ${room.layout} ${room.sizeM2}㎡ ¥${room.rent.toLocaleString("ja-JP")}`);
  for (const estate of sweep.unplaced) console.log(`  no coordinates (outside the map box): ${estate.name} ${estate.code}`);
  for (const gone of sweep.gone) console.log(`  gone: ${gone.id}`);
  if (dryRun) {
    console.log("Dry run: nothing was written");
    return;
  }

  // Rooms. An empty sweep (no family vacancies today) has nothing to submit.
  const batch = urBatch(sweep, cities);
  if (batch.observations.length) {
    const receipt = await new ListingIngestionService(new JsonListingRepository(store)).ingestScrape(batch);
    console.log(`ur source: +${receipt.added} new, ${receipt.updated} updated, ${receipt.currentCount} rooms held`);
  }
  // The rooms page's history: this sweep, empty or not (an empty sweep is evidence every room is let).
  await recordUrHistory({ sweeps: [urSweepRecord(batch)] });

  // Availability: UR's "no such room" is positive evidence; a room seen again after one clears it.
  const cityOf = new Map(cities.map((city) => [city.code, city]));
  const estateCity = new Map(sweep.estates.map((estate) => [estate.code, cityOf.get(estate.cityCode)!]));
  const records: AvailabilityEntry[] = [
    ...sweep.gone.flatMap(({ id, checkedAt, evidence }) => {
      const [, code, jkss] = /^ur-(.+)-(\d{9})$/.exec(id) ?? [];
      const city = estateCity.get(code);
      return city ? [{ source: UR_SOURCE, url: roomUrl(city.block, city.prefecture, code, jkss), state: "gone" as const, checkedAt, evidence, method: "probe" as const }] : [];
    }),
    ...family.filter((room) => known[adKey(UR_SOURCE, room.url)]?.state === "gone").map((room) => ({
      source: UR_SOURCE, url: room.url!, state: "listed" as const, checkedAt: sweep.capturedAt,
      evidence: "Advertised again in UR's vacancy list", method: "probe" as const,
    })),
  ];
  await recordAvailability(records);
  if (records.length) console.log(`availability: ${records.filter((r) => r.state === "gone").length} gone, ${records.filter((r) => r.state === "listed").length} listed again`);

  // Estates.
  const plan = planUrEstateImport(snapshot.places.records, snapshot.cities.records, sweep.estates, cities.map((city) => city.code), sweep.capturedAt);
  for (const estate of plan.unknownCity) console.log(`  not in the catalog's cities: ${estate.name} (${estate.cityCode})`);
  if (plan.places.upsert.length || plan.places.retire?.length) {
    const updated = await references.updatePlaces(plan.places, {
      expectedRevision: snapshot.places.revision, changedBy: CHANGED_BY,
      reason: `UR estates and vacancies for ${cities.map((city) => city.label).join(", ")} (${sweep.capturedAt})`,
    });
    console.log(`urDanchi places: ${plan.places.upsert.length} upserted, ${plan.places.retire?.length ?? 0} retired; revision ${snapshot.places.revision.slice(0, 12)} -> ${updated.revision.slice(0, 12)}`);
  } else console.log("urDanchi places: unchanged");

  // UR's own coordinates for each estate address, so enrich does not geocode them.
  const cachePath = join(DATA_DIR, "geocodes.json");
  await withFileLock(join(DATA_DIR, "geocode-enrichment"), async () => {
    const cache = JSON.parse(await readFile(cachePath, "utf8").catch(() => "{}")) as GeocodeCache;
    for (const estate of sweep.estates) {
      cache[addressKey(estate.address)] = { value: { lat: estate.lat, lon: estate.lon, matched: `UR ${estate.name} (${estate.code})` }, checkedAt: sweep.capturedAt };
    }
    await atomicWriteJson(cachePath, cache);
  });
  console.log("Next: npm run data:build && npm run enrich && npm run data:web");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ShrinkGuardError ? 2 : 1);
});
