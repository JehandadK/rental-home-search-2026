# Here UR (hereur.eunjay.com) site map

Mapped on **2026-10-09** in a headed Playwright browser, one tab, 8–14 s between
pages. 28 page loads (robots.txt, sitemap.xml, home, list pages 2 and 30, about,
privacy, complex directory, 2 prefecture directories, 1 area page plus a 404
check, 8 complex pages, 1 English complex page, 1 program page, 2 search pages,
and 3 repeat loads to read the embedded page JSON). Nothing was fetched with
curl or fetch.

## 1. Who runs it

- An independent, unofficial aggregator: 「UR都市機構とは独立して運営されている
  非公式サイト」 (about page). The operator is not named anywhere; the domain is
  `eunjay.com` and Korean strings leak into the Japanese data
  (`regionName: "홋카이도·도호쿠"`), so it is likely a Korean developer. Unverified.
- Purpose: every current UR vacancy in Japan **sorted by monthly total**
  (家賃 + 共益費), for foreigners as well as Japanese users.
- 7 languages: `ja`, `ko`, `en`, `zh`, `zh-Hant`, `vi`, `fr` (path prefix).
  Proper nouns (団地名, 住所, 駅名) stay in Japanese in every language.
- Free, no login, no forms, no notification feature. Google Analytics,
  Cloudflare Web Analytics; the privacy page mentions AdSense and affiliate
  links. Built with Vike (vite-plugin-ssr), server-rendered, behind Cloudflare.
- Coverage: 6 regions, **20 prefectures** (all UR prefectures: 北海道, 宮城,
  東京, 神奈川, 千葉, 埼玉, 茨城, 愛知, 三重, 岐阜, 大阪, 兵庫, 京都, 滋賀, 奈良,
  和歌山, 岡山, 広島, 山口, 福岡), **1,375 complexes**, **2,968 vacancies** in 446
  complexes at the 2026-10-09 01:08 UTC snapshot. 埼玉県: 118 complexes, 30 with
  vacancies, 96 vacancies. 東京都: 308 complexes, 65 vacancies.

## 2. robots.txt and sitemap

```
User-agent: *
Allow: /
Sitemap: https://hereur.eunjay.com/sitemap.xml
```

`/sitemap.xml` is one urlset of **10,262 URLs** with `<lastmod>` and
`xhtml:link hreflang` alternates (71,826 of them). Per language ~1,466 URLs:

```
/{lang}/complexes/{region}-{pref}-{code}/   1,375  complex pages   (lastmod 2026-10-08T16:40Z for all)
/{lang}/page/{n}/                              29  list pages 2–30
/{lang}/programs/{slug}/                       37  UR system guides (u35-discount, free-rent, …)
/{lang}/complexes/prefectures/{pref}/          20  prefecture directories
/{lang}/areas/{tokyo|osaka|kanagawa}/           3  area pages
/{lang}/, /{lang}/about/, /{lang}/privacy/, /{lang}/complexes/
```

There are no room URLs: a room is shown only as a card and links out to UR.

## 3. URL hierarchy

```
/{lang}/                                  all vacancies, cheapest first, 100 per page   (2,968 → 30 pages)
├ /{lang}/page/{n}/                       n = 2…30
├ /{lang}/?q={text}                       search box (団地名・住所・号棟・部屋番号); embedded JSON stays unfiltered
├ /{lang}/areas/{pref}/                   only tokyo, osaka, kanagawa (saitama → 404): stats + cheapest rooms
├ /{lang}/complexes/                      directory: per region/pref complex and vacancy counts
│ ├ /{lang}/complexes/prefectures/{pref}/ all complexes of a pref, cheapest first, with 空室N件 and 最安月額負担
│ └ /{lang}/complexes/{region}-{pref}-{code}/   complex profile
├ /{lang}/programs/{slug}/                guides to UR discounts and systems
└ /{lang}/about/ (#sources, #data-guide), /{lang}/privacy/
```

`region` and `pref` are UR's own path slugs (`kanto-saitama`, `hokkaitohoku-hokkaido`,
`tokai-aichi`, `kyushu-fukuoka`). Three codes end in a letter
(`kyushu-fukuoka-90_070a` アーベイン室住, `90_079a`, `90_114a`).

Our area, all on `/ja/complexes/prefectures/saitama/` and `/tokyo/`:

| City | Complexes (code) | Vacancies 2026-10-09 |
| --- | --- | --- |
| 草加市 | `50_1340` 草加旭町, `50_2610` グリーンアベニュー谷塚, `50_3880` ハーモネスタワー松原, `50_3910` コンフォール草加, `50_4090` コンフォール松原 | コンフォール松原 2 (from ¥96,400) |
| 越谷市 | `50_2070`, `50_2180` せんげん台パークタウン四/三番街, `50_2300` ペアハイツ越谷 | 0 |
| 川口市 | 16, incl. `50_1820` 川口芝園, `50_4020` コンフォール東鳩ヶ谷, `50_2220` アーバンハイツ南前川, `50_2890` リプレ川口二番街, `50_1280` 北園 | 東鳩ヶ谷 2, 南前川 2, リプレ川口二番街 1 |
| 八潮市 | `50_1390` 八潮 | 0 |
| 葛飾区 | 20, same codes as ラク賃 (`20_1650` 金町駅前 … `20_6680` 青戸第二) | 0 |

