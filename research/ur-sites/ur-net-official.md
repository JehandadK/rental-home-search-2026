# UR賃貸住宅 official site (www.ur-net.go.jp/chintai/) site map

Mapped on **2026-10-09** in a headed Playwright browser, one tab, 8–14 s between
navigations. 63 navigations in total: 42 HTML pages through the mapper, 9 of
the site's own JS files and the sitemap opened as documents (to read the API
calls), and 11 page reloads used to read API responses from inside the page.
About 15 API requests were sent with `fetch`/jQuery from the site's own pages,
each one a request the page itself makes. Nothing was fetched with curl, wget
or WebFetch. Round-1 snapshots (robots.txt, home page) were reused.

## 1. What it is

- **The official site.** Run by 独立行政法人都市再生機構 (UR都市機構, Urban
  Renaissance Agency), which owns and manages the housing (「全国に約70万戸」).
  Free, with no login for browsing. Registration and login only for 仮申込/ネット申込
  and the 空室情報お届けサービス (on `sumai.r6.ur-net.go.jp`).
- **Japanese only** for listings. Other languages are six PDF leaflets:
  `/chintai/pdf/common/plt_{english,chinese_t,chinese_s,korean,portuguese,vietnamese}.pdf`
  (not opened), plus a few Portuguese PDFs for the Nagoya shop. There are no
  English listing pages.
- **Hosts:**
  - `www.ur-net.go.jp/chintai/`: HTML pages (PC). `/chintai/sp/…` is the
    smartphone mirror; with a desktop browser it redirects to the PC URL
    (checked on `/chintai/sp/kanto/saitama/50_4090.html`).
  - `chintai.r6.ur-net.go.jp/chintai/`: **the JSON API** (`/chintai/api/…`),
    static JSON (`/chintai/ranking/`, `/chintai/rent/`) and photos (`/chintai/img_photo/`).
    UR's own page 「このサイトについて」 lists this host among UR's official sites.
  - `sumai.r6.ur-net.go.jp/chintai/`: floor-plan and photo files
    (`/chintai/recruit/…`), the enquiry form (`/s/otoiawase/juko.html?in=…`)
    and the login (`/s/usr/usrLogin/`).
  - The old API host `chintai.sumai.ur-net.go.jp` that third-party write-ups
    name does not resolve (round 1). `api.js` holds the current root, with a
    test root commented out:
    ```js
    url: 'https://chintai.r6.ur-net.go.jp/chintai/api/'
    // url: 'https://chintai-test.r6-test.ur-net.go.jp/chintai/api/'
    ```
- **Tech:** jQuery pages. Most of a page is server-rendered HTML; the vacancy
  tables, room details and counts are filled by jQuery `$.ajax` POSTs to the
  API, with HTML templates from `/chintai/_include/…`. No `__NEXT_DATA__`.
  JSON-LD is a BreadcrumbList only. Many ad trackers (GTM, Criteo, Meta, Yahoo,
  im-apps, etc.).

## 2. robots.txt and sitemap

```
User-agent: *
Disallow: /chintai/*/result/?skcs=
Disallow: /chintai/*/result/?line=
Disallow: /chintai/*/result/?station=
Disallow: /chintai/*/result/?station_nm=
Sitemap: https://www.ur-net.go.jp/chintai/sitemap.xml
```

Only the query forms of `/result/` are blocked. The same lists exist at
allowed static paths (`/area/{skcs}.html`, `/eki/{code}.html`). robots.txt of
`chintai.r6.ur-net.go.jp` was not checked.

`/chintai/sitemap.xml` is one `urlset` (no index). Its header says
`<!-- Last Updated 2022/08/15 15:43:13 -->` and 7,860 of the 8,963 `<lastmod>`
values are from 2022-08, so it is **four years stale**. It still lists every
danchi in our area. Counts (8,963 `<url>`, 2,888 `<image:image>`):

```
/chintai/{block}/{pref}/{shisya}_{danchi}{shikibetu}.html ...... 1,397 danchi pages
/chintai/{block}/{pref}/{id}_map.html .......................... 1,397 周辺マップ
/chintai/{block}/{pref}/{id}_report.html ....................... 1,370 団地のくらし
/chintai/{block}/{pref}/eki/{eki}.html ......................... 1,265 station lists
/chintai/pdf/traffic/{id}_traffic.pdf ............................ 933 per-棟 walking times
/chintai/college/… ............................................... ~1,000 editorial
/chintai/{block}/{pref}/area/{skcs}.html ......................... 295 city lists
/chintai/{block}/{pref}/ensen/{line}/ ............................ 294 line pages
/chintai/information/{yyyy}/{mm}/{n}.html ........................ 106 notices
/chintai/pdf/{yyyy}/{date}_{n}_release.pdf ....................... 117 press PDFs
/chintai/muji/{id}.html ........................................... 53 MUJI rooms
/chintai/{block}/{pref}/  /list/  /result/  /counter/ /area/ /ensen/ /map/ /rosenzu/ /leadtime/
```

