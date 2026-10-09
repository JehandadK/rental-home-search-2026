# UR通知くん (ur-tsuchikun.jp) site map

Mapped on **2026-10-09** in a headed Playwright browser (one tab, 8–14 s between
pages): 16 page loads (robots.txt, home, sitemap, map pages, ranking, news, FAQ,
how-to, legal pages, plus 4 loads of the map/ranking pages to read their own JSON).
The JSON was read by calling the same same-origin GET endpoints the pages call,
from inside those pages: 12 requests in total (`/api/danchi/map`,
`/static/stations_public.json`, `/api/danchi/quota` ×2, `/api/danchi/detail` ×1,
`/api/campaign`, `/api/ranking`, `/api/renovation-ranking/public`,
`/api/ranking/profile` ×4). No curl or fetch from the command line, no LINE login.

## 1. What it is

- **Independent LINE notifier** for UR賃貸 vacancies, run by an individual
  (個人事業主; real name withheld on `/tokushoho`, which gives a handle). Footer:
  "本サービスはUR都市機構とは無関係の個人サービスです". Started 2026-05 (terms dated
  2026年5月12日; sample DB row `created_at 2026-05-16`).
- Japanese only (ranking page says so).
- You register **conditions** in the LINE bot: a station (or a single 団地 from the
  map) + layout + rent ceiling. Checks every **30 minutes from 9:00 to 1:00**
  (paused 1:00–9:00); alerts "最短30分以内". Notification text has name, address,
  layout, rent and the UR detail link (per `/howto`).
- Plans (home, `/terms` 最終更新 2026-10-06): おためし ¥0 (1 condition, 1 alert/month;
  **5/month during a campaign to 10/24**), かるく ¥100 (2 conditions, 50/month),
  しっかり ¥200 (3, 90), がっつり ¥300 (4, 160, +設備条件フィルター 15 items),
  じっくり ¥400 (5, 175, +新築情報), KIAI ¥500 (6, 190, everything). Higher plans
  also unlock more of the リノベランキング. Stripe. `/howto` still shows an older
  price table (しっかり 5件 ¥500, KIAI 20件 ¥1,300).
- Claims: home title "全国5,681駅対応"; map title "全国1,376団地". The data has
  **1,374 団地** and 5,681 station rows (see §4).
- Static HTML pages + vanilla JS; Leaflet 1.9.4 map, d3/topojson area map, LINE
  LIFF SDK, PWA service worker. No framework, no JSON-LD.

## 2. robots.txt and sitemap

```
User-agent: *
Allow: /
Disallow: /admin
Disallow: /payment/
Sitemap: https://ur-tsuchikun.jp/sitemap.xml
```

`/api/` is **not** disallowed. `/sitemap.xml` has **11 URLs**, all static pages:
`/`, `/ranking` (daily), `/map`, `/ur-chintai-map`, `/news`, `/faq`, `/howto`,
`/contact`, `/tokushoho`, `/privacy`, `/terms`. There are **no per-団地, per-station
or per-area pages** on this site at all.

## 3. URL hierarchy

```
/                         landing page (plans, comparison table, FAQ teaser)
├ /ur-chintai-map         UR賃貸マップ: Leaflet map of every 団地 (red = 空きあり, grey = 空きなし)
│   ?u=/chintai/{block}/{pref}/{code}.html   open one 団地's pin (UR's own path as the key)
│   ?pref=埼玉県                            zoom to a prefecture; the 団地 list by city appears under the map
│   ?station={駅名}                          select a station and its nearby 団地
├ /map                    対応エリアマップ (prefecture choropleth from /static/japan.topojson)
├ /ranking                ranking tabs (#renovation etc.)
├ /news                   お知らせ (feature log)
├ /faq, /howto
├ /contact, /tokushoho, /privacy, /terms
└ (LINE) line.me/R/oaMessage/@943itfvz/?UR賃貸登録:{団地名}   register a 団地 from the map
```

Every 団地 link on the site (`/ranking` entries, map pins) is a
`/ur-chintai-map?u=` deep link, e.g.
`/ur-chintai-map?u=%2Fchintai%2Fkanto%2Fsaitama%2F50_4090.html`, and the pin's
"UR公式で確認" button goes to `https://www.ur-net.go.jp` + that path.

## 4. Identifiers — the site keys everything on UR's path

| Thing | ID | Example |
| --- | --- | --- |
| 団地 | **UR's own detail-page path** `/chintai/{block}/{pref}/{shisya}_{danchi}{shikibetu}.html` | `/chintai/kanto/saitama/50_4090.html` コンフォール松原 |
| Station | Japanese name with 駅 and UR-style disambiguation | `草加駅`, `獨協大学前〈草加松原〉駅`, `札幌(ＪＲ)駅` |
| Prefecture (ranking API) | romaji key | `saitama`, `tokyo` |
| Room | none exposed | |

