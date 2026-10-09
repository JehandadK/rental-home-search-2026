# ラク賃不動産 (www.ur-s.jp) site map

Mapped on **2026-10-09** in a headed Playwright browser, one tab, 8–14 s between
pages. 28 ur-s.jp page loads (robots.txt, home, sitemap.xml, sitemap-html, 3
region hubs, 2 prefecture hubs, 9 danchi pages, 1 口コミ page, 3 service pages,
company, column, 関東申込みルール), 3 of them a second time to read the
Next.js flight data, plus 1 UR official page to check the code mapping. Nothing
was fetched with curl or fetch.

## 1. Who runs it

- **Operator**: 株式会社GEEZ, 大阪市北区西天満, 宅建業免許 大阪府知事(2)第62068号,
  founded 2020, 10 staff (`/company/`). A **broker**, not UR: its business is
  "UR賃貸住宅の仮申込み代行・空室情報サイト運営". Brokerage fee is free (UR pays
  agents for introductions).
- **What it is**: a UR vacancy mirror plus its own history database. It scrapes
  UR vacancies, keeps every vacancy it has seen since **2026-04-09** (Kansai) /
  about **2026-05-29** (Kanto, the earliest `listed_from` on the Kanto pages
  checked), and shows a 成約 (contract) history per room. It also has resident
  口コミ, rankings, a waiting-list e-mail service and LINE 仮申込み.
- Japanese only. Free. No login needed to read anything; forms (仮申込み,
  空き待ち, 口コミ投稿) need an e-mail and are not submitted here.
- Coverage (sitemap and hubs, 2026-10-09):

  | Region path | Danchi | Vacancies shown on the hub | Prefectures |
  | --- | --- | --- | --- |
  | `/kansai/` | 367 | 1,574 (home says 2,519) | osaka 199, hyogo 103, kyoto 41, nara 21, shiga 2, wakayama 1 |
  | `/kanto/` | 697 | 251 | tokyo 305, kanagawa 165, saitama 117, chiba 110 |
  | `/chubu/` | 51 | 523 | aichi 50, gifu 1 |
  | 中国・四国・九州・北海道・東北 | 0 | – | "準備中" on the home page |

  1,115 danchi in total. Every code also exists on Here UR (1,375 danchi), so
  ur-s is a subset of UR's catalogue. Missing against Here UR: ibaraki,
  hokkaido, miyagi, mie, okayama, hiroshima, yamaguchi, fukuoka, half of aichi,
  and a few newer danchi (e.g. `50_4130` コンフォール西浦和田島, 13 new 千葉
  `30_60xx` codes).
- The home title still says 【関西367団地】; the site started in Kansai and
  added Kanto and Chubu later. LINE 空き待ち is Osaka/Hyogo/Kyoto only; other
  areas get e-mail.

## 2. robots.txt and sitemap

```
User-Agent: *
Allow: /
Disallow: /api/
Disallow: /_next/
Sitemap: https://www.ur-s.jp/sitemap.xml
```

`/sitemap.xml` is a single urlset (no index) of **2,265 URLs**:
1,115 danchi pages + 1,115 `…/kuchikomi/` pages + 13 prefecture hubs + 3 region
hubs + 9 columns + service pages. Every URL has `<lastmod>`; 898 danchi URLs
share `2026-05-29T08:54` (the Kanto launch), the rest are recent
(420 on 2026-10-09, 226 on 2026-10-08), so lastmod tracks data changes.
`/sitemap-html/` is a human list of the same danchi by prefecture.

`/api/` holds only `POST /api/pv` (page-view counter). The data comes from the
page itself, so nothing disallowed is needed.

## 3. URL hierarchy

```
/                                     home: 昨日の動き, 新着の空室, 直近の成約事例, 新着の口コミ, 団地ランキング
├ /kansai/ /kanto/ /chubu/            region hub: per-pref counts + client-side filter (rent, layout, area, 募集中のみ), top 60 danchi
│ └ /{region}/{pref}/                 prefecture hub: every danchi grouped by 市区町村 with station, walk, vacancies, rent range
│   └ /{region}/{pref}/{danchi}/      danchi page (main data page)            danchi = UR code, e.g. 50_1390
│     └ /{region}/{pref}/{danchi}/kuchikomi/   reviews + review form
├ /akimachi/[?danchi={code}]          空き待ち e-mail registration (form)
├ /moushikomi/[?danchi={name}&region=kanto]   仮申込み form
├ /kanto/moushikomi/                  Kanto rules + list of 230 紹介対象外 danchi
├ /service/{akimachi|line-naiken|web-moushikomi|seido}/   service explanations
├ /column/ and /column/{slug}/        9 articles
├ /company/  /sitemap-html/
```

