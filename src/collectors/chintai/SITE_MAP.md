# CHINTAI (www.chintai.net) site map and source plan

Mapped on **2026-10-04** in a headed Playwright browser (`BROWSER_DRIVER=playwright`),
one tab, 8–14 s between pages, 56 pages in total (robots.txt, 15 sitemaps, hubs,
list, detail, building, rent, archive and shop pages). Nothing was fetched with
curl or fetch. The URL grammar below is in code in
[`chintaiSite.ts`](chintaiSite.ts) and the town codes are in
[`chintaiTowns.ts`](chintaiTowns.ts).

CHINTAI belongs to the Able group (the footer links エイブル and the CHINTAIグループ). Able stores' ads make up much
of the inventory, which is why Able store codes are low numbers (`000000416`)
and other agents' codes start with `C`.

## 1. robots.txt and sitemaps

`/sitemap.xml` is a **404**. robots.txt names six sitemaps instead:

```
/xml/sitemap.xml ........................ index of 3
  ├ sitemap_feature.xml ................. 1 URL  (/feature/)
  ├ sitemap_madori.xml .................. 1 URL  (/madori/)
  └ sitemap_shop.xml .................... 1,378 shop pages  /shop/{shop}/
/xml/sitemap_detail.xml ................. index of 22
  ├ sitemap_detail_bk.xml, _bk_001…_bk_021  50,000 ad URLs each (~1.05M)  /detail/bk-{key}/
  └ sitemap_detail_tn.xml ............... 1,622 shop/office ads  /detail/tn-{key}/
/xml/sitemap_bld_true.xml ............... index of 6
  └ sitemap_bld_true_001…006 ............ 50,000 buildings each (~300k)  /{pref}/bld-{id}/  (has <lastmod>)
/xml/sitemap_list.xml ................... index of 93
  ├ sitemap_list_001.xml ................ 36,171 list pages: 29,245 area + 6,926 ensen
  ├ sitemap_list_madori_{1r…5ldk}.xml ... 12 files; the 2ldk one holds plain /list/ pages (23,789)
  ├ sitemap_rent_madori_{1r…5ldk}.xml ... 12 files of /list/{layout}/ pages (8,821 for 2ldk)
  └ sitemap_feature_{slug}.xml (68) ..... /list/{slug}/ pages, e.g. 12,729 for kodate
/news/sitemap.xml ....................... WordPress (All in One SEO) index of 5: articles
/sitemap_faq2_chintai_net.xml ........... 76 FAQ pages on faq2.chintai.net
```

The ad sitemaps carry no prefecture or city in the URL, so they cannot be
filtered to our area. They are useful only to check whether a known key is
still advertised. The building sitemaps do carry the prefecture.

Disallowed paths that matter to us:

| Disallowed | Meaning for a collector |
| --- | --- |
| `/list/?g=`, `/list/?b=`, `/list/?w=`, `/list/?ue=`, `/list/?rt=`, `/list/?o2&ue=` | The dynamic search-form URLs. Use the static SEO paths instead. |
| `/detail/*/?bld=`, `/detail/*/?vm=`, `/detail/*/?sidesFlg=1` | Detail URLs with list tracking queries. Strip the query and load `/detail/bk-{key}/`. |
| `/shop/*/?bk4log=` | Shop links from an ad. Load `/shop/{shop}/` without the query. |
| `/api/`, `/info/`, `/display/`, `/tracking/`, `/peya/` | Not needed. |

## 2. URL hierarchy