Per prefecture in the sitemap: 埼玉 117 danchi, 98 eki, 35 area, 22 lines, 14
shops; 東京 312 danchi, 266 eki, 46 area, 72 lines, 37 shops. Danchi per
shisya code: 20 (東京 312, 北海道 27, 宮城 4), 30 (千葉 111, 茨城 16), 40 (神奈川
170), 50 (埼玉 117), 70 (愛知 101, 三重 4, 静岡 2, 岐阜 1), 80 (大阪 204, 兵庫 106,
京都 43, 奈良 23, 広島 7, 和歌山 3, 滋賀 2, 岡山 1), 90 (福岡 141, 山口 3, 熊本 2).
Room pages are not in the sitemap. All 22 of our-area danchi IDs checked are
present, including `50_1551` 吉川.

## 3. URL hierarchy

```
/chintai/                                        top
├ /chintai/{block}/                              block (kanto, kansai, tokai, chugoku, kyushu, hokkaitohoku)
│ └ /chintai/{block}/{pref}/                     prefecture hub (saitama, tokyo, …): popular cities/stations/lines,
│   │                                            average rent by layout (rent/{tdfk}.json)
│   ├ area/                                      city picker with vacant-room counts per city (area_init/area_main API)
│   ├ area/{skcs}.html                           city list (static, allowed)     skcs = 3-digit city code
│   ├ ensen/                                     line picker (line_init API)
│   ├ ensen/{line}/                              stations of one line, vacant-room count per station
│   ├ ensen/station/?line=…&line_station=…       form target of the line picker (not loaded)
│   ├ eki/{eki}.html                             station list (static, allowed)   eki = UR station code
│   ├ list/                                      all danchi by sub-region (list_init / list_bukken / room/list API)
│   ├ map/                                       Google map search (map_marker / map_window API)
│   ├ rosenzu/                                   route-map search (rosenzu_marker / rosenzu_main API)
│   ├ leadtime/                                  commute-time search (leadtime_main API)
│   ├ result/?skcs=|line=|station=…              dynamic results — robots-disallowed with these queries
│   ├ {shisya}_{danchi}{shikibetu}.html          danchi page (e.g. saitama/50_4090.html)
│   │   ├ #list                                  anchor to its vacancy table
│   │   └ ?rent_low=&room=&system=…              same page, narrowed (form GET)
│   ├ {id}_room.html?JKSS={9 digits}             room page (e.g. 50_4090_room.html?JKSS=000010701)
│   ├ {id}_map.html                              周辺マップ (Google map; no API data)
│   ├ {id}_report.html                           団地のくらし (editorial text and photos)
│   └ counter/  and  counter/{shop}/             shops of the prefecture, one shop page
├ /chintai/sp/…                                  smartphone mirror (redirects to PC on desktop)
├ /chintai/counter/                              all shops, by prefecture
├ /chintai/akishitsu/                            空室情報お届けサービス (target list via seidolist API)
├ /chintai/tokubetsu/                            特別募集住宅 (tokubetsu API)
├ /chintai/whats/system/{slug}/                  discount schemes (see §7)
├ /chintai/information/[{yyyy}/{mm}/{n}.html]    notices, incl. 抽選 (lottery) announcements
├ /chintai/pdf/traffic/{id}_traffic.pdf          per-棟 walking times
├ /chintai/{renovation,muji,ur_ikea,diy,shataku}/ feature landing pages
├ /chintai/favorite/                             bookmarks (cookie)
└ /chintai_portal/{kyojyusha,assen}/             residents' pages; 宅建業者 (broker) page
```

The breadcrumb JSON-LD on danchi pages points the city level at
`/chintai/kanto/saitama/221/`, which is not a URL the site links anywhere
(not loaded; probably not a real page).

### Our area (2026-10-09)

City lists, from `/area/{skcs}.html` (vacant rooms are what UR advertises
today; the default page size is 10 danchi):

| City | skcs | Page | Danchi | Vacant rooms |
| --- | --- | --- | --- | --- |
| 草加市 | 221 | `/chintai/kanto/saitama/area/221.html` | 5 | 1 |
| 越谷市 | 222 | `/chintai/kanto/saitama/area/222.html` | 3 | 0 |
| 川口市 | 203 | `/chintai/kanto/saitama/area/203.html` | 16 | 6 |
| 八潮市 | 234 | `/chintai/kanto/saitama/area/234.html` | 1 | 0 |
| 葛飾区 | 122 | `/chintai/kanto/tokyo/area/122.html` | 20 | 1 |

All of 埼玉県 had **128** vacant rooms in 118 danchi that day (sum of the
`area/` picker counts; list page sub-regions 東部 20, 県央南部 41, 県央北部 11,
西部 46 danchi). 東京 23区東: 足立区 3, 葛飾区 1, 江戸川区 1, 江東区 1.

Danchi in our cities:

