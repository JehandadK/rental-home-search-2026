# Other UR rental data sites: brokers, portals, notifiers, open data

Mapped on **2026-10-09** in headed Playwright Chromium (the scratch `map-pages.mts` mapper: one tab per run, 8–14 s between pages). Nothing was fetched with curl, wget or fetch. **58 pages were loaded in this round.** The round-1 snapshots of the urjkkplus-ws.com and k-royal.jp home pages and the urjkkplus robots.txt were reused. Discovery used about 20 WebSearch queries. Anything taken only from a search-result snippet, and not seen in the browser, is marked *(search snippet, unverified)*.

The sites already covered by their own docs are out of scope here: ur-net.go.jp, uralert.jp, ur-tsuchikun.jp, ur-aki.jp, kuushitsu-info.jp, ur-s.jp and hereur.

## 0. Summary

| Site | What it is | Our area (草加/越谷/川口/葛飾) | Exposes UR codes? | Worth collecting? |
| --- | --- | --- | --- | --- |
| **urjkkplus-ws.com** and four sister sites (Whitestone Co.) | UR あっせん broker. Server-rendered building and room pages | 草加 3, 越谷 3, 川口 3 buildings. **No 葛飾区** | **Yes.** Building titles carry `UR:50_2100`, and ur-whitestone.com puts `50_3880` in the URL | Low–medium. A per-building **"ご成約済" room table** is the only unusual data |
| k-royal.jp | Kanagawa public-housing broker (Royal Housing) | None (Kanagawa only) | No (own `cd_`/`rd_` IDs) | No |
| SUUMO UR special page | Static promo page that links out to ur-net.go.jp | n/a | No | No. UR ads already reach us as ordinary SUUMO ads |
| LIFULL HOME'S UR tag 5414 | Tag list of UR's own ads (advertiser is UR賃貸ショップ) | The Saitama URL exists, but loading it hit Human Verification | No | Only if we add a HOME'S collector |
| **ur.penpen-dev.com** (UR空き部屋チェッカー) | Independent notifier with a public list of every current vacancy | Nationwide list (2,968 rooms) | **Yes.** Each row links the UR room URL with `JKSS` | Medium, as a cross-check |
| swimple.net/rent (swimple rent) | Independent notifier, 6 languages | Lists UR 1,371 properties; 埼玉県 118 | No (own numeric IDs) | No |
| citymobile.co.jp | UR/JKK broker with a "過去に募集した部屋" list | ハーモネスタワー松原 has 76 past rooms | No (own IDs) | No. The data is stale (2021–2024) |
| qac.co.jp/ur/saitama/ | Broker cashback page that lists Saitama danchi | 草加 5, 越谷 3, 八潮 1, … | Anchor IDs are JIS city codes | No |
| jipili/ur-watch1 (GitHub) | Open-source watcher; ships a UR code table | Tokyo includes 17 葛飾 danchi codes; no Saitama | **Yes** (shisya/danchi/shikibetu) | Useful as a **code table**, and its git history holds vacancy history |

Two things stand out:

1. **Whitestone runs five near-identical sites** from one office (芝浦3-17-11 天翔田町ビル8F): urjkkplus-ws.com, urjkkplus-housing.com (English), ur-yoyaku.jp (URプライム賃貸), ur-whitestone.com (URコンシェルジュ, older engine) and ur-housing.com (English, older). They share one database, so one building has the same `/outline/{id}` on each sister site.
2. **No site in this set has dated contract or vacancy history for our area.** The nearest are Whitestone's undated "ご成約済" room tables and the git commit history of jipili/ur-watch1, which covers Tokyo and Kanagawa only.

---

## 1. UR/JKK コンシェルジュ — urjkkplus-ws.com and the Whitestone family

### 1.1 Who and what

- **Whitestone Co. Ltd.** (株式会社ホワイト・ストーン), Tokyo. The footer says "Copyright ©2014 Whitestone Co. Ltd.". It is a UR **宅建あっせん** broker that does 仮申込(予約)代行 for free and is paid by UR's あっせん fee. The terms page (`/company/policy/`) says this outright ("UR都市機構からの斡旋手数料で運営"). Every page carries a disclaimer that the site has no relation to UR and takes no fees.
- It covers UR, JKK東京, 元UR (sublease) and 一般 listings in Kanto, Chubu, Kansai and Fukuoka. Japanese, with an English mirror. Free, no login. Favourites and history are stored in cookies.
- The home page warns that listings are not live: "最新情報は直接お問い合わせください". A search snippet adds that the room lists do not show the latest vacancy state *(search snippet, unverified)*.

### 1.2 robots.txt and sitemaps

- `/robots.txt` returns the site's **404 page** (HTTP 404, with a 404 page title), so there are no robots rules.
- `/sitemap.xml` is also a **404**. No other sitemap was found.