```
/                                          home
├ /{pref}/                                 prefecture hub (47; slugs: ibaragi, simane, sizuoka, kouchi, ooita…)
│ ├ /{pref}/area/                          cities and wards of the prefecture
│ │ └ /{pref}/area/{city}/list/            city results          city = JIS code, 11221 = 草加市
│ │   └ /{pref}/area/{town}/list/          town results          town = city + 3 digits, 11221027 = 氷川町
│ ├ /{pref}/ensen/                         lines of the prefecture
│ │ ├ /{pref}/en-{line}/                   stations of one line  line = 6 digits, 102082 = 東武スカイツリーライン
│ │ ├ /{pref}/ensen/{line}/list/           line results
│ │ └ /{pref}/ensen/{station}/list/        station results       station = 9 digits, 000004645 = 草加
│ ├ /{pref}/bld-{id}/                      building page         id = 7 digits
│ └ /{pref}/{seirei-city}/                 designated-city hubs (saitama/saitama/ = さいたま市)
│
│   every …/list/ accepts ONE extra segment, then a page:
│     …/list/{layout|type|theme}/page{n}/   (page 1 has no page segment)
│     layout: 1r 1k 1dk 1ldk 2k 2ldk 3k 3ldk 4k 4ldk 5k 5ldk
│     type:   mansion apart kodate
│     theme:  zero freerent pet parking family … (47 slugs, see chintaiSite.ts)
│     Two segments do not stack: /list/kodate/2ldk/ redirects to /list/kodate/.
│
├ /detail/bk-{key}/                        residential ad (one unit, one agent)
├ /detail/tn-{key}/                        shop/office (テナント) ad
├ /rent/                                   rent-market hub
│ ├ /rent/{pref}/                          average rent per city
│ └ /rent/{pref}/ensen/                    lines with ad counts
│     /{pref}/area/{city}/rent/            average rent per town
│     /{pref}/ensen/{line}/rent/           average rent per station
│     …/rent/{layout|type}/                same, narrowed to one layout or type
├ /archive/                                past and current buildings
│ ├ /archive/{pref}/area/ and /ensen/
│ ├ /archive/{pref}/area/{city}/[page{n}/] buildings of a city (草加市: 10,926)
│ └ /archive/{pref}/ensen/{station}/       buildings near a station
├ /shop/  and  /shop/{shop}/               agents; /shop/{pref}/ensen/
├ /feature/{slug}/[{pref}/]                theme landing pages
├ /madori/  and  /madori/{layout}/         layout landing pages
├ /tsukin/                                 commute-time search (form, JS)
├ /map/?lat=&lon=&zlv=&rt=                 map search (JS)
└ /news/, /guide/, /magazine/, /agent/ …   editorial and services
```

Sister sites with overlapping inventory: `sp.chintai.net` (mobile mirror of the
same paths), `woman.chintai/{pref}/address/{city}/list/`, `gakusei.chintai.net`.

The dynamic search form posts to `/list/?…` with `prefkey`, `g` (city), `cf`/`ct`
(rent from/to in thousands of yen, `0` = no limit), `m` (layout: 0 = 1R, 1 = 1K,
2 = 1DK, 3 = 1LDK, 4 = 2K, 5 = 2DK, 6 = 2LDK, 7 = 3K, 8 = 3DK, 9 = 3LDK,
A = 4K, B = 4DK, C = 4LDK, D = 5K/5DK, E = 5LDK+), `b` (1 = apartment,
2 = mansion, 3 = house/terrace), `kz` (structure), `h` (age), `j` (walk),
`sf`/`st` (area), `jks` (1/2/3 = new today / 3 days / 7 days), `o` (sort),
`p` (page size: 20/50/100). Choosing a sort or page size on a static page sends
the browser there: e.g. `/list/?cf=0&…&g=11221&prefkey=saitama&rt=50&o=7&i=1`.
`?o=7` appended to a static path is ignored.

Sort codes (`o`): 10 おすすめ, 2 rent low→high, 3 rent high→low, **7 新着順**,
8 most photos, 6 newest building, 4 largest, 9 most features.

## 3. Identifiers

| Thing | Format | Example | Notes |
| --- | --- | --- | --- |
| Prefecture | slug | `saitama` | Site romanisation, see `CHINTAI_PREFECTURES`. |
| City | 5-digit JIS code | `11221` 草加市, `11222` 越谷市, `11203` 川口市 | Same codes as government data, so joinable with census stats. |
| Town (町・大字) | city + 3 digits | `11221027` 氷川町 | 38 in 草加市, 57 in 越谷市, 101 in 川口市 (sitemap). |
| Line | 6 digits | `102082` 東武伊勢崎線・スカイツリーライン | `A…`/`B…` codes exist for some Shikoku lines. |
| Station | 9 digits | `000004645` 草加 | One code across lines (東川口 `000000261`). |
| Ad key | 28 chars: shop(9) + property(15) + room(4) | `000000416` `000000000536559` `0005` | The detail page shows it as 物件管理コード `000000416-000000000536559-0005`. |
| Shop | 9 digits (Able) or `C` + 8 digits | `000000416` エイブル草加西口店, `C01009532` | `/shop/{shop}/`. |
| Building | 7 digits | `bld-1282673` | Groups every ad in one building, across agents. |

**One unit, many ads.** Each agent that advertises a unit gets its own ad key.
Able stores share the property and room codes, so
`000000416|426|431-000000000536559-0005` is one room advertised by three Able
stores (`ableUnitKey` in `parseChintaiKey`). Other agents number units
themselves (`C01009091…`, `C01009127…` for the same flat), so those ads have to
be matched on building id + floor + layout + area + rent, the way the existing
dedup works. The list page also says so per ad: 「※他2店舗で取扱い」.

