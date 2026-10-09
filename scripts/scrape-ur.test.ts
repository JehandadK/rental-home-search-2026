import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSourceStore } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { ListingIngestionService } from "../src/data-layer/ingestion/service";
import { adKey, adKeyFromRowId } from "../src/domain/availability";
import { parseEstateRows, parseRoomDetail, parseRoomRows, roomListing } from "../src/collectors/ur/urApi";
import type { UrSweep } from "../src/collectors/ur/urCollector";
import type { CityBoundaryRecord } from "../src/data-layer/contracts";
import { ESTATES, ROOMS, ROOM_DETAIL, SOKA } from "../src/collectors/ur/urFixtures.contract";
import { boundingBox, urBatch, urCities } from "./scrape-ur";

const at = "2026-10-09T05:00:00.000Z";
const [estate] = parseEstateRows(ESTATES);
const [room] = parseRoomRows(ROOMS);
const twoDk = roomListing(SOKA, estate, room, parseRoomDetail(ROOM_DETAIL), at);
const oneK = roomListing(SOKA, estate, { ...room, jkss: "000010305", layout: "1K", rentYen: 70_000 }, null, at);
const sweep = (rooms = [twoDk, oneK], capturedAt = at): UrSweep => ({ capturedAt, rooms, estates: [], unplaced: [], gone: [], stillAnswering: [], calls: 4 });

describe("scrape:ur", () => {
  let root: string, service: ListingIngestionService, store: JsonSourceStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scrape-ur-"));
    store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
    service = new ListingIngestionService(new JsonListingRepository(store));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("maps the target cities to UR's city queries", () => {
    expect(urCities(["Soka", "Katsushika"])).toEqual([
      { label: "Soka", code: "11221", block: "kanto", prefecture: "saitama", prefectureName: "埼玉県" },
      { label: "Katsushika", code: "13122", block: "kanto", prefecture: "tokyo", prefectureName: "東京都" },
    ]);
  });

  it("boxes the cities' boundaries", () => {
    const boundary = (cityId: string, ring: [number, number][]): CityBoundaryRecord => ({ id: `b:${cityId}`, cityId, status: "active", updatedAt: at,
      geometry: { type: "Polygon", coordinates: [ring] } });
    const box = boundingBox([boundary("city:soka", [[139.77, 35.80], [139.83, 35.87]]), boundary("city:far", [[140.5, 36.5]])], new Set(["city:soka"]));
    expect(box.west).toBeCloseTo(139.76); expect(box.east).toBeCloseTo(139.84);
    expect(box.south).toBeCloseTo(35.79); expect(box.north).toBeCloseTo(35.88);
  });

  it("submits family rooms through the unchanged ingestion service, and keeps rooms a later sweep misses", async () => {
    const batch = urBatch(sweep(), [SOKA]);
    expect(batch.observations.map((observation) => observation.sourceListingId)).toEqual(["ur-50_4090-000010701"]);
    const receipt = await service.ingestScrape(batch);
    expect(receipt).toMatchObject({ added: 1, currentCount: 1 });

    const later = "2026-10-10T05:00:00.000Z";
    const relisted = { ...twoDk, rent: 109_900 };
    const other = roomListing(SOKA, estate, { ...room, jkss: "000020202" }, null, later);
    const next = await service.ingestScrape(urBatch(sweep([relisted, other], later), [SOKA]));
    expect(next).toMatchObject({ added: 1, updated: 1, currentCount: 2 });
    const stored = (await store.readSource("ur"))!.listings;
    expect(stored.map((row) => [row.id, row.rent])).toEqual([["ur-50_4090-000010701", 109_900], ["ur-50_4090-000020202", 111_900]]);

    // A sweep without one of them changes nothing about it.
    await service.ingestScrape(urBatch(sweep([other], "2026-10-11T05:00:00.000Z"), [SOKA]));
    expect((await store.readSource("ur"))!.listings).toHaveLength(2);
  });

  it("keys each UR room's availability on estate code and JKSS", () => {
    expect(adKey("ur", twoDk.url)).toBe("ur|50_4090-000010701");
    expect(adKey("ur", oneK.url)).toBe("ur|50_4090-000010305");
    expect(adKeyFromRowId("ur", twoDk.id)).toBe("ur|50_4090-000010701");
    expect(adKey("roomspot", "https://www.roomspot.net/rent/123/")).toBe("roomspot|123");
  });
});