| Danchi | ID | Notes (2026-10-09) |
| --- | --- | --- |
| コンフォール松原 (旧草加松原団地) | `50_4090` | 3,050 戸, ¥67,300–167,400, 1 vacancy: 1号棟701号室 2DK 50㎡ 7/14階 ¥108,400 (共益費 ¥3,500) |
| ハーモネスタワー松原 | `50_3880` | 363 戸, 30 floors, ¥89,600–181,600, 獨協大学前 徒歩1分, 0 vacancies |
| コンフォール草加 | `50_3910` | 0 |
| 草加旭町 | `50_1340` | 0 |
| グリーンアベニュー谷塚 | `50_2610` | 0 |
| 八潮 | `50_1390` | 941 戸, ¥41,700–57,000, bus from 草加/獨協大学前/八潮, 0 |
| せんげん台パークタウン三番街 / 四番街 | `50_2180` / `50_2070` | 越谷市, 0 |
| ペアハイツ越谷 | `50_2300` | 越谷市, 0 |
| 川口芝園 | `50_1820` | 2,454 戸, ¥57,600–138,300, 蕨 徒歩10–15分, 0 |
| コンフォール東鳩ヶ谷 | `50_4020` | 2 vacancies (`JKSS=000030303`, `000010606`) |
| コンフォール西鳩ヶ谷 | `50_4070` | 1 (`000010507`) |
| アーバンハイツ南前川 | `50_2220` | 2 (`000000409`, `000000304`) |
| リプレ川口二番街 | `50_2890` | 1 (`000000912`) |
| 北園, 川口芝, 川口栄町第二, 川口前川町, エルハイツ末広, コンフォール川口飯塚 | `50_1280`, `50_1380`, `50_1470`, `50_1490`, `50_2280`, `50_3890` | 川口市, page 1 shows 0 |
| エステート東新小岩 | `20_3420` | 葛飾区, 220 戸, 1 vacancy: 6号棟501号室 3LDK 69㎡ ¥113,600 |
| 金町駅前, 東四ツ木二丁目(第二), 青戸第三/第四/第五, 金町第二, 金町五丁目, 西新小岩リバーハイツ, エステート堀切 … | `20_1650`, `20_2640`, `20_2850`, `20_2860`, `20_2960`, `20_3190`, `20_2950`, `20_3070`, `20_3350`, `20_3720` | 葛飾区, 0 on page 1 (10 of 20 shown) |

There is **no UR danchi in 越谷レイクタウン** on the official 越谷市 list (only the
three above). 吉川 `50_1551` (吉川市, next to 越谷) had 4LDK/3LDK vacancies.

Stations (UR codes, from `rosenzu_marker`): 草加 `2430`, 獨協大学前〈草加松原〉
`3044`, 谷塚 `3215`, 八潮 `9492`, 新越谷 `2325`, 南越谷 `3102`, 越谷 `2117`,
川口 `1908`, 西川口 `2716`, 金町 `1857`. Lines: 東武伊勢崎線（東武スカイツリーライン）
`13900`, ＪＲ京浜東北線 `3600`, ＪＲ武蔵野線 `3800`. `/chintai/kanto/saitama/ensen/13900/`
shows per-station vacant rooms: 谷塚 0, 草加 1, 獨協大学前 1, 新田 1, 新越谷 0, 越谷 0,
せんげん台 0 (blank = no UR danchi near that station).

Shops for our area: UR新越谷営業センター `/chintai/kanto/saitama/counter/shinkoshigaya/`
(handles 草加・八潮・越谷 danchi), URせんげん台現地案内所 `counter/sengendai/`, UR賃貸ショップ川口
`counter/kawaguchi/`, UR賃貸ショップみさと `counter/misato/` (吉川), UR賃貸ショップ青戸
`/chintai/kanto/tokyo/counter/aoto/` and UR賃貸ショップ北千住 `counter/kitasenju/`.

## 4. Identifiers (the join key)

| Thing | Format | Example | Where it appears |
| --- | --- | --- | --- |
| Block | slug | `kanto` | URL, API `block` |
| Prefecture | slug and 2-digit JIS | `saitama` / `11`, `tokyo` / `13` | URL; API `tdfk` (`11`) |
| City | 3-digit `skcs` = JIS city code without the prefecture | `221` 草加市 (JIS 11221), `222` 越谷, `203` 川口, `234` 八潮, `122` 葛飾 (13122) | `/area/{skcs}.html`, API `skcs` |
| 支社 shisya | 2 digits | `50` 埼玉, `20` 東京・北海道・宮城, `30` 千葉・茨城, `40` 神奈川, `70` 東海, `80` 関西・中国, `90` 九州・山口 | URL prefix, API `shisya` |
| 団地 danchi | 3 digits | `409` | API `danchi`; photo paths `img_photo/50/50_409/` |
| 識別 shikibetu | 1 character | `0` (usually), `1` in `50_1551` 吉川 | API `shikibetu` |
| **Danchi ID** | `{shisya}_{danchi}{shikibetu}` | `50_4090` = 50 / 409 / 0 | Page URL, `map_marker` `id`, inline `initSearch('50','409','0')` |
| Room `JKSS` | 9 digits, opaque | `000010701` | `_room.html?JKSS=`, API `id` |
| **Room key** | danchi ID + JKSS | `50_4090000010701` | API `bookmark_key`; Criteo tag `p=504090000010701` |
| Enquiry key | `10` + shisya + danchi + shikibetu + JKSS | `1050409000010701` | `sumai.r6…/otoiawase/juko.html?in=` (the `10` prefix is unexplained) |
| Station | UR's own numeric code | `2430` 草加 | `/eki/{code}.html`, `rosenzu_marker` `id` |
| Line | UR's own numeric code | `13900` | `/ensen/{line}/` |
| Shop | slug | `shinkoshigaya` | `/counter/{slug}/`, API `shopHtmlName` |