## 4. Page anatomy

### List page (`…/list/`)
- `span.totalCount`: total ads (units) for the place, e.g. 草加市 2,430.
- 20 building cassettes per page (`section.cassette_item.build`); page count is
  in buildings, so 草加市 has 34 pages. PR cassettes (`section.item_pr`) are
  mixed in and must be de-duplicated against the organic ones.
- Building fields: name and type (`h2`, `span.icn_typeB` 賃貸アパート/マンション/ハイツ),
  住所 (to 丁目), 交通 (up to three line/station/walk or bus lines), 築年, 階建, 構造.
- One `tbody[data-detailurl]` per unit with `data-cn-bkkey` (ad key) and
  `data-cn-shopkey`; cells for photo count, floor, rent + 管理費, 敷金/礼金,
  layout + m², tags (本日の新着, 南向き, 角部屋, 仲介手数料…), agent remarks,
  agent name and phone, and an update date.
- Hidden inputs per unit, machine-readable: `bkName`, `chinRyo` (rent, yen),
  `madori`, `senMenseki` (m²), `ekiName`, `ekiToho` (walk minutes),
  `newFlg`, `newTodayFlg`, `keiyakuKbn` (contract kind), **`publishEndDt`**
  (the ad's scheduled end, e.g. `2026-10-18T23:59:59.000+0900`), `imgUrl`, and
  `bk{n}` = `shop|property|room`.
- The town links carry counts: `氷川町(216件)`, so one city page gives a
  per-town ad count without loading each town.
- `<link rel="canonical">` and `rel="next"` are present; meta robots is `noarchive` only.
- The default おすすめ order rotates between loads (PR and new ads move), so a
  sweep can skip or repeat units across pages. See the plan.

### Detail page (`/detail/bk-{key}/`)
- Title and `h1` hold name, floor, address, rent and layout.
- `var LAT = …; var LNG = …;` in a script: the ad's coordinates.
- Hidden `cityCd` (JIS city code), `cityName`, `prefkey`.
- 物件概要 table (`th`/`td`): 家賃, 管理費等, 敷金/保証金, 礼金/償却, 交通 (with bus
  routes), 住所, 間取り with room sizes (`1K(洋室6.6・K2.0)`), 専有面積, 築年, 方位,
  建物種別, 構造, 物件階層 (`1階/2階建`), 位置 (角部屋/南向き), 放送・通信, 収納,
  キッチン/バス・トイレ, セキュリティ, その他, 駐車・駐輪 (with monthly fee and
  distance), その他初期費用 (cleaning, key change… each with yen), 更新料,
  家賃保証会社等, 保険, 条件, お得条件, 備考, 入居時期 (`空予定 (2026年11月中旬)`),
  契約期間, 取引形態 (媒介/一般媒介…), 物件管理コード, **情報更新日**, **広告更新予定日**.
- Every agent advertising the unit (取扱い店舗) with `/shop/{shop}/` links.
- `/{pref}/bld-{id}/` building link, town and station links.
- Photos on `img.chintai.net` (30 on the sampled ad) with alt text naming the room
  (外観写真, 間取り図, 居室…).
- Nearby alternatives (家賃がより安い, 駅からより近い) with keys: a free
  discovery feed.

### Ended or unknown ad
HTTP **404** with title 「該当する物件情報の掲載は、終了しました」 on the same URL
(no redirect). The page still names the shop from the key. This is a clean gone
signal for availability checks.

### Building page (`/{pref}/bld-{id}/`)
- Current vacancies in the building (one row per ad) with key, rent, fees,
  layout, area; plus nearby buildings' vacancies.
- 基本情報: 築年, 建物種別/構造, 階建, 住所, 交通, 駐車場, 建物設備.
- Rent context: city average, town average, cheapest and dearest town.

### Rent-market pages (`…/rent/`)
JavaScript-rendered tables, updated daily (「2026年10月04日更新」). Average rent of
ads built in the last 20 years, excluding fees, from current CHINTAI ads.
- `/rent/{pref}/`: per city (草加市 7.65万円, 川口市 8.65万円 on 2026-10-04).
- `/{pref}/area/{city}/rent/`: per town (草加市: 34 towns, 北谷 5.80 → 八幡町 10.90万円).
- `/{pref}/ensen/{line}/rent/`: per station.
- Each narrows by layout or type: `/rent/2ldk/`, `/rent/kodate/`.
- `/rent/{pref}/ensen/` gives ad counts per line (東武スカイツリーライン 37,596).

### Archive (`/archive/{pref}/area/{city}/`)
Every building CHINTAI has ever listed in the city (草加市: 10,926, 547 pages of
20), each with address, stations, type, structure, built date, a 掲載物件有
flag when it has a current ad, and a link to `/{pref}/bld-{id}/`.

## 5. Baseline for our area (2026-10-04)

| City | Code | Ads | List pages | Towns | Notes |
| --- | --- | --- | --- | --- | --- |
| 草加市 | 11221 | 2,430 | 34 | 38 | 2LDK alone: 267 ads, 4 pages; kodate: 55 ads |
| 越谷市 | 11222 | 2,704 | 28 | 57 | |
| 川口市 | 11203 | 9,776 | 80 | 101 | |

Line and station codes for these cities are in `CHINTAI_LINES` and
`CHINTAI_STATIONS`.

## 6. Statistics this source can feed

- **Market rent by town, station, layout and type**, daily, from the rent pages
  (a few pages per city per day). Store each day's table as an observation.
- **Supply counts** per city, town (from the `(N件)` links), station and line.
- **Time on market**: list pages give each ad's `publishEndDt`, detail pages
  give 情報更新日 and 広告更新予定日, and the 404 marks the end. With daily
  sightings this gives listed → gone durations per unit.
- **Agent overlap**: how many agents advertise the same unit (Able store keys
  share the unit; 「他N店舗で取扱い」 counts the rest).
- **Building history** from the archive: buildings that come back to market,
  and how often.
- **Fees**: every その他初期費用 line in yen, 更新料, guarantor terms, so move-in
  cost can be computed rather than estimated.

## 7. Extraction plan

Rules carried over from this repo: headed browser only (`createBrowserFetch` /
`createBridge`), never curl or fetch; each property is an additive document that
keeps every observation and conflict; capture every field a page shows.

1. **Discovery (lists).** For each target city, load
   `/{pref}/area/{city}/list/{layout}/` for the family layouts
   (`CHINTAI_FAMILY_LAYOUT_SLUGS`) plus `kodate/`, paging with `page{n}/` until
   the last page. One filter per path, so this is one sweep per layout (草加
   2LDK = 4 pages). Parse cassettes, keep PR cassettes but key them by ad key so
   they merge. Record `totalCount` per sweep and stop paging when the page
   count from the pager is reached. Because the default order rotates, accept a
   sweep only when the unique ad count is close to `totalCount`; else re-sweep
   the city at town level (`/{town}/list/`, small pages).
2. **New-ad watch.** Daily, load the same paths' page 1–2 and stop after two
   pages with no unseen keys (the pattern the other collectors use). If
   newest-first order is needed, the site's own sort sends the browser to
   `/list/?…&o=7`, which robots.txt does not disallow by prefix but sits in the
   dynamic space it guards; ask before using it.
3. **Detail enrichment.** Load `/detail/bk-{key}/` (no query) for new keys and
   on 広告更新予定日; capture the full 物件概要 table, LAT/LNG, every 取扱い店舗,
   the building id, photos and nearby keys. Bounded per run like the SUUMO
   detail queue.
4. **Identity and dedup.** Ad key is the source row id. Group by `ableUnitKey`
   first, then by building id + floor + layout + area for `C` keys, then hand
   off to the existing cross-portal dedup (address + coordinates + layout +
   area + rent).
5. **Availability.** A 404 with 「掲載は、終了しました」 is gone for that ad; the
   unit is gone when every ad for it is gone. Building pages list the current
   vacancies, so one building load checks several units.
6. **Statistics jobs.** Daily rent pages per city (`/area/{city}/rent/` and its
   layout variants) and per station; weekly archive sweep of each city for
   building history.

Volume for the three cities (estimate): about 50–80 list pages per full family-layout
sweep (草加 2LDK alone is 4), plus details for new keys. At 8–14 s per page that is
roughly 10–20 minutes of browsing for lists.

## 8. Open points

- Whether the dynamic `/list/?…` URLs (newest-first, 100 per page, combined
  filters) may be used; static paths cover everything we need without them.
- 川口市 is large (9,776 ads); restrict to the eastern towns the README cares
  about, using `CHINTAI_TOWNS`.
- `keiyakuKbn` values other than 0 and the meaning of `newFlg` vs
  `newTodayFlg` need a few more samples.
- Rent pages render by JavaScript; read them after load in the browser, as
  the other collectors do.
