import { describe, expect, it } from "vitest";
import type { RawListing } from "../domain/types";
import { heldUrRooms, journalSweeps, urEstateInputs } from "./urRoomHistory";

describe("UR room history inputs", () => {
  it("reads our earlier sweeps from the ur source's ingestion journal", () => {
    const provenance = { ingestionJournal: { batches: [
      { metadata: { capturedAt: "2026-10-09T06:02:38.953Z", scope: { cities: ["Soka", "Kawaguchi"], filters: { minRooms: 2 },
        urls: ["https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000010701", "https://example.com/"] } } },
      { metadata: { capturedAt: "2026-10-10T00:00:00.000Z" } },
    ] } };
    expect(journalSweeps({ provenance })).toEqual([
      { capturedAt: "2026-10-09T06:02:38.953Z", cities: ["Soka", "Kawaguchi"], minRooms: 2, roomIds: ["ur-50_4090-000010701"] },
    ]);
    expect(journalSweeps({})).toEqual([]);
  });

  it("reads the held rooms' 棟・号室, base rent and last sighting", () => {
    const listing = {
      id: "ur-50_4090-000010701", name: "URコンフォール松原", address: "埼玉県草加市松原1-4", rent: 111_900, layout: "2DK", sizeM2: 50,
      notes: "1号棟701号室 · 7階 /14階 · 東武伊勢崎線「獨協大学前」駅 徒歩2～9分", costs: { adminFeeYen: 3_500 }, building: { floor: "7階" },
      url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000010701", source: "ur",
    } as RawListing;
    expect(heldUrRooms({ listings: [listing], provenance: { observedAtByKey: { [listing.id!]: "2026-10-10T02:37:52.051Z" } } })).toEqual([{
      id: "ur-50_4090-000010701", label: "1号棟701号室", layout: "2DK", sizeM2: 50, floor: "7階", rentWithFee: 111_900, commonFee: 3_500,
      observedAt: "2026-10-10T02:37:52.051Z", url: listing.url,
    }]);
    expect(heldUrRooms(null)).toEqual([]);
  });

  it("lists the active UR estates with their city, position and what is near them", () => {
    const records: Parameters<typeof urEstateInputs>[0]["places"]["records"] = [
        { id: "u1", category: "urDanchi", name: "コンフォール松原", lat: 35.843, lon: 139.8, address: "埼玉県草加市松原1-4ほか", status: "active" as const,
          attributes: { urCode: "50_4090", url: "https://u/50_4090.html", cityId: "city:soka" } },
        { id: "u0", category: "urDanchi", name: "Gone", lat: 35.9, lon: 139.8, status: "retired" as const, attributes: { urCode: "50_0000", url: "https://u/50_0000.html" } },
        { id: "s1", category: "station", name: "草加", lat: 35.828, lon: 139.803, attributes: { nameEn: "Soka" } },
        { id: "m1", category: "mosque", name: "Baitul Aman Masjid", lat: 35.85, lon: 139.8, attributes: {} },
      ];
    const snapshot = { cities: { records: [{ id: "city:soka", name: "Soka" }] }, places: { records } };
    const [estate] = urEstateInputs(snapshot);
    expect(estate).toMatchObject({ code: "50_4090", name: "コンフォール松原", url: "https://u/50_4090.html", city: "Soka", address: "埼玉県草加市松原1-4ほか", lat: 35.843, lon: 139.8 });
    expect(estate.nearby?.mosque?.name).toBe("Baitul Aman Masjid");
    expect(estate.nearby?.station).toMatchObject({ name: "草加", nameEn: "Soka" });
    expect(urEstateInputs(snapshot)).toHaveLength(1);
  });
});