### 1.3 URL hierarchy (urjkkplus-ws.com)

```
/                                         home: 24 featured buildings, news
├ /search/                                free word: GET /search/?FWD=…
├ /search/district/                       region picker
│ └ /search/district/{region}/            103 関東, 104 中部, 105 関西, 108 福岡
│   └ /search/district/103/{pref}/        11 埼玉, 13 東京 (canonical of /103/ is /103/13/)
│                                         (/search/district/PRF11/ redirects to /103/ = Tokyo)
├ /search/route/{region}/, /search/route/PRF11/       line pickers
├ /search/map/                            Leaflet map (d--searches--map.js); no XHR seen on load
├ /search/PRF{pref}/                      prefecture list, e.g. PRF11 = 埼玉県 (55 棟)
│   └ /search/PRF11/PG-created-asc-{page}-{perPage}/   paging + sort, e.g. PG-created-asc-2-10
├ /search/CTY{pref}{nnn}/                 city list. nnn is the SITE'S OWN ordinal, not JIS:
│                                         CTY11027 草加市, CTY11028 越谷市, CTY11013 川口市,
│                                         CTY11039 八潮市, CTY11041 三郷市, CTY13017 世田谷区
├ /search/TWN{CTY}{nnn}/                  town, e.g. TWN13002001 明石町
├ /search/RTS{line}/                      line, e.g. RTS9 西武新宿線, RTS38 東武東上線
│   └ /search/RTS{line}/STN{station}/     station on a line, e.g. RTS9/STN449 新所沢
├ /search/STN{station}/                   station list, e.g. STN406 鶴ヶ島駅
├ /outline/{buildingId}/                  building (danchi) page, e.g. /outline/505/
├ /bukken/{roomId}/                       room page, e.g. /bukken/2037321/
├ /contacts/2/{buildingId}/               reservation-request form (not submitted)
├ /imgs/normal/{imageId}/                 photos
└ /homes/favorite/, /homes/cache/         cookie favourites / history
```

Search filters are **path segments** that can be chained. Several `CTY…` segments can be stacked, for example `/search/CTY13002/CTY13009/…/RTT100000/`. Observed segments:

| Segment | Meaning (from the link context) |
| --- | --- |
| `CGY{n}` | 物件カテゴリ. `CGY2` = UR都市機構 (page title "東京都世田谷区、UR都市機構の賃貸物件一覧"). The other values (JKK東京, 元UR, 一般) were not checked |
| `WLK{n}` | 駅徒歩 n分以内 (`WLK5`) |
| `BLD{n}` | 築年数 n年以内 (`BLD10`) |
| `AFE{n}` | unknown (`AFE21`, linked from the Tokyo hub) |
| `RTT{n}` | unknown (`RTT100000`, possibly a rent bound) |
| `PG-{sort}-{asc}-{page}-{per}` | sort and paging |

### 1.4 Coverage for our area (2026-10-09)

The 埼玉 district page (`/search/district/103/11/`) lists per-city counts: 草加市 (3), 越谷市 (3), 川口市 (3), 八潮市 (1), 三郷市 (2), さいたま市北区 (5), and so on. The prefecture list (`/search/PRF11/`) shows **55 棟** across 6 pages.

`/search/CTY11027/` (草加市) listed only **1 棟**: グリーンアベニュー谷塚 (`/outline/488/`), 103,900–160,600円, 共益費 3,800円. That is fewer than the "(3)" on the hub. The hub counts probably include buildings outside the default list filter (unverified).

The Tokyo hub lists 32 wards and cities. **葛飾区 has no CTY entry at all**, while neighbouring 江戸川区 (18) and 江東区 (23) do.

ハーモネスタワー松原 still has a reachable room page, `/bukken/73656/`: 3LDK 77㎡, 8階, 137,000円, 共益費 5,400円, 総戸数 363, 管理 27年, 獨協大学前駅 徒歩1分. Its parking line reads "自走 空き台数：45台 料金：11,110円～12,650円". The building does not appear in the 草加 list.

### 1.5 Identifiers

- **Building:** the site's own sequential `outline/{id}` (e.g. 505 かわつるグリーンタウン新鶴, 488 グリーンアベニュー谷塚, 498 プラザシティ新所沢けやき通り). The **page title and h1 carry UR's code**: `かわつるグリーンタウン　新鶴｜UR:50_2100｜鶴ヶ島市南町`. Parse `UR:(\d+)_(\d{3})(\d)` to get shisya 50, danchi 210 and shikibetu 0, which joins directly to ur-net.go.jp `/chintai/kanto/saitama/50_2100.html`.
- **Room:** the site's own `bukken/{id}` (21393 … 2037321). There is no UR room id (JKSS), no 号棟/号室, and the room page has no date.
- The English mirror reuses the same ids: `urjkkplus-housing.com/outline/505/`, titled "Kawatsuru Green Town Shintsuru｜UR:50_2100".