All 1,374 codes are `{2 digits}_{4 digits}`: 支社 `20` (336: 東京 + 北海道 + 宮城),
`30` (126: 千葉 + 茨城), `40` (166: 神奈川), `50` (118: 埼玉), `70` (103: 東海),
`80` (382: 関西 + 中国), `90` (143: 九州). 60 codes end in a non-zero 識別 digit
(`50_1551` 吉川, `50_1561` みさと, `20_4911` 青戸第一, `20_4481` すまいる亀有).
Blocks in the path: `kanto`, `kansai`, `tokai`, `kyushu`, `chugoku`, `hokkaitohoku`.

This is the same code UR Alert links to from its building pages, so the two sites
join directly on the UR path (and on UR's site itself).

## 5. Data sources and page anatomy

### `/ur-chintai-map` → `GET /api/danchi/map` (the main data, 288 KB JSON)

One array, **1,374 objects**, every field always present:

```json
{"url":"/chintai/kanto/saitama/50_4090.html","name":"コンフォール松原",
 "address":"草加市松原1-4","lat":35.84321012771111,"lng":139.799558133775,
 "has_vacancy":true,"updated_at":"2026/10/09 13:31","nearest_station":"獨協大学前駅"}
```

- 489 with `has_vacancy: true`, 885 false (13:31 JST run). `updated_at` is the same
  for every row (the last 30-minute check), so it is a run time, not a per-団地
  change time.
- The page reloads it every 30 minutes. Prefecture comes from the path segment.
- Under the map, filtering a prefecture lists 団地 per city with 最寄り駅 and 家賃目安.

Per prefecture: 東京 307, 大阪 206, 神奈川 166, 福岡 141, 埼玉 118, 千葉 110, 兵庫 103,
愛知 100, 京都 41, 北海道 26, 奈良 21, 茨城 16, 広島 7, 宮城 3, 三重/滋賀/山口 2,
和歌山/岡山/岐阜 1.

### Pin popup → `GET /api/danchi/detail?url={UR path}` (metered)

```json
{"vacancy_count":1,"rent_range":"67,300円～167,400円","used":1,"plan":"anonymous","limit":1}
```

Number of vacant rooms and the 団地's rent range. **Server-side quota**: anonymous
1 lookup (`/api/danchi/quota` → `{"plan":"anonymous","limit":1,"used":0}`), "LINE登録済みの
方はログインすると1日3件まで"; after that it returns `limit_reached`. The LINE ID token
goes in an `X-Line-Id-Token` header. No room-level data anywhere on the public site.

### `/static/stations_public.json` (343 KB)
5,681 rows `{"station":"草加駅","pref_name":"埼玉県","line":"東武伊勢崎線（東武スカイツリーライン）"}`
— 3,479 distinct names, 225 lines, 12 prefectures. This is the station picker for
LINE conditions, i.e. the "5,681駅" claim is station×line rows, not stations with UR.
草加駅 appears under both 埼玉県 and 東京都.

### `/ranking` → `GET /api/ranking` (21 KB)
Keys: `total_danchi` 1374, `vacant_danchi` 489, `updated_at` "13:31",
- `vacancy_top50`: `{"name","sub"(address),"count"(vacant rooms),"url"}` — 1 金剛 81.
- `area_ranking`: prefectures by vacant 団地 (埼玉県 37).
- `danchi_top50` / `danchi_top50_vacant` (人気団地TOP, updated daily): **average hours
  from a vacancy appearing to the 団地 filling**, only 団地 with ≥5 observations:
  `{"name":"コンフォール松原","sub":"草加市松原1-4","url":"/chintai/kanto/saitama/50_4090.html",
  "fill_count":45,"hours":29.03,"label":"2日以内","vacant":true}`. Our area in it:
  コンフォール松原 (45 fills, 29.0 h), エステート東新小岩 (6, 31.6 h).
- `station_top50`: stations by count (sparse, 1–3).

Tabs シーズン別, 時間帯別 and 人気駅TOP are "近日公開" placeholders.

`GET /api/ranking/profile?kind={station|suburb|large|new|historic|tower}&pref={key}&vacant={0|1}`
(UR賃貸図鑑, "公開記念で全機能無料公開中"; source note: 交通・戸数・管理年数 from UR,
updated monthly; vacancy every 30 min). Returns `total`, `updated_at`
("2026/10/08 22:08"), `prefs` (key, name, count) and up to 50 `items`
`{"url","name","value","label","unit","sub":[…],"vacant"}`:
- `large`: **総戸数** — みさと 6,735戸, コンフォール松原 3,050戸.
- `new` / `historic`: **管理年数** (years since the newest/oldest building) —
  コンフォール松原 8年 (range 8–18年).
- `station`: walk minutes to the nearest station; `suburb`: bus + walk minutes,
  with 家賃 range and sometimes 広さ — 八潮: 獨協大学前駅からバス10分＋徒歩1分,
  家賃 41,700円～57,000円; アーバンハイツ南前川: 蕨駅からバス7分＋徒歩1分, 67～79㎡.
- `tower`: floors of the tallest building.

`GET /api/renovation-ranking/public`: 団地 by number of renovated vacant rooms;
the public call returns ranks 41–50 only (`locked` lists which plan unlocks 1–40).

Other calls the pages make: `/api/campaign` (`{"active":true,"free_limit":5,
"end_date":"2026-10-24"}`), `POST /api/visitors/ping`, `POST /api/ranking/view`,
`POST /api/client-log` (not called by us).

## 6. Our area in the data (2026-10-09 13:31 JST)

| City | 団地 | 空きあり | 団地 (UR path code) |
| --- | --- | --- | --- |
| 草加市 | 5 | 1 | コンフォール松原 50_4090 (vacant), ハーモネスタワー松原 50_3880, コンフォール草加 50_3910, グリーンアベニュー谷塚 50_2610, 草加旭町 50_1340 |
| 越谷市 | 3 | 0 | せんげん台パークタウン三番街 50_2180, 四番街 50_2070, ペアハイツ越谷 50_2300 |
| 川口市 | 16 | 4 | e.g. 川口芝園 50_1820, リプレ川口二番街 50_2890 (vacant), コンフォール西鳩ヶ谷 50_4070 (vacant), コンフォール東鳩ヶ谷 50_4020 (vacant), アーバンハイツ南前川 50_2220 (vacant) |
| 八潮市 | 1 | 0 | 八潮 50_1390 (nearest_station 草加駅) |
| 葛飾区 | 20 | 1 | e.g. 青戸第一 20_4911, 金町駅前 20_1650, エステート東新小岩 20_3420 (vacant) |

No 越谷レイクタウン 団地 exists in the data. The same counts per city as UR Alert
(5 / 3 / 16 / 1 / 20).

## 7. Information inventory

| Item | Here? | Notes |
| --- | --- | --- |
| Current vacancy | 団地-level flag for all; vacant-room count for top 50 and via metered detail | no room list |
| Rent | 団地 rent range (detail call, suburb ranking) | no per-room rent |
| Layout, area, floor | no (広さ only in a few suburb-ranking rows) | |
| Floor plans / photos | no | |
| Coordinates | **yes**, every 団地 | `/api/danchi/map` |
| Stations | nearest station per 団地; full station list | |
| Building age | yes, as 管理年数 (min–max) | ranking profile `new`/`historic` |
| 戸数 | yes | ranking profile `large` |
| Vacancy history | aggregate: fills observed and average hours to fill | `danchi_top50`, top 50 only |
| 成約 / rent history | no | |
| Statistics / rankings | yes | vacancy counts, area, fill speed, リノベ counts, 図鑑 |
| Reviews / waiting list | no | |
| Notifications | LINE, station or 団地 + layout + rent, 30-min checks 9:00–1:00 | behind LINE friend-add |
| Freshness | `updated_at` run time on every row; profile data monthly | |

## 8. Unique vs copied

Copied from UR: names, addresses, coordinates (presumably from UR's map data),
vacancy state, rents, 戸数, 管理年数, 交通. **Unique**: one machine-readable list of
every 団地 with UR code, coordinates and vacancy flag in a single request; fill-speed
(hours to fill) for the 50 fastest 団地; renovated-room counts per 団地 (paywalled
above rank 41); bus-vs-walk access ranking.

## 9. Collector notes

- The one useful endpoint for us is `/api/danchi/map`: one GET returns every 団地
  with **UR code + lat/lng + has_vacancy + nearest station**. It gives a full
  団地 gazetteer for our area (45 団地) and a 30-minute vacancy flag, joinable to UR
  and UR Alert on the UR path. `/api/ranking/profile?kind=large|new|historic&pref=saitama|tokyo`
  adds 戸数 and 管理年数 (monthly).
- `/api/` is allowed by robots.txt, but it is an internal API with no public
  documentation. The terms (第6条) forbid 「当サービスを通じて取得した情報の無断転載・商業利用」,
  excessive load and reverse engineering, and 第7条 blocks accounts suspected of
  automated use. Reading `/api/danchi/map` through the map page once a day is low
  load, but ask the user before building a collector on it; UR's own site is the
  primary source for the same facts.
- Do not script `/api/danchi/detail`: it is metered per user and counts against
  the quota.
- Room-level data, history per room and notifications all sit behind LINE.

## 10. Checked

2026-10-09: 16 page loads and 12 same-origin JSON GETs made from the site's own
pages. Not checked: FAQ answers (collapsed), `/privacy` and `/contact` content,
`/api/ranking/profile` for `tokyo` and kinds `historic`/`tower`, the LINE bot.