## 4. Identifiers

| Thing | Format | Example | Notes |
| --- | --- | --- | --- |
| Complex | `{region}-{pref}-{UR code}` | `kanto-saitama-50_3910` | UR code unchanged; no duplicate codes across the 1,375. `officialUrl` = `www.ur-net.go.jp/chintai/kanto/saitama/50_3910.html`. |
| Room | `key` = `{shisya}-{danchi}-{shikibetu}-{JKSS}` | `20-172-0-000001307` | Splits UR's code: `20_1720` = shisya 20 + danchi 172 + shikibetu 0. JKSS is UR's 9-char room id. |
| Room link | UR room URL | `www.ur-net.go.jp/chintai/hokkaitohoku/hokkaido/20_1720_room.html?JKSS=000001307` | In page JSON and JSON-LD `ItemList`. |
| Station | own hashed ids + `stationGroupCode` | `station_8b69d8…`, group `003040` (草加) | From 国土数値情報 N02-2025. |

The JKSS values match ラク賃不動産's room `id` (羽村 12号棟504号室 = `000120504`
on both), so the two sites join to each other and to UR on danchi code + JKSS.

## 5. Page anatomy

All pages are server-rendered HTML plus an embedded
`<script id="vike_pageContext" type="application/json">` holding the page data.
No XHR or fetch for data was seen on any page.

### List page (`/ja/`, `/ja/page/{n}/`)
- `vike_pageContext.data`: `page`, `pageSize` 100, `totalPages` 30, `totalRooms`
  2968, `contentVersion`, `tenantLifestyleSignals` (UR danchi URL → `medical`,
  `childcare`, …), and `snapshot` with freshness fields and `rooms[]`.
- Room object (all 100 have every field except `programs`/`designs`/`normalRentYen`):
  `{"key":"20-172-0-000001307","prefectureCode":"01","prefectureSlug":"hokkaido",
  "complexName":"大麻園町","complexNameReading":"おおあさそのまち",
  "address":"江別市大麻園町23番・34番","access":["JR函館本線「大麻」駅 徒歩16～23分…"],
  "building":"1号棟","roomNumber":"307号室","rentYen":29300,"normalRentYen":null,
  "rentSource":"listed","commonFeeYen":2600,"totalMonthlyYen":31900,"layout":"2DK",
  "areaM2":40,"floorLabel":"3階","programs":["U35割（3年定借）"],"designs":["リノベーション住宅"],
  "floorplanUrl":"https://chintai.r6.ur-net.go.jp/…_s.gif","urUrl":"…_room.html?JKSS=…"}`
- `snapshot`: `generatedAt` / `publishedAt` 2026-10-09T01:08:59Z, `attemptedAt`,
  `sourceFreshness` (`oldestFetchedAt`, `newestFetchedAt`, fresh/stale counts per
  prefecture and room), `stale`, `partial`, and `prefectures[]` with each
  prefecture's `fetchedAt`.
- JSON-LD `CollectionPage` + `ItemList` of the 100 rooms with UR room URLs.
- Cards show prefecture, complex, 号棟·号室, layout, m², floor, 共益費, 月額合計,
  and tenant badges (食品スーパー, 医療機関, 保育・子育て支援). Cards have no links.

### Search (`/ja/?q=コンフォール松原`)
Filters (pref, rent slider to ¥300,000, area, layout up to 6LDK, programs) and
a `q` box. The rendered result list is right (2 rooms), but the embedded JSON is
still the unfiltered page 1, and no data request was seen, so where the
filtered rows come from is unverified (maybe a bundled data chunk). Take data
from the list pages, not from `?q=`. Other filter query parameters: unverified.

### Complex page (`/ja/complexes/kanto-saitama-50_4090/`)
Visible: 概要 (postal code, address, access with bus/walk ranges, 募集家賃（共益費）
range, 構造, 公式間取り表記, 管理年数, 階数, 間取りタイプ数, 総戸数), a link to UR's
住棟別徒歩時間 PDF (`/chintai/pdf/traffic/50_4090_traffic.pdf`), Street View and
Google Maps links, キャンペーン (programs on current vacancies), **駐車場** (free
spaces, fee range, month), 空室の向き・暮らし情報, climate normals (JMA), 鉄道アクセス.
The current rooms are not listed here; 「現在の空室を見る」 links to `/ja/?q={name}`.