### 1.6 Page anatomy

All pages are plain server-rendered HTML (jQuery, no JSON-LD, no `__NEXT_DATA__`, no data XHR). Only Google Analytics calls appear in the XHR list.

**List** (`/search/PRF11/…`): 10 building cards per page. Each card has name, category badge (UR), 礼金ゼロ, 所在地, up to 3 交通 lines (rail, or bus + stop + walk), 月額家賃 range, 共益費, plus links to `/outline/` and `/contacts/`. Sample: 春日部小渕, 埼玉県春日部市小渕493-1, 58,700～85,700円, 共益費 4,600円.

**Building** (`/outline/505`):

- Basic fields: 所在地; 交通 ×3; 管理 "40年～41年"; 総戸数 309; 月額家賃 51,600～95,800円; 敷金 2ヶ月; 共益費 2,720円; 礼金/仲介料 0.
- 駐車場 "平面 空き台数：15台 料金：6,600円": a live-looking parking-space count.
- An English-site link and a 審査基準 link.
- A **layout mix table**: 1LDK 57㎡ 37戸 / 3LDK 74〜77㎡ 235戸 / 4LDK 92・99㎡ 27戸.
- A long description copied from UR: 管理開始 昭和60年4月～, 構造 RC 5階建, nearby schools, shops and hospitals with distances, and UR's 特記事項 (no elevator, 13A gas, 40A max, VDSL).
- 17 photos and a Leaflet map.
- **A room table of 110 rows, every one "ご成約済"** (contracted), each with floor, layout, ㎡ and a `/bukken/{id}` link. It shows 3 rows, then "＋その他『全110件』". This is effectively an undated contract history per building.

**Room** (`/bukken/2037321/`): 月額家賃 61,800円, 敷金 2ヶ月, 礼金 0, 更新料 0, フリーレント -, 共益費 2,720円, 階数 5階, 間取り 3LDK, 床面積 80㎡, 総戸数, 管理 years, 駐車場, 3 floor-plan images. There is no status and no date on the room page itself.

### 1.7 Sister sites (same company, same address)

| Site | Notes |
| --- | --- |
| **ur-yoyaku.jp** (URプライム賃貸) | Same engine and the **same building ids** (`/outline/271` is エステート大南公園 on both). `/search/PRF11/` returns the same 55-building Saitama list. The home cards add **"10/08 更新 空室 2 室"**: a per-building vacant-room count and update date that urjkkplus's home page does not show. |
| **urjkkplus-housing.com** | English mirror. Same ids, UR code in the title, rooms marked "Reserved". |
| **ur-whitestone.com** (URコンシェルジュ, older engine) | **The URL is UR's code:** `/kanto/{shisya}_{danchi}{shikibetu}/`, e.g. `/kanto/50_3880/` ハーモネスタワー松原. That building's page now says "この物件は、現在お取り扱いしておりません". Lists use `/kanto/list/Saitama_a1/` (prefecture, with city counts such as 埼玉県草加市（4）, 川口市（3）, 越谷市（3）, 八潮市（1）) and `/kanto/list/Saitama_a1/Soka_a2/` (city). The 草加 list has 4 buildings: グリーンアベニュー谷塚 `50_2610`, コンフォール草加 `50_3910`, コンフォール松原 `50_4090`, コンフォール松原【ペット共生住宅】 `50_4091`. List cards show **管理開始 dates** (e.g. 1989.3・1990.4). Lines are `/kanto/list/Saitama_a1/Tobu%20Isezaki%20Line_l/` and stations `/…/Haraichi_s/`; filters include `/kanto/list/1_d06/`, `/5_w/`, `/10_y/`. The mobile page `/bukken-mobile/vacancy.php?r=50_3880&p=2806&s=2` (canonical `/kanto/50_3880/2806@/`) is a **"過去発生空室"** (past vacancy) record: 2LDK 59㎡ ¥122,100 共益費 ¥5,400 28階/30階, with no date. Images are at `/bukken/bukken_images/50_3880/50_3880_photo.jpg`. `/policy/` redirects to urjkkplus's terms. The home page embeds a dead Twitter feed (@urchintai) whose last posts are dated 2018-02. |
| **ur-housing.com** (English, since 2011) | `/bukken/list.php?a1=Tokyo` and similar. `/contract/` gives **"Contracting Results since July 1, 2011"** as contract counts per danchi (e.g. Kojimacho 2chome 177, Kasai Clean Town Seishin Minami Heights 122). Saitama shows "No Records". |

### 1.8 Collector notes