How to read them:
- The 4-character tail of a danchi URL is **danchi (3) + shikibetu (1)**:
  `50_4090` → danchi `409`, shikibetu `0`; `50_1551` → danchi `155`,
  shikibetu `1`. Image folders drop the shikibetu (`img_photo/50/50_155/`).
  Kyushu has letter tails (`90_114a.html`); how that splits is unverified.
- **JKSS is a room code unique within a danchi, not a parseable 棟/号室.** It
  often looks like 棟 (5 digits) + 号室 (4 digits): `000010701` = 1号棟701,
  `001090305` = 1-9号棟305, `010100404` = 10-10号棟404, `005060104` = 5-6号棟104.
  But other danchi pack it differently: `000204403` = 2-4号棟403 (わし宮),
  `000517301` = 5-17号棟301 (吉川), `000307501` = 3-7号棟501 (北本), and
  `000101106` = 1号棟1106 (南六郷二丁目). Rooms with no 棟 use zeros:
  `000000304` = 304号室 (アーバンハイツ南前川). Read 棟/号室 from the API
  (`roomNmMain` 「1号棟」 + `roomNmSub` 「701号室」, or `building` 「5-17」 + `roomNo` 「301」).
- The danchi ID and JKSS are stable enough that third-party sites reuse them:
  hereur.eunjay.com's `/ja/complexes/kanto-saitama-50_4090/` and
  kuushitsu-info.jp's `/ur/area/kanto/saitama/50-4090` (see those docs) both
  embed `50_4090`. So **`{shisya}_{danchi}{shikibetu}` + JKSS is the
  cross-site join key**. Room re-listings likely keep the same JKSS (the
  code names the physical unit; unverified across time).

## 5. JSON API (`https://chintai.r6.ur-net.go.jp/chintai/api/`)

All endpoints are **POST**, `application/x-www-form-urlencoded` (jQuery
`serializeArray` form, repeated keys allowed), `dataType: 'json'`, called
cross-origin from `www.ur-net.go.jp` (CORS allowed). Responses are JSON arrays;
many values are pre-rendered HTML snippets (`<li>…</li>`, `&#13217;` for ㎡).
`null` means "nothing" (also returned when a required parameter is missing).
Endpoint paths come from `api_bukken_search.js`, `api_bukken_result.js`,
`api_bukken_detail.js`, `api_room_detail.js`, `api_areatop.js`, `cookie.js`
(all under `/chintai/common/js/`) and from the pages' XHR lists.

### Danchi and room detail (verified with real responses)

| Endpoint | Parameters | Returns |
| --- | --- | --- |
| `bukken/detail/detail_bukken/` | `shisya`, `danchi`, `shikibetu`, filters (`rent_low`, `rent_high`, `floorspace_low`, `floorspace_high`), `orderByField`, `orderBySort`, `pageIndex`, `sp` | `img[]` (25 for 50_4090: path, thumbnail, ALT, VR/panorama flags) and `kiboRoom[]` (8 suggested rooms elsewhere in the prefecture) |
| `bukken/detail/detail_bukken_room/` | same | **The vacancy table.** Header: `allCount`, `pageIndex`, `rowMax` 5, `pageMax`, `block`, `tdfk`, `floorAll` 「14階」. Per room: `id` (JKSS), `name` 「1号棟701号室」, `rent` 「108,400円」, `rent_normal` (pre-discount rent, when a scheme applies), `commonfee` 「3,500円」, `type` 「2DK」, `floorspace` 「50㎡」, `floor` 「7階」, `madori` (plan image URL), `system[]` (schemes, e.g. 近居割, 近居割WIDE), `design[]`, `featureParam[]`, `shikikin` 「2か月」, `roomDetailLink` |
| `bukken/detail/detail_bukken_bukken/` | same | Danchi extras: `danchiparking` (free spaces and fees: 「平面 空き台数：23台 料金：10,450円」…), `feature` (schools/parks within N minutes), `facility` (equipment list), `biko[]`, `priorityLink` (空室情報お届けサービス target), `danchiFeatureParam` (e.g. くらしつながるサポーター) |
| `bukken/detail/detail_bukken_tenpo/` | same | Shop(s): `tenpoNm`, `place`, `tel`, `opentime`, `holiday`, `link` `/chintai/kanto/saitama/counter/shinkoshigaya/` |
| `bukken/detail/detail_bukken_design/` | danchi id | Designer/renovation room types (not called) |
| `bukken/detail/detail_room/` | `id` (JKSS), `shisya`, `danchi`, `shikibetu`, `sp` | **Full room.** `roomNm`, `rent` (HTML), `commonfee_sp`, `madori` 「2DK」, `madoriYuka` 「2DK /50㎡」, `floor` 「7階 /14階」, `shikikin`, `requirement` 「ナシ」 (礼金等), `year` 「18」 (**管理年数**, years since UR started managing it), `availableDate` 「随時」 (入居可能時期), `feature`, `feature_pickup[]` (バス・トイレ別, 2階以上, 敷地内駐車場, エアコン, モニター付きインターホン, 追い焚き), `facility`, `parking`, `biko` (HTML notes, e.g. 「このお部屋はUR賃貸住宅取扱店（不動産会社）を通してのお申込みは出来ません」), `bikoUrLight`, `bikoEv`, `mihoshu` (未補修募集 flag), `system[]`, `design[]`, `img[]` (plan + room photos with captions), `movie`, `otherRoom[]`, `kiboRoom[]`, `netLink` (enquiry URL), `kariLink` (仮申込 link, empty here), `bookmark_key`, `roomCatch1/2`, `roomRead1/2` |

