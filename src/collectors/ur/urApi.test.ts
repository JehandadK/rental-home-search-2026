import { describe, expect, it } from "vitest";
import { estateObservation, parseEstateRows, parseMarkers, parseRoomDetail, parseRoomRows, roomListing, walkingAccess, yen } from "./urApi";
import { ESTATES, MARKERS, ROOMS, ROOM_DETAIL, SOKA } from "./urFixtures.contract";

describe("UR API parsing", () => {
  it("reads estates with UR's codes", () => {
    const [matsubara, tower] = parseEstateRows(ESTATES);
    expect(matsubara).toMatchObject({ code: "50_4090", name: "コンフォール松原", place: "草加市松原1-4ほか", roomCount: 1, estateCount: 2, floors: 14,
      traffic: ["東武伊勢崎線「獨協大学前」駅 徒歩2～9分", "東武伊勢崎線「新田」駅 徒歩15～23分"] });
    expect(tower.code).toBe("50_3880");
    expect(parseEstateRows(null)).toEqual([]);
  });

  it("reads vacant rooms and their detail", () => {
    expect(parseRoomRows(ROOMS)).toEqual([expect.objectContaining({ jkss: "000010701", name: "1号棟701号室", rentYen: 108_400, commonFeeYen: 3_500,
      normalRentYen: null, layout: "2DK", sizeM2: 50, floor: "7階", schemes: ["近居割", "近居割WIDE"], roomCount: 1 })]);
    const detail = parseRoomDetail(ROOM_DETAIL)!;
    expect(detail).toMatchObject({ floor: "7階 /14階", managedYears: 18, availableFrom: "随時",
      facilities: ["エレベーター", "エアコン", "床暖房", "バス・トイレ別", "最寄りの小中学校が徒歩10分以内", "敷地内に公園あり"] });
    expect(detail.notes[1]).toBe("このお部屋はUR賃貸住宅取扱店（不動産会社）を通してのお申込みは出来ません。");
    expect(detail.parking).toContain("平面 空き台数：23台");
    expect(detail.photos[0].url).toBe("https://sumai.r6.ur-net.go.jp/chintai/recruit/ArrNormal/10/50409/0000001/G9p/RA/Image/50_409_0-00-0001_G9p_RA_01_00007.gif");
  });

  it("treats null and empty detail answers as a room UR no longer lists", () => {
    expect(parseRoomDetail(null)).toBeNull();
    expect(parseRoomDetail([])).toBeNull();
  });

  it("reads markers and amounts", () => {
    expect(parseMarkers(MARKERS)[0]).toEqual({ code: "50_4090", lat: 35.84321012771111, lon: 139.799558133775, roomCount: 1 });
    expect(yen("<strong>108,400円</strong>(3,500円)")).toBe(108_400);
    expect(yen("")).toBeNull();
  });

  it("takes the first walking line, at the long end of its range", () => {
    expect(walkingAccess(["東武伊勢崎線「獨協大学前」駅 徒歩2～9分"])).toEqual({ station: "獨協大学前", walkMin: 9 });
    expect(walkingAccess(["ＪＲ常磐線「金町」駅 バス7分 停歩3分", "京成金町線「京成金町」駅 徒歩12分"])).toEqual({ station: "京成金町", walkMin: 12 });
    expect(walkingAccess([])).toBeNull();
  });
});

describe("UR room listing", () => {
  const [estate] = parseEstateRows(ESTATES);
  const [room] = parseRoomRows(ROOMS);
  const listing = roomListing(SOKA, estate, room, parseRoomDetail(ROOM_DETAIL), "2026-10-09T05:00:00.000Z");

  it("keys the room on UR's estate and room codes", () => {
    expect(listing).toMatchObject({
      id: "ur-50_4090-000010701", source: "ur", name: "URコンフォール松原", address: "埼玉県草加市松原1-4ほか", city: "Soka",
      url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000010701",
      rent: 111_900, layout: "2DK", sizeM2: 50, builtYear: 2008, advertisedStation: "獨協大学前", stationWalkMin: 9, agency: "UR都市機構",
    });
  });

  it("states UR's fixed lease terms", () => {
    expect(listing.depositYen).toBe(216_800);
    expect(listing.keyMoneyYen).toBe(0);
    expect(listing.costs).toEqual({ depositYen: 216_800, keyMoneyYen: 0, adminFeeYen: 3_500, renewalFeeYen: 0, agencyFeeYen: 0,
      guarantorRequired: false, feeNotes: "対象制度: 近居割、近居割WIDE" });
    expect(listing.tenancy).toEqual({ leaseType: "regular", availableFrom: "随時", immediateMoveIn: true });
    expect(listing.building).toMatchObject({ floor: "7階", totalFloors: 14, structure: "鉄筋コンクリート造" });
    expect(listing.photos?.map((photo) => photo.kind)).toEqual(["floorPlan", "photo"]);
  });

  it("marks fixed-term schemes and works without a detail answer", () => {
    const u35 = roomListing(SOKA, estate, { ...room, schemes: ["U35割（3年定借）"] }, null, "2026-10-09T05:00:00.000Z");
    expect(u35.tenancy?.leaseType).toBe("fixed-term");
    expect(u35.builtYear).toBeNull();
    expect(u35.building?.floor).toBe("7階");
  });

  it("places the estate with its vacancies, and only with coordinates", () => {
    const [, tower] = parseEstateRows(ESTATES);
    const markers = new Map(parseMarkers(MARKERS).map((marker) => [marker.code, marker]));
    expect(estateObservation(SOKA, estate, markers.get("50_4090"), [room], "2026-10-09T05:00:00.000Z")).toEqual({
      code: "50_4090", name: "コンフォール松原", address: "埼玉県草加市松原1-4ほか", cityCode: "11221", lat: 35.84321012771111, lon: 139.799558133775,
      url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090.html", vacantRooms: 1, checkedAt: "2026-10-09T05:00:00.000Z",
      vacantRentMin: 111_900, vacantRentMax: 111_900, floors: 14, structure: "鉄筋コンクリート造",
    });
    expect(estateObservation(SOKA, tower, markers.get("50_3880"), [], "2026-10-09T05:00:00.000Z")).toMatchObject({ vacantRooms: 0, vacantRentMin: null });
    expect(estateObservation(SOKA, tower, undefined, [], "2026-10-09T05:00:00.000Z")).toBeNull();
  });
});