- **What is unique here:** the "ご成約済" room tables, parking-space counts, layout-mix tables, ur-yoyaku's per-building "空室 N 室 / 更新日", and UR codes in titles and URLs. Room-level rent and area copy UR's own data.
- **What it cannot do:** nothing is dated, nothing is real-time, and 葛飾区 is absent. Only about 3 buildings per city of ours appear, while UR has more.
- **How it could be used:** if we ever want "how many rooms in danchi X have been contracted", we could snapshot `/outline/{id}/` for our ~10 buildings weekly and diff the room table to derive approximate contract events. It is static HTML, about 1 page per building. Map building ids to UR codes once from the titles.
- **Terms:** the 利用規約 covers only the reservation service and says nothing about crawling.

---

## 2. 公共住宅賃貸募集センター — www.k-royal.jp

- **Operator:** the ロイヤルハウジング group (inquiry form posts to `group.royal-h.jp/kroyal/inquiry`). Shops at そごう横浜9F and 川崎アゼリア, open daily until 20:00. It is a broker for UR, 神奈川県住宅供給公社, the 横浜市 and 川崎市 公社, JA, セーフティネット住宅, 「保全の賃貸」 and its own managed stock. **Kanagawa only.** Japanese, free.
- **robots.txt:** only `Disallow: /wp/wp-admin/` (WordPress).
- **Sitemaps:** `/sitemap.xml` is an Auctollo index of 14 sub-sitemaps, all with lastmod 2026-10-09. `building-sitemap.xml` holds **485** building URLs (there are 9 building sitemaps; only the first was counted). `detail-sitemap.xml` holds **181** room URLs.

### URL grammar

```
/?s=&building_keyword[]=ur                 UR in Kanagawa: 357 件 (buildings), 12 pages
   &building_keyword[]=ken|safety|…        other 取扱機関
   &city_cd[]=y001…y018 | k001…k007 | s001…s023     横浜18区 / 川崎7区 / その他23
   &station[]=st{line}_{station}           e.g. st604_12 新横浜
   &rac=true                               空室がない物件を除外
   &rent_amount_lower/upper, square_lower/upper, room_layout_type[],
   complete_year_upper, est_transport_time_upper, character[], tanki=true
/page/{n}/?s&building_keyword[0]=ur        paging
/building/cd_{8 hex}/                      building, e.g. cd_d4f90006 鵜野森団地A棟
/detail/rd_{6 digits}/                     room, e.g. rd_845089
```

### Page anatomy

- **List cards:** building, address, 交通, rent, 敷/礼/仲介, layout, area, 築年月, 共益費, plus a table of every vacant room (階, 賃料, 共益費, 敷/礼, 間取り, ㎡).
- **Room page** (`rd_845089`, 洋光台中央): 5階, 1K 33㎡, 78,800円, 共益費 4,400円, 敷金 1ヶ月, RC 15階建, 築年月 1971年01月, **総戸数 1276**, 現況 空家, 定期借家 3年, 駐車場 16,940円, 23 photos. It also shows **登録日 2025年10月16日** and **次回更新予定 2026年10月23日**, which gives a listing age. The room number is only "5F号室".
- No UR codes appear anywhere.

**Verdict:** there is nothing for Saitama or Tokyo, so skip it. 9 pages were loaded, plus the round-1 home page.

---

## 3. SUUMO and UR

**In our repo:** `src/collectors/suumo/suumo.ts` has no UR-specific handling. UR ads come in as ordinary SUUMO ads. The advertiser puts "ＵＲ" in the building name, the notes read "管理費込", and the URL is a normal `jnc_…/?bc=…` detail page. In `data/listings_raw.json`, 11 SUUMO listings in our cities start with "ＵＲ":

- 川口: ＵＲリプレ川口二番街 4DK 203,700; ＵＲコンフォール東鳩ヶ谷 ×3
- 草加: ＵＲグリーンアベニュー谷塚 2LDK 117,300; ＵＲコンフォール松原 ×2
- 越谷: ＵＲせんげん台パークタウン三番街 3LDK 91,890
- 葛飾: ＵＲ青戸第四, ＵＲ青戸第一, ＵＲ金町第二

AtHome and Nifty carry the same pattern (16 more). Name prefix "ＵＲ" is a cheap UR flag. No UR code appears in these ads.

**The special page** `https://suumo.jp/tokushu/ur/chintai_kanto/`: a static promo page (the UR benefits, "入居までの流れ" at `nyukyo.html`, 社宅). Its only data links are two `/jj/log/common/JJ700FK100/?URL=http://www.ur-net.go.jp/chintai/kanto/&GRP=ur_chintai…` redirects to UR's own site. It has **no listings, no prefecture pages and no 埼玉 URL form**. Whether SUUMO's search has a UR-only filter parameter was not checked *(unverified)*. 1 page loaded.