### Lists and search

| Endpoint | Parameters | Returns |
| --- | --- | --- |
| `bukken/result/bukken_result/` | `mode` (`area`/`eki`/`rosenzu`/`leadtime`), `skcs[]` or `eki[]`/`line[]`/`line_station[]`, `block`, `tdfk[]`, `rireki_tdfk`, filters (`rent_low`, `rent_high`, `walk`, `floorspace_low/high`, `years`), `orderByField` (1 = 家賃の低い順), `pageSize` (10/20/30), `pageIndex` | **One row per danchi** (verified for 草加市: 5 rows): `shisya`, `danchi`, `shikibetu`, `danchiNm`, `roomCount`, `allCount`, `bukkenCount`, `pageMax`, `traffic` (HTML), `trafficpdf`, `place` (address), `kouzou` (structure), `floorAll` (floors), `shikikin`, `shopName`, `shopNum`, `shopHtmlName`, `shopOpentime`, `shopHoliday`, `bukkenImg`, `danchiFeatureParam`, `system`, `room`, `kiboRoom[]`. `rentMin`/`rentMax`/`station` were null/empty |
| `bukken/result/bukken_result_room/` | same + `shisya`, `danchi`, `shikibetu`, `pageIndexRoom` | Rooms of one danchi: `id`, `roomNmMain` 「1号棟」, `roomNmSub` 「701号室」, `rent`, `rent_normal`, `commonfee`, `type`, `floorspace`, `floor`, `madori` (plan URL), `system[]`, `allCount`, `roomLinkPc` |
| `bukken/result/bukken_result_type/`, `bukken/result/bukken_result_room_img/`, `bukken/search/result_main/` | same | Counts / images / form state (not inspected) |
| `bukken/search/map_marker/` | `ne_lat`, `ne_lng`, `sw_lat`, `sw_lng`, `small`, filters | **Coordinates of every danchi in the box**: `[{"id":"50_4090","lat":35.84321012771111,"lng":139.799558133775,"roomCount":1}, …]` — 118 danchi for a box around 草加–葛飾 (35.75–35.92 N, 139.63–139.97 E), 34 vacant rooms |
| `bukken/search/map_window/` | `id` + filters | Popup for one danchi (not verified) |
| `bukken/search/rosenzu_marker/` | `block`, bbox | **Stations with coordinates and vacant-room counts**: `{"id":"2430","name":"草加","lat":35.8283…,"lng":139.8034…,"roomCount":1}` (68 in the box) |
| `bukken/search/rosenzu_main/`, `leadtime_main/`, `area_init/`, `area_main/`, `line_init/`, `station_init/`, `station_main/`, `list_init/`, `list_bukken/`, `bukken_main/` | the page's form (`todofuken`, `waribiki`, `system`, filters) | Picker counts. `list_init` returns `[{Key: area id, Value: rooms}]`. My one call to `station_main` with only the form returned `null` (needs the page's line parameters). |
| `room/list/` | `id` (danchi), `mode` (`init`/`add`), `last_id` | Rooms for the list page, 10 at a time: `id`, `name`, `rent`, `rent_normal`, `commonfee`, `type`, `floorspace`, `floor`, `status`, `madori`, `urlDetail` |

### Other endpoints and static JSON