`vike_pageContext.data` (kind `complex-profile`):
`complexId`, `name`, `nameReading`, `officialUrl`, `checkedAt`, `postalCode`,
`vacancyCount`, `minimumTotalMonthlyYen`, `observedTypeCount`, `trafficPdfUrl`,
`currentVacancyFacts` (`programmes`, `designs`), `parking`
(`availableSpaces` 33, `taxIncludedMinimumYen` 10340, `…MaximumYen` 11770,
`effectiveMonth` 2026-11, `observedAt`, `officialSourceUrl`
`sumai.r6.ur-net.go.jp/chintai/s/danchi/1050391.html`), `lifestyle`
(`directions: ["s"]`, facts like `bath-toilet-separate`, `park-onsite`), `climate`,
`access.entries[]` (route, station, walk/bus min–max), `rail.matches[]`
(operator, line, station id, **`straightLineDistanceM`** 511), and `detail`
(`address`, `managementYears`, `structure`, `totalUnits`, `layoutRange`,
**`latitude` 35.8293, `longitude` 139.8090**, photos, `officialFacts` = UR's table
verbatim, `fetchedAt`, `highestFloor`). JSON-LD `ApartmentComplex` repeats
address, postal code, geo, `sameAs` UR URL.

### Directory pages
`/ja/complexes/` gives per-prefecture complex and vacancy counts.
`/ja/complexes/prefectures/saitama/` lists 118 complexes numbered 0001–0118,
cheapest first: name, 〒, address, 空室N件 or 現在募集なし, 最安月額負担, 管理年数,
総戸数 (often "—"), tenant badges.

## 6. Information inventory

| Item | Present | Where |
| --- | --- | --- |
| Current vacancies, rent, 共益費, monthly total, layout, m², floor, 号棟/号室 | yes | list pages JSON |
| Discount programs per room (定借 terms in the label) | yes | `programs`, `designs` |
| Floor plans | yes (UR small gif) | `floorplanUrl` |
| Photos | yes (UR) | complex `detail.photos` |
| Coordinates | **yes** | complex `detail.latitude/longitude`, JSON-LD geo |
| Stations, walk/bus, straight-line distance | yes | complex `access`, `rail` |
| Postal code | yes (Japan Post match, only when unique) | complex |
| Building age | 管理年数 only | complex |
| Parking availability and fee | yes | complex `parking` |
| Tenant shops (UR tenant list) | yes, as badges | `tenantLifestyleSignals` |
| Climate | yes (JMA normals) | complex |
| Vacancy history, 成約, days on market, rent history | **no** | – |
| Reviews, waiting list, notifications | no | – |
| Freshness | yes, detailed | `snapshot.*At`, `checkedAt`, page footer 「データ確認日時」 |

Update time seen: snapshot 2026-10-09 01:08 UTC (10:08 JST), about 3.5 h before
the pages were loaded; complex building data `checkedAt` 2026-10-08 16:20 UTC;
sitemap lastmod 2026-10-08 16:40 UTC. The about page shows the same time as
"1:08" (UTC printed as local). The cadence is not stated beyond 「定期的に自動取得」;
probably several times a day (unverified). The about page also showed
「更新状況を確認できません」 for its live status box.

## 7. Stated sources (`/ja/about/#sources`)

UR賃貸住宅 (vacancies, rents), UR全国物件一覧 (complex data, photos, floor plans,
traffic), UR駐車場 (`sumai.r6.ur-net.go.jp/chintai/prk/`), URテナント (shops),
日本郵便 郵便番号データ, 国土数値情報 N02-2025 (CC BY 4.0, station positions),
駅データ.jp and Wikidata (station readings), 気象庁 1991–2020 平年値, and ~40 UR
guide pages for the `programs` articles.

## 8. Unique vs copied

Everything room-level is a copy of UR's current vacancies. Added value: one
national list sorted by monthly total, coordinates and straight-line station
distance, postal codes, parking availability, tenant badges, climate, readings,
7 languages. No history at all: a room that leaves UR leaves Here UR.

## 9. Collector notes

- **Best path for current vacancies**: the 30 list pages (`/ja/` and
  `/ja/page/2/`…`/ja/page/30/`), reading `vike_pageContext`. 30 loads give all
  2,968 rooms with UR keys; filter by `prefectureSlug` and address. Page 1 JSON
  was decoded; pages 2 and 30 carry the same JSON-LD `ItemList` (100 and 68
  rooms, so 29 × 100 + 68 = 2,968); their embedded JSON is assumed the same
  (unverified). Sort order is by price, so a room can shift
  pages between snapshots; dedupe on `key`.
- **Best path for complex facts** (coordinates, parking, postal code): one load
  per complex page, ~46 for our area. Building facts change rarely.
- Use `snapshot.stale`, `partial` and `sourceFreshness` to skip a bad snapshot.
- Cross-check: at 13:40–14:00 JST both Here UR and ラク賃 showed the same two
  コンフォール松原 rooms (7号棟106 ¥92,900 and 1号棟701 ¥108,400 + ¥3,500).
- Terms: no 利用規約 page; the site says it is 「公式URサービスではありません」 and
  tells users to confirm on UR. robots allows everything.

## 10. Checked log

2026-10-09: 28 page loads on hereur.eunjay.com. Decoded page JSON for `/ja/`,
`/ja/?q=コンフォール松原`, `kanto-saitama-50_3910` and `kanto-saitama-50_4090`.
Unverified: operator identity, refresh cadence, filter URL parameters, the
letter-suffix codes' meaning (shikibetu `a`?).
