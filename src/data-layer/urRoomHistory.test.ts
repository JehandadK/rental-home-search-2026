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

  it("lists the active UR estates with their city", () => {
    const snapshot = {
      cities: { records: [{ id: "city:soka", name: "Soka" }] },
      places: { records: [
        { category: "urDanchi", name: "コンフォール松原", status: "active", attributes: { urCode: "50_4090", url: "https://u/50_4090.html", cityId: "city:soka" } },
        { category: "urDanchi", name: "Gone", status: "retired", attributes: { urCode: "50_0000", url: "https://u/50_0000.html" } },
        { category: "station", name: "草加", attributes: {} },
      ] },
    };
    expect(urEstateInputs(snapshot)).toEqual([{ code: "50_4090", name: "コンフォール松原", url: "https://u/50_4090.html", city: "Soka" }]);
  });
});