---

## 4. LIFULL HOME'S UR tag — /chintai/ltag/5414/

- `https://www.homes.co.jp/chintai/ltag/5414/list/` loaded (HTTP 200, meta robots `noarchive`). It showed **2,141件（総物件数：2,301件）**, "この検索条件の新着物件 418件", paging `?page=2…28`, and 2 PR cards at the top.
- **The advertiser is UR itself** ("独立行政法人都市再生機構　UR賃貸ショップ金山", "…UR津田沼営業センター"), and building names are prefixed "UR" (URアーバンラフレ金山, UR谷津パークタウン参番街).
- **Cards:** building, address, 交通, 築年数/階数, then rooms with 階, 即入居可, "2日前UP", 賃料/管理費 (14.75万円/3,500円), 敷/礼, 間取り, ㎡ and feature tags.
- **URL forms:** room `/chintai/room/{40-hex}/`, building `/chintai/b-{13 digits}/`, and archive `/archive/b-{8 digits}/` (search result: ペアハイツ越谷1号棟 is at `/archive/b-28059668/`).
- **The 埼玉 form `/chintai/ltag/5414/saitama/list/` exists** (it appears in search results as "埼玉県から「UR賃貸物件で暮らしたい」…"; `/tokyo/list/` likewise). When loaded it returned **HTTP 405 "Human Verification"**, so its contents were not seen.
- The repo has no HOME'S collector. This tag would be the entry point if one is added. Expect the verification wall on deeper pages.

---

## 5. Known sites, light pass