| URL | Notes |
| --- | --- |
| `GET chintai.r6…/chintai/rent/{tdfk}.json` | **Average rent of currently advertised UR rooms by layout band** for the prefecture: 埼玉 `1R・1K/1DK 9`, `1LDK/2K/2DK 8.2`, `2LDK/3K/3DK 6.5`, `3LDK/4K/4DK 10.7`, `4LDK～ 10` (万円). 東京 12 / 10 / 9.2 / 13 / 13.4. Also the city list by sub-area. Page note: 「共益費・駐車場代などを除く賃料です（1日1回更新）」 |
| `GET chintai.r6…/chintai/ranking/{tdfk}.json` | Popularity ranks: top 20 `eki`, `city`, `rosen` with codes (埼玉 city #19 is 草加市 `221`; 川口市 #3) |
| `seidolist/init_seidolist/` | 空室情報お届けサービス target list (`initSeidoList('akishitsu')`) |
| `tokubetsu/init_tokubetsu/` | 特別募集住宅 list |
| `history/bukken/`, `history/room/`, `bukken/detail/insert_report_rireki/`, `cookie/{kbn}/`, `cookie/maintext_{mode}/` | Browsing-history and logging calls the pages make. Not data; a collector should not call them |
| `www.ur-net.go.jp/chintai_portal/emergency/…/chintai_info.json` | Site banner notices |
| `/chintai/_include/{bukken_result,bukken_detail,room_detail,…}/*.html` | HTML templates, incl. one per scheme (`room_detail/system_u35.html`, `system_sukusuku.html`, `system_urlight1…10.html`, `system_free*.html`, `system_shikikin_one.html`, `system_senior_*.html`) and design type (`design_muji`, `design_ikea`, `design_diy`, `design_renovation`, `design_premium`, `design_wakamono`, …) — these name every flag the API can return |
| `/chintai/pdf/traffic/{id}_traffic.pdf` | Walking time from each 棟 to each station (933 in sitemap; not opened) |

File paths seen:
`https://chintai.r6.ur-net.go.jp/chintai/img_photo/50/50_409/50_409_photo.jpg` (danchi photo),
`…/img_photo/50/50_409/1504091000010701/B00073635.jpg` (room photos, folder includes the JKSS),
`https://sumai.r6.ur-net.go.jp//chintai/recruit/ArrNormal/10/50409/0000001/G9p/RA/Image/50_409_0-00-0001_G9p_RA_01_00007.gif`
(floor plan, keyed by plan type, so shared by rooms with the same plan; unverified).

## 6. Page anatomy

### City / station list (`/area/{skcs}.html`, `/eki/{eki}.html`)
- HTML shell plus `bukken_result` and `bukken_result_room` calls. Text shows
  「該当空室数1部屋」「5物件中 1～5物件表示」, then one cassette per danchi:
  name, up to three 交通 lines, 住所, 空室状況 count, 対象制度, 敷金 2か月, and
  up to 5 room rows (部屋名, 家賃(共益費), 間取り/床面積, 階数, 部屋詳細 link).
- A danchi with no vacancies says 「指定条件ではすぐにご案内できるお部屋がございません」
  and gives the shop.
- Sort: 家賃の低い順/高い順, 間取りが大きい順, 面積が広い順, 新着順; page size 10/20/30.
  Filters: rent, 共益費を含む, layout, walk minutes, バスを利用しない, floor area,
  管理年数, こだわり (バス・トイレ別, 2階以上, 敷地内駐車場あり, エアコン, モニター付き
  インターホン, 追い焚き, 南向き, リノベーション, 光配線, 温水洗浄便座), 制度 (近居割,
  U35割, すくすく割, 子育て割, URライト, 定期借家を含まない, フリーレント1/2か月).
- 「希望の条件に近い部屋を見る」: 8 suggested rooms with name, rent, layout, 棟, 号室.
- Freshness line under the list: **「空室は前日以前の状況です。先着順のためご希望の住戸のお申込みができない場合があります。」**

### Danchi page (`/{shisya}_{danchi}{shikibetu}.html`)
- **Server-rendered:** name with reading (「コンフォール松原 こんふぉーるまつばら」),
  家賃(共益費) range of the whole estate (「67,300円～167,400円(3,500円)」, the page
  says this is for all managed units, not current vacancies), 間取り/床面積 range
  (「1K(ﾜﾝﾙｰﾑ)～3LDK+AN/37㎡～86㎡」), **戸数** (3,050), 交通, 住所, shop and phone,
  a catch copy and description, 構造・駐車場 tab.
- **From the API:** photos (`detail_bukken`), vacancy table (`detail_bukken_room`,
  5 per page), parking/feature/facility (`detail_bukken_bukken`), shop(s)
  (`detail_bukken_tenpo`).
- Narrowing form (GET on the same URL): `rent_low`, `rent_high`, `commonfee`,
  `floorspace_low/high`, `room`, `system`, `life_renovation`, `life_diy`,
  `life_pet`, `life_childcare_stageselect`, `eldery`, `life_telework`,
  `available` (内覧可能な部屋のみ = 空家補修工事完了).
- Inline script: `ur.api.bukken_detail.initSearch('50', '409', '0')`.

### Room page (`/{id}_room.html?JKSS=`)
- HTML shell; everything comes from `detail_room`. Shows 家賃(共益費), 礼金等 ナシ,
  敷金 2か月, 間取り/床面積, 階数 「7階 /14階」, 対象制度, 種類 (定期借家 etc.), 交通,
  住所, photos and floor plan, 特徴ピックアップ, then 物件概要: 構造, 敷地内駐車場
  (free spaces and fees), **管理年数** (18年), **入居可能時期** (随時), 特徴, 設備, 備考.
- Shops that take enquiries, 「この建物の空室一覧をみる」, 近隣の部屋 (8 rooms).
- Title: 「コンフォール松原（埼玉県）1号棟701号室の賃貸物件｜UR賃貸住宅」; canonical keeps `?JKSS=`.
- A missing JKSS shows an error template and redirects to the danchi page after 5 s
  (`visibleNotExit`, `errLimit: 5000`), so a gone room is detectable by
  `detail_room` returning `null`.

### Other pages
- `_report.html` 団地のくらし: long editorial text about the town and estate
  (コンフォール松原: the former 草加松原団地, once 「東洋一のマンモス団地」), photos.
- `_map.html`: Google map only.
- Prefecture hub: popular cities/stations/lines (ranking JSON), average rent by
  layout (rent JSON), 団地のくらし articles, 新規募集開始物件 (empty that day).
- `counter/{shop}/`: address, phone, hours, holiday, directions, 店舗の特徴
  (＃予約優先 ＃契約可 ＃駐車場あり ＃キッズコーナー ＃高齢者相談窓口), links to nearby lists.
  Shop types seen: UR営業センター, UR賃貸ショップ, 現地案内所 (URせんげん台現地案内所,
  10:00–17:00). All closed Wednesdays.

## 7. Other official data pages

- **空室情報お届けサービス・優先受付** (`/chintai/akishitsu/`): for 子育て世帯 and
  若者夫婦世帯 (spouse under 40). You register wish conditions (valid 30 days);
  when a matching room **starts being advertised** UR emails it 「朝10時頃に自動配信」,
  and only these households may apply for the first **3 business days**
  (優先受付期間). Targets: 東京 20, 神奈川 8, 千葉 7, **埼玉 11**, 愛知 8, 京都 2,
  大阪 4, 兵庫 8, 奈良 2, 北海道 6, 福岡 6 物件; the per-danchi rows load on click
  (not read; which 埼玉 danchi are targets is unverified). In the API a target
  danchi has a non-empty `priorityLink`. Registration needs a login: not used.
- **特別募集住宅** (`/chintai/tokubetsu/`): rooms where a resident died; rent
  halved for 1–2 years in some. 東京 10, 千葉 16, 神奈川 7, none in 埼玉 that day.
  Apply only at shops.
- **抽選 (lottery)**: most UR rooms are 先着順. Lotteries are announced under
  `/chintai/information/` (tag 抽選), e.g. `2026/09/1315.html`
  「東京都葛飾区における家賃補助付きセーフティネット住宅の抽選募集について」
  (アクシス東四つ木団地, PDF `/chintai/pdf/2026/20260918_1315_release.pdf`), and
  monthly 知立団地 lotteries with results. The top page's 新規募集開始物件 block
  was empty on 2026-10-09.
- **Discount schemes** (`/chintai/whats/system/…`): `kinkyo` 近居割 (5% or 20%
  for up to 5 years; also 近居割WIDE), `u35` U35割 (定期借家 3 years), `sukusuku`
  すくすく割 (child under 18; `sonomama/` そのママ割 **redirects here**, so it was
  renamed), `kosodate` 子育て割 (income-tested, up to 20% for up to 9 years),
  `ur-light` URライト (定期借家), `freerent` フリーレント (1 or 2 months),
  `pet` ペット共生住宅, `eldery` 高齢者向け, `diagnosis` (which schemes apply).
  Per room they appear as `system[]` entries (制度名 + 制度HTML key) and as
  `rent_normal` (pre-discount rent) when the shown rent is discounted; the page
  warns 「表示中の家賃には定期借家等の各種割引制度適用後の家賃を含む場合があります」.
- **宅建業者の皆さまへ** (`/chintai/kanto/assen/` → `/chintai_portal/assen/`):
  brokers (UR賃貸住宅取扱店) can introduce some rooms; room `biko` says when a room
  can only be applied for at UR's own counters.
- **Residents**: `/chintai_portal/kyojyusha/` and the URくらしのアプリ. URコミュニティ
  (ur-cm.co.jp) manages estates for residents; it publishes no vacancy data (not loaded).

## 8. Information inventory

| Item | On the official site? | Where |
| --- | --- | --- |
| Current vacancies | Yes, the source of truth, as of the previous day | `detail_bukken_room`, `bukken_result_room`, `room/list`, `/area/`, `/eki/` |
| Rent, 共益費 | Yes, per room; `rent_normal` when discounted | room APIs |
| Estate rent range (all units) | Yes | danchi page HTML |
| Layout, area, floor, total floors | Yes | room APIs |
| 棟 and 号室 | Yes | `name`, `roomNmMain/Sub`, `building`/`roomNo` |
| Floor plan, photos | Yes | `madori`, `img[]` |
| Coordinates | Danchi and stations | `map_marker`, `rosenzu_marker` |
| Stations, walk/bus minutes | Yes, plus a per-棟 PDF | `traffic`, `/pdf/traffic/` |
| Building age | Only 管理年数 (years managed), and the 管理年数 filter | `detail_room.year` |
| Total units (戸数), structure, floors | Yes | danchi HTML, `bukken_result.kouzou/floorAll` |
| Parking availability and fees | Yes, free spaces per type, previous day | `danchiparking` / `parking` |
| Equipment, nearby schools/parks | Yes | `facility`, `feature`, `feature_pickup` |
| Move-in date | Yes | `availableDate` |
| Discount schemes, 定期借家 | Yes | `system[]`, `design[]` |
| Vacancy appear/disappear history | **No** | — |
| Contract (成約) history, days on market | **No** | — |
| Rent history | **No** (only today's prefecture average by layout) | `rent/{tdfk}.json` |
| Statistics / rankings | Popularity ranks; vacant-room counts per city, station, line | ranking JSON, pickers |
| Reviews / 口コミ | No | — |
| Waiting list | No; 空室情報お届けサービス (priority email) instead | `/akishitsu/` |
| Notifications | Email for target households only (login) | `/akishitsu/` |
| Freshness | 「空室は前日以前の状況です」; parking 「空き台数・料金は前日以前の状況です」; average rent 「1日1回更新」; `ranking`/`rent` JSON `Last-Modified: Fri, 09 Oct 2026 03:32 GMT` (12:32 JST). No per-room "listed on" or "updated" date anywhere | lists, room pages |

## 9. What is unique here

Everything other UR sites show comes from here. Only the official site has:
the API itself (room-level data, JKSS, plan images, photos), parking
availability, 管理年数, 入居可能時期, scheme flags with pre-discount rent,
coordinates for every danchi, the per-棟 walking PDFs, shop assignments,
lottery notices, and the 空室情報お届けサービス target list. What it lacks is any
history: no first-seen date, no removed rooms, no past rents. That history
must come from our own daily snapshots or from the third-party trackers.

## 10. Collector notes

- **Best path:** in the headed browser, open one official page per prefecture
  (e.g. `/chintai/kanto/saitama/area/221.html`) and call the API from that page
  with jQuery or `fetch`, the way the page does:
  1. `bukken/result/bukken_result/` with `mode=area`, `skcs=221` (and `203`,
     `222`, `234`; `tdfk=13`, `skcs=122` for 葛飾), `block=kanto`, `tdfk=11`,
     `pageSize=30` → every danchi with `roomCount`.
  2. For danchi with `roomCount > 0`: `bukken/detail/detail_bukken_room/`
     (`shisya`, `danchi`, `shikibetu`, `pageIndex` 0…`pageMax`) → every vacant room.
  3. For new JKSS: `bukken/detail/detail_room/` → full room record.
  4. Once: `map_marker` over our area → lat/lng per danchi;
     `detail_bukken_bukken` → estate facilities.
  That is about 5 list calls plus a few per vacant room per day for our area
  (34 vacant rooms in the 草加–葛飾 box today). Alternatively load the static
  pages (`/area/{skcs}.html`, danchi pages) and read the rendered DOM; same data,
  more page loads.
- **Key:** store danchi as `{shisya}_{danchi}{shikibetu}` and rooms as
  danchi ID + JKSS. Keep 棟/号室 text as observed fields; do not derive them from
  JKSS.
- **Gone signal:** a room is gone when it disappears from `detail_bukken_room`
  for its danchi, or `detail_room` returns `null` (the room page then redirects
  to the danchi page). The site gives no removal date, so the date is our
  first missing snapshot.
- **Cadence:** data is "as of the previous day", so one sweep per day is enough;
  new rooms for 空室情報お届けサービス danchi are emailed around 10:00 and are
  reserved for target households for 3 business days, so a new room seen on
  the public site may not be open to everyone yet.
- **Pitfalls:** rent and fee values are strings with HTML and 「円」; ㎡ is
  `&#13217;`; `null` for both "none" and "bad request"; `floor` is 「7階」 in lists
  but 「7階 /14階」 on the room page; the estate rent range on the danchi page is
  for all units, not vacancies; discounted rents can be shown as the rent
  (check `rent_normal` and `system`). The sitemap is from 2022; use the area
  pages or `map_marker` to discover danchi. Do not call `history/*`,
  `insert_report_rireki` or `cookie/*`.
- **robots / terms:** the `/result/?skcs=…` style URLs are disallowed; static
  `/area/` and `/eki/` pages and the API are not covered by those rules.
  「このサイトについて」 says the content is copyrighted and may not be
  republished without permission except private use or quotation
  (「当機構に無断で転載等を行うことはできません」), and that accuracy and
  timeliness are not guaranteed. Personal, non-published use for our own search
  fits private use; do not republish photos or plans.

## 11. Checked (2026-10-09)

- Headed Chromium, 63 navigations: 42 HTML pages (top, 埼玉/東京 hubs, area
  pickers, 5 city lists, 2 station lists, line page, list, map, rosenzu,
  leadtime, result, 5 danchi pages, 3 room pages, report, map page, akishitsu,
  tokubetsu, information list and one notice, system pages, 3 counter pages,
  assen, guide, sp mirror), plus 9 JS files and the sitemap, plus 11 reloads to
  read API responses. Slightly over the ~60 budget because the JS files were
  opened as separate documents.
- API responses read: `detail_bukken`, `detail_bukken_room`,
  `detail_bukken_bukken`, `detail_bukken_tenpo` (50_4090), `detail_room`
  (50_4090 / 000010701), `bukken_result` and `bukken_result_room` (草加市),
  `map_marker` and `rosenzu_marker` (草加–葛飾 box), `rent/11.json`,
  `ranking/11.json`. `station_main` and one hand-built `map_marker` call
  returned `null` (missing page parameters); not retried.
- Not checked: robots.txt of `chintai.r6.ur-net.go.jp`; the language PDFs; the
  akishitsu per-danchi rows; `map_window`, `list_bukken`, `room/list`
  responses; whether JKSS stays the same when a room is re-advertised.
