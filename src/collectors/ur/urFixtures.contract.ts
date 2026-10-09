/** UR API answers for 草加市, trimmed from what UR returned on 2026-10-09; shared by the UR collector tests. */
import type { UrCityQuery } from "./urApi";

export const SOKA: UrCityQuery = { label: "Soka", code: "11221", block: "kanto", prefecture: "saitama", prefectureName: "埼玉県" };

export const ESTATES = [
  { allCount: "1", bukkenCount: "2", roomCount: "1", rowMax: "10", block: "kanto", tdfk: "saitama", shisya: "50", danchi: "409", shikibetu: "0",
    danchiNm: "コンフォール松原", traffic: "<li>東武伊勢崎線「獨協大学前」駅 徒歩2～9分</li><li>東武伊勢崎線「新田」駅 徒歩15～23分</li>",
    place: "草加市松原1-4ほか", shikikin: "2か月", kouzou: "鉄筋コンクリート造", floorAll: "14" },
  { allCount: "1", bukkenCount: "2", roomCount: "0", shisya: "50", danchi: "388", shikibetu: "0", danchiNm: "ハーモネスタワー松原",
    traffic: "<li>東武伊勢崎線「獨協大学前」駅 徒歩1分</li>", place: "草加市松原1-1-6", kouzou: "鉄筋コンクリート造（一部鉄骨造）", floorAll: "30" },
];

export const ROOMS = [{
  pageIndex: "0", rowMax: "5", pageMax: "5", allCount: "1", shisya: "50", danchi: "409", shikibetu: "0", floorAll: "14階",
  system: [{ "制度名": "近居割", "制度HTML": "kinkyo" }, { "制度名": "近居割WIDE", "制度HTML": "kinkyo_wide" }], design: [],
  id: "000010701", name: "1号棟701号室", shikikin: "2か月",
  madori: "https://sumai.r6.ur-net.go.jp//chintai/recruit/ArrNormal/10/50409/0000001/G9p/RA/Image/50_409_0-00-0001_G9p_RA_01_00007.gif",
  rent: "108,400円", rent_normal: "", commonfee: "3,500円", type: "2DK", floorspace: "50&#13217;", floor: "7階",
}];

export const ROOM_DETAIL = [{
  roomNm: "1号棟701号室", floor: "7階 /14階", id: "000010701", year: "18", madori: "2DK", availableDate: "随時",
  img: [
    { "画像パス": "https://sumai.r6.ur-net.go.jp//chintai/recruit/ArrNormal/10/50409/0000001/G9p/RA/Image/50_409_0-00-0001_G9p_RA_01_00007.gif", ALT: "コンフォール松原　1号棟701号室2DK50平方メートルの間取図" },
    { "画像パス": "https://chintai.r6.ur-net.go.jp/chintai/img_photo/50/50_409/1504091000010701/B00073635.jpg", ALT: "コンフォール松原の共用施設写真 1/2" },
  ],
  system: [{ "制度名": "近居割" }, { "制度名": "近居割WIDE" }], design: [],
  parking: "<span>平面 空き台数：23台 料金：10,450円<br>自走 空き台数：48台 料金：10,450円～11,880円<br></span>",
  facility: "エレベーター、エアコン、床暖房、バス・トイレ別",
  feature: "最寄りの小中学校が徒歩10分以内、敷地内に公園あり",
  biko: "<li>・住棟入口からお部屋まで段差のないお部屋です。</li><li>・このお部屋はUR賃貸住宅取扱店（不動産会社）を通してのお申込みは出来ません。</li>",
  feature_pickup: ["バス・トイレ別", "2階以上", "敷地内駐車場", "エアコン"],
}];

export const MARKERS = [
  { id: "50_4090", lat: 35.84321012771111, lng: 139.799558133775, roomCount: 1 },
  { id: "50_3880", lat: 35.8353, lng: 139.8019, roomCount: 0 },
  { id: "20_1170", lat: 35.80721780766204, lng: 139.80804411878933, roomCount: 0 },
];