Pages answer on both `/x/` and `/x` (canonical has the trailing slash).
The home page links Kanto danchi under `/kansai/tokyo/…` (a bug); the canonical
path is `/kanto/tokyo/…`.

Our area (all from `/kanto/saitama/` and `/kanto/tokyo/`):

| City | Danchi pages (code, name) |
| --- | --- |
| 草加市 (5) | `50_1340` 草加旭町, `50_2610` グリーンアベニュー谷塚, `50_3880` ハーモネスタワー松原, `50_3910` コンフォール草加, `50_4090` コンフォール松原 |
| 越谷市 (3) | `50_2070` せんげん台パークタウン四番街, `50_2180` 同三番街, `50_2300` ペアハイツ越谷 |
| 川口市 (16) | `50_1380` 川口芝, `50_1470` 川口栄町第二, `50_1490` 川口前川町, `50_1820` 川口芝園, `50_2220` アーバンハイツ南前川, `50_2280` エルハイツ末広, `50_2350` パークハイツ中青木, `50_2580` 飯塚四丁目ハイツ, `50_2890` リプレ川口二番街, `50_3040` アーバンハイツ飯塚三丁目, `50_3890` コンフォール川口飯塚, `50_3980` リバピア川口青木, `50_4020` コンフォール東鳩ヶ谷, `50_4040` シティコート川口, `50_4070` コンフォール西鳩ヶ谷, `50_1280` 北園 |
| 八潮市 (1) | `50_1390` 八潮 |
| 葛飾区 (20) | `20_1650` 金町駅前, `20_2640`/`20_2850` 東四ツ木二丁目(第二), `20_2860`/`20_2960`/`20_3190`/`20_4911`/`20_6680` 青戸第三/四/五/一/二, `20_2950` 金町第二, `20_3070` 金町五丁目, `20_6400` 金町第一, `20_3350` 西新小岩リバーハイツ, `20_3420` エステート東新小岩, `20_3720` エステート堀切, `20_3730` エステート東堀切, `20_3930`/`20_3940` メゾン堀切七/八丁目, `20_4481` すまいる亀有, `20_5020` アーバンライフ東新小岩, `20_5840` アクシス東四つ木 |

