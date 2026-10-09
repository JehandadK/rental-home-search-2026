# UR Alert (uralert.jp) site map

Mapped on **2026-10-09** in a headed Playwright browser (one tab, 8–14 s between
pages): 33 page loads (robots.txt, sitemap, home, hubs, 5 city pages, 2 station
pages, 2 line pages, 6 building pages, legal/blog pages, and 2 re-loads of a
building page and `/listings` to read the page's embedded data). Nothing was
fetched with curl or fetch, and nothing under `/api/` was requested by us.

## 1. What it is

- **Independent e-mail notifier** for UR賃貸 vacancies, run by one individual
  developer (sole proprietor, named on `/tokusho`; "独立した個人運営のサービス" on
  `/about`). Not affiliated with UR. Applications go to UR's own site.
- Languages: Japanese, plus English pages (`/en`, `/en/tokyo`, `/en/pricing`);
  every building and listing also carries an English name (`name_en`).
- Plans: **Free** = watch 5 buildings, one digest e-mail a day at 17:30 JST.
  **Paid ¥500/month** = 20 buildings, alert "数分以内". Both can filter by layout
  and minimum floor area. Login is a magic link by e-mail. LINE delivery is
  "近日対応予定".
- Claims "1,376 棟を監視中" (home, `/trends`, `/map`). Covers 20–23 prefectures
  (`/listings` filter lists 20; home says 全23都道府県).
- Monitoring window: the blog says it crawls UR **daily 8:30–17:30 JST**; nationwide
  monitoring started in **June 2026** (earlier only some areas). Building pages say
  "過去147日" of observation (so data from about mid-May 2026).
- Stack: Next.js App Router (RSC; `?_rsc=` prefetches, `self.__next_f` payloads),
  Vercel (`dpl_` query on chunks), Microsoft Clarity analytics, Leaflet/OSM map.

## 2. robots.txt and sitemap

```
User-Agent: *
Allow: /
Disallow: /admin  /admin/  /api/  /auth/verify  /unsubscribe  /preview-email
(AhrefsBot, AmazonBot, SemrushBot, MJ12bot, DotBot: Disallow: /)
Sitemap: https://uralert.jp/sitemap.xml
```

`/sitemap.xml` is a single urlset of **235 URLs** (all `<lastmod>
2026-10-02T16:30:47Z`):

| Pattern | Count | Notes |
| --- | --- | --- |
| `/browse/{pref}/{city}` | 106 | only a subset of cities (saitama: 17 of the 28 on the page; soka, koshigaya, kawaguchi and tokyo/katsushika are in, yashio is not) |
| `/stations/{pref}/{station}` | 63 | only mie, kyoto, hyogo stations; the hub has 714 |
| `/blog/{slug}` | 27 | articles |
| `/browse/{pref}` | 23 | prefecture hubs |
| `/en/…` | 2 | `/en/tokyo`, `/en/pricing` |
| top-level pages | 14 | `/`, `/browse`, `/listings`, `/map`, `/stations`, `/lines`, `/trends`, `/about`, `/pricing`, `/en`, `/terms`, `/privacy`, `/tokusho`, `/blog` |

**No `/buildings/…` URL is in the sitemap.** Building pages are found only by
following links from city, station, line and listing pages.

## 3. URL hierarchy

```
/                                   home (counts: 1,376 棟; latest blog posts)
├ /browse                           all prefectures (23)
│ ├ /browse/{pref}                  prefecture hub: 監視中, いま空室あり, city list with building counts,
│ │                                   line checkboxes, every building card (vacant first, then 満室)
│ │   e.g. /browse/saitama          118 監視中 · 30 空室あり · 28 主要エリア (2026-10-09)
│ └ /browse/{pref}/{city}           city page: building count, vacant count, stations, all buildings
│     /browse/saitama/soka          草加市   5 棟 (1 vacant)
│     /browse/saitama/koshigaya     越谷市   3 棟 (0)
│     /browse/saitama/kawaguchi     川口市  16 棟 (3)
│     /browse/saitama/yashio        八潮市   1 棟 (0)
│     /browse/tokyo/katsushika      葛飾区  20 棟 (0 at load time)
│     city slugs are romaji: saitama-city, kyoto-city, soka, kawaguchi, katsushika …
├ /buildings/{uuid}                 BUILDING page (one UR 団地; the key page)
├ /listings                         every current vacant room ("3,142件の空室"; RSC total 2,965)
├ /stations                         714 stations, grouped by region/prefecture, each with building and vacancy counts
│ └ /stations/{pref}/{駅名}         station page, Japanese name URL-encoded, no "駅"
│     /stations/saitama/草加         4 棟 (八潮, グリーンアベニュー谷塚, コンフォール松原, コンフォール草加)
│     /stations/saitama/獨協大学前   3 棟
├ /lines                            145 lines with building and vacancy counts
│ ├ /lines/{路線名}                 line page: its stations with counts, every building on the line
│ │   /lines/東武伊勢崎線            17 駅 · 26 棟 · 3 空室あり
│ └ /lines/search                   pick region → lines → stations (client-side)
├ /map                              Leaflet map of all buildings ("1,376棟・空室あり489棟"); loads /api/buildings/map
├ /trends                           空室スピード分析 (days-on-market statistics)
├ /blog, /blog/{slug}               27 articles, some with the site's own vacancy statistics
├ /about, /pricing, /terms, /privacy, /tokusho
├ /en, /en/tokyo, /en/pricing       English
└ /login, /browse?q={term}          (SearchAction in JSON-LD)
```

Station and line names come from UR's 交通 text, so odd entries appear:
川口市's page lists 東京駅, 新宿駅 and 上野駅 next to 川口駅, and 葛飾区 lists 大手町駅
and 銀座駅. Some stations are duplicated under two spellings (獨協大学前 and
獨協大学前〈草加松原〉).

## 4. Identifiers — joins on UR's own codes

| Thing | Site's own ID | UR code exposed | Example |
| --- | --- | --- | --- |
| Building (団地) | UUID, `/buildings/2e6bc935-8627-4f8d-9788-a70cb485e2cb` | yes: `ur_url` / "UR公式ページで確認" link `https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090.html` | コンフォール松原 = UR `50_4090` (支社 50, 団地 409, 識別 0) |
| Room | `listing_id` UUID (in `/listings` data only) | yes: `…/50_4090_room.html?JKSS=000010701` | "1号棟 701号室" |
| Images | none | UR's own image paths, hot-linked | `chintai.r6.ur-net.go.jp/chintai/img_photo/50/50_409/50_409_photo.jpg`; 間取り図 `…/img_madori/50/50_289/50_289_0-00-0000_Ff_RA_01_00009.gif` or `sumai.r6.ur-net.go.jp//chintai/recruit/ArrNormal/10/50409/0000001/G9p/RA/Image/50_409_0-00-0001_G9p_RA_01_00007.gif` |

So the site **does reuse UR's codes**: every building page carries the UR 団地
URL (shisya_danchi+shikibetu) and every room carries UR's `JKSS` room code.
Pairs seen: `JKSS=000010701` = 1号棟 701号室, `000060501` = 6号棟 501号室,
`000000912` = 912号室 (single building), `014020801` = 14-2号棟 801号室. That
looks like 5 digits of 棟 (`01402` = 14-2) + 4 digits of 号室, but the rule is
inferred from four samples (unverified). The UUIDs are UR Alert's own; to map
UUID → UR code you must load the building page (or the city page, then each
building).

Our-area building UUIDs (from city pages, 2026-10-09):

| Building | UUID | UR code |
| --- | --- | --- |
| コンフォール松原 (草加) | 2e6bc935-8627-4f8d-9788-a70cb485e2cb | 50_4090 |
| ハーモネスタワー松原 (草加) | 8a2128fa-2ce6-4280-9045-c3b3037fdab1 | 50_3880 |
| グリーンアベニュー谷塚 | c15d9e62-9f6d-4e6d-b389-4d4de57d00a7 | (not loaded) |
| コンフォール草加 | 1cb44c9f-5849-4479-88e0-139f40ea01d2 | (not loaded) |
| 草加旭町 | 0be0960e-469c-478a-8e61-98d45fe564f0 | (not loaded) |
| 八潮 | 53774016-4926-4b9b-826f-34dd62816517 | 50_1390 |
| せんげん台パークタウン三番街 (越谷) | 30c763d6-d39e-4680-b88b-4e635500cd34 | 50_2180 |
| せんげん台パークタウン四番街 | 9365fd2d-3e18-4b8d-9950-c13877d12345 | — |
| ペアハイツ越谷 | eb8fb236-a677-4e8f-9f41-d0dfb9cc3dea | — |
| リプレ川口二番街 | 52498295-a12c-4461-bbd4-8d612be16a59 | 50_2890 |
| エステート東新小岩 (葛飾) | 6f170d21-04e0-4415-bff9-52a0fbc83139 | 20_3420 |

The other 14 川口市 and 19 葛飾区 UUIDs are on their city pages (saved snapshot).
越谷レイクタウン is not a UR building on this site; 越谷市 has only the three above.

## 5. Page anatomy

All pages are server-rendered HTML (Next.js RSC). The data behind the page is also
embedded as JSON in `self.__next_f.push([...])` scripts, which is the cleanest
thing to parse. No `__NEXT_DATA__`. JSON-LD on every page: Organization,
WebSite (SearchAction), BreadcrumbList; building pages add WebPage→Residence;
`/listings` adds an ItemList.

### Building page `/buildings/{uuid}`
Visible: name, address, アクセス (every UR 交通 line, e.g. 東武伊勢崎線「獨協大学前」駅
徒歩2～9分), 家賃〜, 間取り〜, 階数 (14階建), 構造, 敷金 (2か月), current vacancy count,
"UR公式ページで確認" link; この建物について (家賃帯, 間取り range, 広さ range, 駅まで);
**間取り別の家賃の目安** (min–max of every vacancy seen, with count); **動きの速さ**
(平均で申込終了まで, 現在公開中, 過去N日の空室, 最後に空きが出たのは…); city context
(棟数, 空室, エリア最安, 平均掲載日数); **現在の空室** table (部屋 = 棟+号室, 間取り図,
間取り, 割引 tag, 専有面積, 階, 家賃, 共益費, UR room link); nearby buildings.

Embedded `detail` object (コンフォール松原, abridged):

```json
{"id":"2e6bc935-…","name":"コンフォール松原","name_en":"Confort Matsubara","block":"kanto",
 "prefecture":"埼玉県","area":"草加市","address":"草加市松原1-4","vacancy_count":1,
 "rooms":[{"room_label":"1号棟 701号室","room_type":"2DK","floorspace":"50㎡","floor":"7階",
   "rent":"108,400円","commonfee":"3,500円",
   "url":"https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000010701",
   "madori":"https://sumai.r6.ur-net.go.jp//chintai/recruit/…/50_409_0-00-0001_G9p_RA_01_00007.gif",
   "schemes":[{"key":"near_family","label_ja":"近居割","label_en":"Near-family"}]}],
 "ur_url":"https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090.html",
 "traffic":["東武伊勢崎線「獨協大学前」駅 徒歩2～9分", …], "floor_count":"14",
 "structure":"鉄筋コンクリート造","deposit":"2か月","building_img":"…/50_409_photo.jpg",
 "nearby":[{"id":…,"name":…,"name_en":…,"area":…}],
 "vacancy_stats":{"observation_days":147,"vacancies_observed":55,"currently_open":1,
   "closed_observed":54,"avg_days_on_market":4.8,"median_days_on_market":0.3,
   "last_opened_at":"2026-10-08T05:32:38.450274+00:00",
   "last_room":{"room_type":"2DK","rent":108400,"floorspace":50,"floor":"7階"}},
 "area_context":{"building_count":5,"open_building_count":1,"open_room_count":1,
   "min_rent":108400,"avg_days_on_market":5.4},
 "rent_by_layout":[{"room_type":"1DK","min":88600,"median":92950,"max":100100,"count":26}, …],
 "specs":{"layout_min":"AN","size_min":37,"walk_minutes":2,"bus_minutes":null,
   "stations":["獨協大学前","新田","草加"],"rent_min":67300,"rent_max":167400,"common_fee":3500}}
```

No coordinates, no 築年, no 戸数 and no per-room history list on the page; only the
aggregates above. `specs.layout_min` can be junk (`AN`). The room table shows only
rooms open now.

Sample stats seen 2026-10-09: ハーモネスタワー松原 avg 1.5 days, 10 vacancies in
145 days, last 42 days ago (2LDK 59㎡ ¥138,600); リプレ川口二番街 avg 0.1 days, 4 in
146 days; 八潮 7.6 days, 8 in 145 days (2DK ¥42,600–43,700 ×3, 3K, 3DK);
せんげん台パークタウン三番街 12.3 days, 9 in 141 days (all 3LDK ¥84,700–98,000);
エステート東新小岩 3.2 days, open now 6号棟501 3LDK 69㎡ ¥113,600.

### City / prefecture / station / line pages
Same building card everywhere: vacancy badge (空室N室 or 満室), city, name,
address, rent (from) and 家賃帯, 駅徒歩 or バス N分, smallest layout, **約N日で成約**
(average days on market; 即日 = same day), link to `/buildings/{uuid}`. Counts at
the top (棟, 空室あり). Sort options: おすすめ, 家賃, 空室が多い順, 決まりやすい順.
Filters (layout, walk minutes) are client-side, not in the URL.

### `/listings`
All open rooms, newest first; 48 in the first payload, then "もっと見る"
(pager mechanism not checked). Filters (prefecture, rent, area, layout, sort,
割引: URライト, U35割, 子育て割, 近居割, シニア向け) are client-side. Card: 新着, layout,
㎡ · floor, building, city · prefecture, rent (or —), 共益費, 割引 tag, UR room link.
Embedded items:

```json
{"listing_id":"8dc5e5ea-…","building_id":"a5bca5eb-…","building_name":"コンフォール茅ヶ崎浜見平",
 "prefecture":"神奈川県","area":"茅ヶ崎市","room_label":"14-2号棟 801号室","room_type":"3DK",
 "floorspace":"66㎡","size_value":66,"floor":"8階","rent":"142,300円","rent_value":142300,
 "commonfee":"4,900円","madori":"…","schemes":[…],"building_img":"…",
 "first_seen":"2026-10-08T23:32:09.037147",
 "ur_url":"https://www.ur-net.go.jp/chintai/kanto/kanagawa/40_4240_room.html?JKSS=014020801"}
```

`first_seen` (UTC, no zone suffix; 23:32 UTC = 08:32 JST, the first crawl of the
day) is the only per-room timestamp the site exposes. Scheme keys seen:
`near_family`, `family`, `u35`, `ur_light`, `senior`. Totals disagree: page text
"3,142件", RSC `total` 2,965 (loads about an hour apart).

### `/trends` (空室スピード分析)
Median 7 days to fill; 1,376 buildings; **17,769 vacancies observed in 147 days**.
Top-24 fastest buildings (avg days, n), e.g. リプレ川口二番街 即日 (n=4), 青戸第二 即日
(n=3). Per prefecture: observed vacancies, median days listed, buildings —
埼玉県 1,472 · 6日 · 99; 東京都 2,697 · 2.2日 · 263.

### `/map`
Leaflet/OSM; filter by prefecture and 空室あり/満室; data from **`/api/buildings/map`**
(disallowed in robots.txt; contents not read). Likely the only place with
coordinates (unverified).

### Blog
Some posts publish their own data, e.g. `/blog/ur-aki-deru-jiki`: 6,731 new
vacancies detected 2026-05-14 to 07-05 — 月曜 33%, 金曜 24%, 水曜 under 1%; 10時台 44%.

## 6. Information inventory

| Item | Here? | Where / notes |
| --- | --- | --- |
| Current vacancies (room level) | yes | building page table, `/listings` |
| Rent, 共益費 | yes | per room; building 家賃帯 |
| Layout, area, floor | yes | per room |
| 棟・号室 | yes | `room_label` ("1号棟 701号室") |
| Floor plans / photos | yes (UR's own images, hot-linked) | `madori`, `building_img` |
| Discount schemes | yes | `schemes` |
| Coordinates | not on pages | only via `/api/buildings/map` (disallowed) |
| Stations / access | yes | UR 交通 strings; station and line pages |
| Building age, 戸数 | no | 階数, 構造, 敷金 only |
| First-seen of a room | yes | `first_seen` on `/listings` only |
| Vacancy history (appear/disappear) | aggregates only | `vacancy_stats` per building: observed, open, closed, avg and median days, last opened |
| 成約 history | no (only "closed" counts and days-on-market) | "約N日で成約" is listing duration, not a confirmed contract |
| Rent history | aggregates | `rent_by_layout` min/median/max/count of every vacancy seen |
| Statistics / rankings | yes | `/trends`, per city/station/line counts, blog |
| Reviews / 口コミ | no | |
| Waiting list | no (blog explains UR's 空き待ち予約) | |
| Notifications | yes | e-mail; free 5 buildings 17:30 digest, paid 20 buildings realtime |
| Freshness | crawl 8:30–17:30 JST; `last_opened_at`, `first_seen` | different pages loaded minutes apart disagreed (コンフォール松原: 空室2室 on the city page, 満室 on the station page, 空室1室 on the line page) — pages appear cached |

## 7. Unique vs copied

Copied from UR: names, addresses, 交通, rooms, rents, fees, layouts, images,
discount tags, room and 団地 codes. **Unique**: 147 days of observation per
building — vacancies seen, days on market (avg/median), last vacancy date and room,
rent range per layout across all vacancies seen, `first_seen` per room,
prefecture-level fill-speed tables, weekday/hour analysis, and English names.

## 8. Collector notes

- Best paths for our area: `/browse/saitama/{soka,koshigaya,kawaguchi,yashio}`,
  `/browse/tokyo/katsushika` (gives every UUID and the 約N日で成約 per building),
  then `/buildings/{uuid}` for the 45 buildings (UR code, rooms with JKSS,
  `vacancy_stats`, `rent_by_layout`). `/listings` for `first_seen`.
- Parse the `self.__next_f` RSC payload (`"detail":{…}` on building pages,
  `"initial":{"total":…,"items":[…]}` on `/listings`) rather than the DOM.
- Join to UR data with `ur_url` (`50_4090`) and `JKSS`. Join to UR通知くん with
  the same UR 団地 path.
- Do not call `/api/` (robots.txt). Building pages are not in the sitemap.
- The value for us is the history aggregates (days to fill, rent bands), which
  only change slowly: a weekly load of ~50 pages would capture them. For
  current vacancies UR itself is the primary source.
- Pages may be cached for minutes to hours; treat each load as an observation
  with its own timestamp.
- Terms (`/terms`, 2026年5月) forbid 「当サービスが提供するデータの商業目的での無断利用・転売」
  and excessive load. Personal, low-rate reading seems in scope; ask before
  republishing anything.

## 9. Checked

2026-10-09: 33 page loads (2 from round 1). Files in the scratch `uralert/` dir.
Not checked: `/privacy`, `/en/*` content, the "もっと見る" pager, the
`/api/buildings/map` payload, the remaining 39 building pages in our area.