| Site | What I saw (2026-10-09) |
| --- | --- |
| **g-z.co.jp/ur/** | Landing page for **ラク賃不動産** (the same broker as ur-s.jp): UR 仮申込 via LINE, cashback up to 1 month's rent, funded by UR's あっせん fee. No listing data. 1 page. |
| **ur-rental.jp** | "UR住まいのキャッシュバックの窓口" / 仮住まいプラス (Kobe, 078-262-1201). A nationwide UR あっせん broker refunding 1 month's rent; users pick a room on UR's site and send a form. Has a blog, no data. 1 page. |
| **minhyo.jp/ur-chintai** | みん評 reviews of **UR as a company**: 305 reviews, average 3.06 (category average 2.86). Mostly noise and management complaints, not per danchi. 1 page. |
| **note.com/monk_mode_youcan** | Shun, the operator of kuushitsu-info.jp (X: @ur_kuushitsu). The article (2026-03-23) describes free email alerts, Google or email sign-up, and up to 20 watched properties. 1 page. |
| **zenn.dev/yamadadayo123** (penpen) | Dev memo for **UR空き部屋チェッカー** (§6.1): Next.js + OpenNext on Cloudflare with D1 and Drizzle. It calls UR's backend API instead of Playwright. The author read UR's site guide (`/site/guide.html`) and concluded it forbids reposting but not scraping. Links `github.com/penpendayo/ur-automation` (says it went private). 1 page. |
| **github.com/jipili/ur-watch1** | Python + GitHub Actions every 15 min. It POSTs UR's `detail_bukken_room` for **474 buildings (Tokyo 308 + Kanagawa 166)**, diffs vacant room IDs against `state.json` and emails new ones. `ur_properties.json` has fields `name, pref, shisya, danchi, shikibetu, url`. I saw the first 211 entries; the browser text was capped at 40k. They include 17 **葛飾区** danchi, e.g. 金町駅前 20_1650, 青戸第三 20_2860, 金町第二 20_2950, 青戸第四 20_2960, 金町五丁目 20_3070, 青戸第五 20_3190, 西新小岩リバーハイツ 20_3350, エステート東新小岩 20_3420, エステート堀切 20_3720, エステート東堀切 20_3730, メゾン堀切七丁目 20_3930, メゾン堀切八丁目 20_3940, すまいる亀有 20_4481, 青戸第一 20_4911, アーバンライフ東新小岩 20_5020, 金町第一 20_6400 and 青戸第二 20_6680. **No Saitama.** The bot commits "Update vacancy state [skip ci]" (127 commits at load), so **the repo's git history is a 15-minute vacancy history for Tokyo and Kanagawa.** 2 pages (README + raw JSON). |
| **duongnt.com/urchintai-api/** | Write-up dated 2021-07-15. API root `https://chintai.sumai.ur-net.go.jp/chintai/api/`, **POST** form data. `bukken/detail/detail_bukken_room/` takes shisya, danchi, shikibetu, orderByField, orderBySort and pageIndex. It returns an array of vacant rooms with `allCount`, `id` (= JKSS, e.g. 000000404), `name` (404号室), `rent`, `commonfee`, `type`, `floorspace`, `floor`, a `madori` image URL, `system[]` (近居割…) and `design[]`; it returns `null` when nothing is vacant. `bukken/detail/detail_room/` takes `id` (= JKSS) plus the three codes. URL rule: `/chintai/{area}/{pref}/{shisya}_{danchi}{shikibetu}.html` and `…_room.html?JKSS=`. A client library is at `github.com/duongntbk/urchintai-client`. A search snippet says the current API host is `chintai.r6.ur-net.go.jp` *(unverified here; see the UR official doc)*. 1 page. |

---

## 6. Newly discovered sites that publish UR data

### 6.1 UR空き部屋チェッカー — ur.penpen-dev.com

- **Operator and stack:** an individual developer (penpen, X @penpen_dev). A free email notifier, with login for saved conditions. Next.js React Server Components (`?_rsc=` fetches) behind Cloudflare.
- **`/ja/search` is public without login** and listed **2,968件ヒット**, every currently vacant UR room nationwide, newest first. Each row has: danchi / **号棟号室** (e.g. 宝台 / 14号棟503号室), city (pref), layout, ㎡, rent, campaign tags (近居割, 近居割WIDE, 子育て割, URライト（4年定借）), and **公開日** as relative time ("12時間前").
- **Each row links UR's official room URL with UR codes and JKSS**, e.g. `https://www.ur-net.go.jp/chintai/kyushu/fukuoka/90_0740_room.html?JKSS=000014503`. The data is UR's, so it joins perfectly.
- **Filter form** (GET `/ja/search`): `name, prefecture, buildingId, rentMin, rentMax, types[], minFloorSpace`.
- **Unique:** the 公開日 (first-seen time) per room. Everything else copies UR.
- **Pages:** `/ja`, `/ja/search`, `/ja/conditions`, `/ja/notifications`, `/ja/settings` (login), `/ja/terms`. 2 pages loaded.
- **Collector note:** not needed if we read UR directly. It is useful as a sanity check of first-seen times.

### 6.2 swimple rent — swimple.net/rent/ (rent.swimple.net redirects here)

- **Operator:** swimple (note.com/swimple), a small multi-service maker (hotel price alerts, VPN). Free email watch for UR + JKK東京, 6 languages. Login or registration is needed only to watch.
- **The home page states:** "UR 賃貸 1,371件 / JKK 東京 237件", **60min** crawl interval, and per-prefecture counts (東京都 307, 大阪府 206, 神奈川県 166, 福岡県 138, **埼玉県 118**, 千葉県 110).
- **URLs:** `/rent/ur/area/{都道府県名}`, `/rent/ur/{id}` (own numeric id: 1781, 2416, 1294), `/rent/ur/` (all).
- **"最近、空室が出た物件"** cards include アーバンハイツ南前川（川口市）新着空き 空き2部屋 107,500～127,000円 （3,800円） and すまいる亀有（葛飾区）新着空き.
- **Their note article (2026-05-05)** reports 1,374 properties × 6 months (2025-11 to 2026-05), 30-min polling, 8.2M records and 14,021 appear-to-fill events. Median time to fill was 24.9 h nationally and 19.7 h in Tokyo. 48.6% filled within 24 h. New vacancies peak at 10:00, 02:00 and 18:00, and come mostly on even hours. March brings 1.8× as many. **Saitama (118 properties) had a 22.0% vacancy rate** (Tokyo 12.8%). Useful as a published baseline. The raw data is not public.
- 2 pages loaded (home + note).

### 6.3 シティモバイル — www.citymobile.co.jp

- A UR/JKK broker (CityMobile HD), phone 0120-0606-44. Building pages are `/catalog/{bldgId}` (541 = ハーモネスタワー松原) and room pages `/catalog/{bldgId}/{roomId}` (16575 = 30階 3LDK 77㎡ 146,000円 共益費 5,400円).
- The building page shows "空室を確認：0件" and **"過去に募集した部屋（76件）"** (floor, rent (共益費), layout/㎡). It is labelled "最終更新：2021年01月30日". The room page shows 更新日 2024年04月30日.
- Hubs: `/area/ward/{id}`, `/line/station/{id}`. Own IDs, no UR codes.
- Past-listing history exists but is stale. Not worth collecting. 2 pages.

### 6.4 QAC不動産情報センター — qac.co.jp/ur/saitama/

- A UR あっせん broker offering 60–80% cashback as お祝い金. One static page per prefecture lists danchi by city, with line/station, address and walk minutes.
- The anchor IDs are **JIS city codes without the prefecture**: `#221` 草加市, `#222` 越谷市, `#234` 八潮市, `#214` 春日部市.
- 草加: 草加旭町, グリーンアベニュー谷塚, ハーモネスタワー松原, コンフォール草加, コンフォール松原. 越谷: せんげん台パークタウン四番街, 同三番街, ペアハイツ越谷. 八潮: 八潮.
- No vacancies or rents. Useful only as a danchi checklist. 1 page.

### 6.5 Others loaded, little data

- **ur-chintai.net (UR団地ネット):** WordPress broker blog with 内覧写真 posts (金町駅前団地 2DK, 栗原団地 3DK …) and an embedded X feed @ur_danchinet. "UR最新空室情報" is just that feed. 1 page.
- **able.co.jp/feature/ur/saitama/:** Able (CHINTAI group) UR feature page with `/ensen/` and `/area/` sub-hubs. Able also has archive pages for UR buildings, e.g. `/archive/saitama/bld-0836767/` ハーモネスタワー松原 *(search snippet)*. The repo already maps CHINTAI's grammar. 1 page.
- **apartment-hunter.net/ur/:** Japan UR Apartment Center (RK-realtors, Osaka). English UR agent, mostly Kansai. 1 page.
- **ur-chintai-info.com:** the page body is just the bare domain name, so the site looks **defunct**. Search snippets still describe "UR Rental Information Center", an English reservation agent. 1 page.

---

## 7. Found but not loaded (one line each)

**GitHub / developer projects**

- `github.com/tama-create/ur-monitor` (loaded README): PHP + chrome-php scrapes 4 UR list URLs every 5 min, 08:00–21:00 JST, posts to Slack and keeps state in Cloudflare KV. It notes that UR robots.txt had no Crawl-delay on 2026-08-28.
- `github.com/makotoishidayuma/ur-watch` (loaded README): watches one building (板橋ビュータワー `20_6330`) via the building page, the SP room page `/chintai/sp/kanto/tokyo/20_6330_room.html` and the station list pages `/chintai/kanto/tokyo/eki/1573.html`.
- `github.com/DanielAragoneses/ScrapeSuite`: generic scraper with a UR module for `chintai.r6.ur-net.go.jp` *(search snippet)*.
- `github.com/duongntbk/urchintai-client`: Python client for the API described in §5.
- `github.com/penpendayo/ur-automation`: penpen's repo, now private *(per the Zenn memo)*.
- coconala.com/services/1685016: a paid gig to build a UR vacancy notifier on Google Apps Script *(search snippet)*.
- deep-watch.net: an old (about 10 years) UR vacancy email service *(search snippet)*.

**X / social accounts**

- @ur_kuushitsu: kuushitsu-info.jp bot, posts "UR空室速報 ▶ 新着 N件…".
- @UR_rent "UR賃貸サポート": broker doing remote 空室待ち.
- @urchintai: Whitestone; feed last seen 2018-02.
- @ur_danchinet: UR団地ネット.
- @penpen_dev: UR空き部屋チェッカー dev.
- Official: @UR_TOSHIKIKOU and @urkurashi (campaigns only, not vacancies). UR's own list is at ur-net.go.jp `/site/socialmedia_index.html`.
- facebook.com/URenglishsupport: UR English support page.

**Apps**

- No vacancy-search app exists from UR.
- 「URくらしのアプリ」 (released 2026-06-29, 東海 first) is for **residents' paperwork** only *(search snippet)*.
- APPLION lists only general portal apps for "ur賃貸".

**Other brokers and portals with UR pages**

- ur-chintai-info.com (dead).
- axel-home.com/ur (中央区・江東区 UR feature).
- start-line.co.jp/build-4411753/ (ハーモネスタワー松原).
- smocca.jp/building/… (20 past listings for ハーモネスタワー松原).
- sumaity.com/chintai/saitama_bldg/bldg_3018692/.
- townhousing.co.jp/building/….
- ieshil.com/buildings/121700/ (sale price estimates for URハーモネスタワー松原).
- Live in Japan UR (Ichii group, multilingual, about 9 years old).
- miyagi-jk.or.jp/ur_all/ (Miyagi 公社 UR list; not our area).

All of these are *(search snippet)*.

**Reviews and articles**

- mansion-review.jp has UR building pages and reviews (e.g. 越谷団地 `/mansion/578051.html`, ペアハイツ / 越谷 station reviews).
- realestate.yahoo.co.jp catalog: ＵＲ都市機構コンフォール草加4号棟, rating 3.89, 27 クチコミ *(search snippet)*.
- local55.jp, apartment-labo.com, recodan.blogspot.com (how to spot 建替え candidates via URライト), media.ina-gr.com: articles only.
- Nikkei (2026-08): 23区 had only 28 vacant UR rooms at the end of July *(search snippet)*.

**Open data / statistics (no per-room data anywhere)**

- UR `/chintai_portal/stock/lrmhph000000ebqe-att/stocktype_220630.pdf`: 個別団地類型（案）一覧 (danchi name, ストック再生/活用 type, 管理開始年度, 管理戸数, pref, city). A PDF only. A snippet claims 1,402 団地 / 690,455 戸 *(unverified)*.
- UR `/chintai_portal/rebuild/` and `/chintai_portal/rebuild/news/{2024,2025}.html`: 団地再生事業 着手一覧 (建替え and 集約 starts). コンフォール松原 is a 草加 全面建替え case.
- e-Stat 住宅・土地統計調査 (5-yearly, the category is "都市再生機構（UR）・公社の借家") and 国勢調査 (公営・都市再生機構・公社の借家). Municipal level only, never per danchi.
- e-Stat 小売物価統計調査 has an item "都市再生機構住宅家賃": a rent index time series, not per danchi.
- MLIT 住宅経済関連データ (公共賃貸 rent per 畳) and the 国総研 市町村計画策定支援データセット.
- No CSV or JSON open dataset of UR danchi was found on UR, data.go.jp or e-Stat.

---

## 8. What this means for a collector

1. **For our four cities, the only source worth building on remains UR's own site and API** (see the UR official doc). Every site here copies UR's rent, layout and area. Of the third parties, **uralert / kuushitsu-info / ur-tsuchikun / swimple / penpen** all derive first-seen times by polling UR, which we can do ourselves.
2. **Join keys:** UR's `shisya_danchi+shikibetu` code is exposed by urjkkplus (in the title), ur-whitestone (in the URL), penpen (in links, with JKSS), jipili's JSON and ur-net itself. Portal ads (SUUMO, AtHome, Nifty, HOME'S) carry **no UR code**. Match them by building name after stripping the "ＵＲ" prefix and comparing address. Seed codes for 葛飾 can come from jipili's `ur_properties.json`. Saitama codes have to come from UR (e.g. 50_2610 グリーンアベニュー谷塚, 50_3910 コンフォール草加, 50_4090 / 50_4091 コンフォール松原, 50_3880 ハーモネスタワー松原, all from ur-whitestone).
3. **History:** dated contract or vacancy history for Saitama is not published by any site seen here. Whitestone's undated "ご成約済" tables and ur-yoyaku's "空室 N 室 / MM/DD 更新" could be snapshotted weekly as a weak secondary signal, at about 10 static pages per run.
4. **Portals:** keep collecting SUUMO, AtHome and Nifty as now. Flag UR ads by the name prefix `^(ＵＲ|UR)` and by "管理費込". A HOME'S collector would start at `/chintai/ltag/5414/{pref}/list/` but must handle the Human Verification wall.
5. **Policy:** all of these are external services not used in the codebase today. Building on any of them (or on UR's API) may need Mercari's internal **External Service Review**.

## 9. Checked log (2026-10-09)

| Site | Pages loaded | Pages |
| --- | --- | --- |
| urjkkplus-ws.com | 14 + 2 reused | sitemap.xml (404), /search/district/103/, /103/11/, /PRF11/ (redirect), PRF11 list, PRF13 list, CTY13017/CGY2, CTY11027, /outline/505, /bukken/2037321, /bukken/73656, /search/map/, /company/policy/, /about/service/; reused home + robots.txt |
| urjkkplus-housing.com | 1 | /outline/505/ |
| ur-yoyaku.jp | 2 | home, /search/PRF11/ |
| ur-whitestone.com | 6 | home, /kanto/50_3880/, vacancy.php, /kanto/list/Saitama_a1/, /Soka_a2/, /policy/ (redirect) |
| ur-housing.com | 2 | home, /contract/ |
| k-royal.jp | 9 + 1 reused | robots.txt, sitemap.xml, building-sitemap.xml, detail-sitemap.xml, UR search, /search/, /building/cd_d4f90006/, /detail/rd_845089/, /about/ur/; reused home |
| SUUMO | 1 | /tokushu/ur/chintai_kanto/ |
| LIFULL HOME'S | 2 | ltag 5414 national; saitama (405 Human Verification) |
| GitHub | 4 | jipili/ur-watch1, its raw ur_properties.json, tama-create/ur-monitor, makotoishidayuma/ur-watch |
| Light-pass articles and broker pages | 6 | duongnt.com, zenn, note (monk_mode_youcan), g-z.co.jp/ur, ur-rental.jp, minhyo.jp |
| ur.penpen-dev.com | 2 | /ja, /ja/search |
| swimple | 2 | /rent/, note article |
| citymobile.co.jp | 2 | /catalog/541, /catalog/541/16575 |
| Other brokers | 5 | qac.co.jp/ur/saitama/, ur-chintai.net, ur-chintai-info.com, able.co.jp/feature/ur/saitama/, apartment-hunter.net/ur/ |
| **Total new loads** | **58** | |