越谷レイクタウン has no UR danchi on the site (none in UR's 越谷市 list either).

## 4. Identifiers

| Thing | Format | Example | Notes |
| --- | --- | --- | --- |
| Region / pref | slug | `kanto` / `saitama` | Same slugs as UR's own paths (`/chintai/kanto/saitama/`). |
| Danchi | UR code `{shisya}_{danchi}{shikibetu}` | `50_1390` | **Verified identical to UR**: `www.ur-net.go.jp/chintai/kanto/saitama/50_1390.html` is 八潮, 941戸, 八潮市大字八條1567, same as ur-s. Field `danchi_ur_code` in the data. |
| Room (current vacancy) | `id` = UR **JKSS** (9 chars) | `000120504` = 羽村 12号棟504号室 | Same value Here UR uses in `…/20_2270_room.html?JKSS=000120504`. Not derivable from the display name (羽村 12号棟 → `00012`+`0504`, but 1号棟307 elsewhere → `000001307`), so always take it from the data. |
| Room (history row) | `jkss` + row `id` (UUID) | `000060505`, `0616e571-…` | One UUID per disappearance event, not per room. |
| Images | UR's own URLs | `chintai.r6.ur-net.go.jp/chintai/img_madori/20/20_227/20_227_0-00-0012_3A_RA_01_00007.gif` | Floor plans and photos are hot-linked from UR. |

So ur-s joins to UR and to Here UR on danchi code and JKSS directly.

## 5. Page anatomy

### Prefecture hub (`/kanto/saitama/`)
Server-rendered. Title carries counts: 「埼玉のUR賃貸一覧（117団地・空室64室）」.
`h2` per 市区町村 「草加市5団地・空室1室」, then per danchi: name, 募集中/満室,
nearest station + walk, 空室N件, rent range. **The hub can lag the danchi page**:
at 13:40 JST the hub said コンフォール草加 空室1件 and コンフォール松原 満室,
while the danchi pages said 0 and 2.

### Danchi page (`/kanto/saitama/50_4090/`)
Next.js App Router (Turbopack), server-rendered HTML. No `__NEXT_DATA__`; the
data is in the React flight stream (`self.__next_f.push([1,"…"])` script tags in
the HTML). Decoding those strings gives clean JSON props:

- `rooms[]` (current vacancies):
  `{"id":"000070106","madori":"1DK","rent":92900,"common_fee":3500,"area_sqm":43,
  "floor_num":1,"building_num":7,"room_num":"106","direction":"","available_date":"",
  "is_renovated":false,"reno_plan":"","is_new":false,"first_seen_at":"",
  "madori_image_url":"https://chintai.r6.ur-net.go.jp/…_00005.gif",
  "systems":["近居割","近居割WIDE"],"no_agency_biko":true}`
  (`no_agency_biko` true = "この団地はUR営業センターで直接お申込みください").
- `pastListings[]` (the 成約 table, all rows, not only the 8 shown before
  「残り33件も見る」): `{"danchi_ur_code":"20_2270","jkss":"000060505",
  "room_name":"6号棟505号室","rent":57900,"common_fee":3500,"floor_plan":"3DK",
  "floor_space":52,"floor":"5階","building_floors":"5階","is_renovation":false,
  "listed_from":"2026-08-29T03:15:17Z","listed_until":"2026-10-08T06:00:26Z",
  "listing_days":40,"systems":null}`.
- `photos[]` (`url`, `thumbnail_url`, `alt`, `is_video`, `is_panorama`, `is_vr`,
  `is_layout_map`), `totalUnits`, `currentVacancy`, a floor × building grid.
- JSON-LD: BreadcrumbList, RealEstateListing (address, Offer per vacancy with
  price), ApartmentComplex (`numberOfRooms` = 総戸数, `geo` holds only a station
  name, **no coordinates**), FAQPage.

Visible sections (h2): 空室一覧 (間取り図, 間取り, 号棟・号室, 賃料, 共益費, 面積,
階数, a remark), 家賃・面積データ（号棟別）, **空室データ分析** (成約件数, 平均家賃,
家賃幅, 平均募集日数, per-layout count and average, the 成約済みの部屋一覧 table:
号室, 間取り, 家賃, 面積, 成約日, 募集日数), 初期費用シミュレーション (calculator),
入居資格 (rent × 4 / ×100 savings), 基本情報・設備 (所在地, 交通 with bus, 総戸数,
構造, 管理年数, 設備 list, 特徴, 敷地内駐車場 with free spaces and fee),
周辺環境 (generated text with place names), 近隣団地の比較 table, 管理事務所
(UR営業センター name, address, phone), 近くのUR団地, 口コミ.

Sample values, 2026-10-09:

| Danchi | Now | 成約件数 | 平均家賃 | 平均募集日数 |
| --- | --- | --- | --- | --- |
| `50_4090` コンフォール松原 | 2 (7-106 1DK 92,900; 1-701 2DK 108,400) | 66 | 100,459 | 11日 |
| `50_3910` コンフォール草加 | 0 | 28 | 130,721 | 11日 |
| `50_3880` ハーモネスタワー松原 | 0 | 14 | 146,586 | 2日 |
| `50_2070` せんげん台PT四番街 | 0 | 43 | 97,058 | 20日 |
| `50_1820` 川口芝園 | 0 | 99 | 97,697 | 10日 |
| `50_1390` 八潮 | 0 | 15 | 49,127 | 9日 |
| `20_6400` 金町第一 | 0 | 23 | 136,683 | 8日 |

### 口コミ page (`…/kuchikomi/`)
Overall score and 7 category scores (建物, 管理, 周辺環境, 静音性, コスパ, 子育て,
バリアフリー), reviewer nickname, date, 居住状況 (現在/退去済み/見学), 世帯,
年代, 居住年数, free text (良い点, 気になる点, おすすめ, 退去理由) and tags. A
GET form to post. Reviews are sparse: 羽村 has 1, most of our area has 0.

### Home page
「昨日の動き」 (新規空室 25, 成約 215, 増減 −190 on 2026-10-09), a 7/30/365-day
chart, 新着の空室 and 直近の成約事例 with relative times ("今", "15分前"), and three
rankings: 口コミ評価順, 30-day PV (e.g. 千里グリーンヒルズ竹見台 239 PV), and
即決 (shortest average 募集日数).

## 6. Information inventory

| Item | Present | Where |
| --- | --- | --- |
| Current vacancies, rent, 共益費, layout, m², floor, 号棟/号室 | yes | danchi page `rooms[]` |
| Floor plans, photos | yes (UR's images) | `madori_image_url`, `photos[]` |
| Coordinates | **no** | – |
| Stations, walk/bus minutes | yes (text) | 基本情報 |
| Building age | 管理年数 only ("53年～54年") | header, 基本情報 |
| Vacancy appear/disappear history | **yes, unique** | `pastListings[].listed_from / listed_until` |
| 成約 history, days on market | **yes, unique** | same; 成約日 = the day the vacancy disappeared from UR (page footnote) |
| Rent history | implicit: the same `jkss` can carry different rents (羽村 000120504: 56,100 then 57,900) | `pastListings` |
| Statistics / rankings | yes | 空室データ分析, home rankings |
| 口コミ | yes, few | `/kuchikomi/` |
| Waiting list / notification | e-mail 空き待ち (`/akimachi/`), LINE for Osaka/Hyogo/Kyoto | forms, not used |
| Parking | free spaces and fee ("前日以前の状況") | 基本情報 |
| Update cadence | "毎日5回更新" (Kansai, home); "毎日更新" on Kanto pages; new vacancies shown minutes old | home, danchi |
| Freshness timestamp on page | none per danchi; sitemap `lastmod` per danchi | sitemap |

## 7. Unique vs copied

Copied from UR: room list, rent, floor plans, photos, 設備, address, traffic,
parking, office. Unique: the history (`pastListings` with first-seen and
last-seen timestamps per JKSS, since April/May 2026), derived stats, rankings,
PV counts, reviews, the 紹介対象外 list.

**The 成約 history is not a contract history.** A row is written each time a
vacancy disappears from UR. When the same room comes back it keeps its original
`listed_from` and gets a new row on the next disappearance. 羽村 6号棟505号室 has
5 rows (all `listed_from` 2026-08-29, `listed_until` 09-04 … 10-08), コンフォール松原
7号棟106 has 8, and a room can be in `rooms[]` (vacant now) and in
`pastListings` at once. So 成約件数 and 平均募集日数 are inflated by flapping;
the real event is the last disappearance per `jkss` + `listed_from`. "—" in 募集日数
means `listing_days` 0.

## 8. Collector notes

- **Best path**: one GET per danchi page, parse the flight strings
  (`self.__next_f.push([1,"…"])`, JSON-string-decode, then find `"rooms":[` and
  `"pastListings":[`). 45 pages cover our area (25 Saitama + 20 葛飾). The sitemap
  `lastmod` tells which danchi changed, so a daily pass can load only those.
- Join to UR and Here UR on `danchi_ur_code` and `jkss`.
- Collapse `pastListings` per (`jkss`, `listed_from`), keep the max
  `listed_until`; treat that as "left the market", not as a contract.
- Kanto history starts about 2026-05-29, so no older data exists.
- Do not trust hub counts or JSON-LD FAQ text: the 羽村 FAQ said 空室3件 and
  平均5万6,033円 while the page showed 2 and 5万8,761円.
- Many of our danchi are 紹介対象外 for this broker (Saitama list of 42 includes
  コンフォール草加, コンフォール松原, ハーモネスタワー松原, 川口芝園, ペアハイツ越谷,
  東鳩ヶ谷, 西鳩ヶ谷…; Tokyo includes 金町駅前). Their pages and history are still
  published; only 仮申込み through ur-s is not possible.
- 「子育て割」「健康寿命サポート住宅」 rooms cannot be applied for through ur-s.
- Terms: no 利用規約 or privacy page is linked from the home page, footer,
  `/company/` or `/sitemap-html/`. robots allows everything except `/api/` and
  `/_next/`.

## 9. Checked log

2026-10-09: 28 page loads on www.ur-s.jp (including 3 repeat loads for flight
data) and 1 on www.ur-net.go.jp. Flight data decoded for 20_2270 (2 rooms, 41
history rows), 50_3910 (0, 28), 50_4090 (2, 66). Unverified: the Chubu and
Kansai flight data shape (assumed the same component), the review JSON shape,
`first_seen_at` (empty on all rooms seen).
