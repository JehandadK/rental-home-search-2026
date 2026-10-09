# 空室情報.jp (kuushitsu-info.jp): UR and JKK東京 vacancy tracker

Mapped on **2026-10-09** in a headed Playwright browser, one tab, 8–14 s between
pages. I loaded 31 pages: robots.txt, the sitemap (loaded twice: once as text and
once to read every `<loc>`), hubs, 9 団地 pages, analytics pages, the JKK
section, two blog posts and the terms. A danchi page's history pager and the
hourly chart's SVG were read on the page itself, with no extra page loads.
Nothing was fetched with curl or fetch.

## 1. What it is

- **Independent tracker, not official.** Every page has a footer saying it has no
  connection with UR都市機構 or JKK東京. The brand in titles is 「空室情報.jp」.
  UR pages are called 「UR空室情報」 and JKK pages 「JKK東京 空室情報」.
- **Operator:** "Shun" ("UR、JKK物件専門家") writes on note.com
  (`note.com/monk_mode_youcan`). One post's title says he built the tool because
  waiting for UR vacancies was too painful (found by web search, not loaded).
  X account: `@ur_kuushitsu`, which posts new vacancies.
- **Japanese only.** Built with Next.js App Router (Turbopack chunks, `?_rsc=`
  prefetches, no `__NEXT_DATA__`). Sentry, GA4 and AdSense are on the pages.
- **Free.** Email notifications need a signup (`/signup?redirect=…`), which I
  did not open. A search snippet says up to 20 properties can be watched with
  no expiry (unverified).
- **Money comes from** AdSense, affiliate links, and a 紹介申込 broker tie-in.
  Terms §8: for some UR properties the site prepares UR's 「賃貸住宅紹介申込書」
  through a partner broker (有限会社リアルサンライズ) and pays a ¥3,000 Amazon
  gift card if a contract results. Terms §9: some JKK あっせん rooms have a
  「内見申込」 button that goes to a partner agent. I saw it on 横川町.
- **Size:** 「現在 489 物件 / 1481 室の空室情報を公開中」 (UR, 13:00 JST). The
  sitemap lists 1,372 UR 団地. JKK: 15 properties / 34 rooms vacant, and about
  300 property pages.

## 2. robots.txt and sitemap

```
User-Agent: *
Allow: /
Sitemap: https://kuushitsu-info.jp/sitemap.xml
```

`/sitemap.xml` is a single urlset of **1,893 URLs**, not an index. Almost every
`<lastmod>` is the build time (`2026-10-09T04:30:57Z`, 1,769 of them). Blog
posts carry their publish date.

| Group | URLs | Pattern |
| --- | --- | --- |
| UR 団地 pages | 1,372 | `/ur/area/{region}/{pref}/{shisya}-{danchi4}` |
| UR region / prefecture hubs | 6 + 20 | `/ur/area/{region}`, `/ur/area/{region}/{pref}` |
| JKK property pages | ~300 | `/jkk/area/{city}/{jkkSlug}` |
| JKK city hubs | 46 | `/jkk/area/{city}` (romaji ward/city: `katsushika`, `adachi`…) |
| Blog | 125 + index | `/blog/{yyyy-mm-dd}-{slug}` or `/blog/{slug}` |
| Fixed pages | ~20 | `/ur`, `/ur/recent`, `/ur/vacancy`, `/ur/vacancy/count`, `/ur/analytics[/fill-speed|/hourly|/weekly]`, the same under `/jkk`, `/guide/ur`, `/guide/jkk`, `/ur/terms`, `/ur/privacy`, `/contact`, `/signup` |

UR 団地 per prefecture in the sitemap: 東京 307, 大阪 206, 神奈川 166, 福岡 138,
**埼玉 118**, 千葉 110, 兵庫 103, 愛知 100, 京都 41, 北海道 26, 奈良 21, 茨城 16,
広島 7, 山口 3, 宮城 3, 滋賀 2, 三重 2, 岐阜 1, 和歌山 1, 岡山 1.
So it covers only part of UR's stock (UR lists far more 団地 in 埼玉).
The pages for 埼玉県 (118) and 東京都 (307) list every 団地 on one page each,
which matches the sitemap.

## 3. URL hierarchy

```
/                                        portal root
├ /ur                                    UR top: live counts, last 6 changes
│ ├ /ur/recent[?page=N]                  global change feed (8 pages, newest first)
│ ├ /ur/vacancy                          about page / FAQ
│ ├ /ur/vacancy/count                    every 団地 with vacancies, most vacancies first (489)
│ ├ /ur/analytics                        index of the 3 analyses
│ │ ├ /ur/analytics/fill-speed[?page=N]  appear→fill durations, Top-10 ranking, 116 pages
│ │ ├ /ur/analytics/hourly               appearances/fills by hour (chart)
│ │ └ /ur/analytics/weekly               appearances/fills by weekday (chart)
│ └ /ur/area/{region}                    hokkaitohoku kanto tokai kansai chugoku kyushu
│   └ /ur/area/{region}/{pref}           every 団地 of the prefecture, those with vacancies first
│     └ /ur/area/{region}/{pref}/{id}    団地 page: current rooms + change history
├ /jkk                                   same tree for JKK東京
│ ├ /jkk/recent, /jkk/vacancy, /jkk/vacancy/count
│ ├ /jkk/analytics[/fill-speed|/hourly|/weekly]
│ └ /jkk/area/{city}                     every JKK property in one ward/city
│   └ /jkk/area/{city}/{jkkSlug}         property page
├ /blog[?tag=UR]  /blog/{slug}           「空室ジャーナル」: guides and per-団地 "when do vacancies appear" posts
├ /guide/ur, /guide/jkk                  moving checklists
└ /signup, /contact, /ur/terms, /ur/privacy
```

There are **no city-level UR pages**. The finest UR grouping is the prefecture.
The 「フィルター」 control on list pages filters in the browser and adds nothing to the URL.

### Our area

| Area | ID | 団地 (status 2026-10-09 ~13:00) |
| --- | --- | --- |
| 草加市 | `50-4090` | コンフォール松原 (1 vacant: 1号棟701号室 2DK 50㎡ ¥108,400) |
| 草加市 | `50-3880` | ハーモネスタワー松原 (none; last vacancy 2026-08-25) |
| 草加市 | `50-3910` | コンフォール草加 |
| 草加市 | `50-2610` | グリーンアベニュー谷塚 |
| 草加市 | `50-1340` | 草加旭町 |
| 越谷市 | `50-2070`, `50-2180` | せんげん台パークタウン四番街, 三番街 |
| 越谷市 | `50-2300` | ペアハイツ越谷 |
| 川口市 | `50-1820` | 川口芝園 (none; 18 appearances in the last 30 days) |
| 川口市 | `50-4020` | コンフォール東鳩ヶ谷 (2 vacant) |
| 川口市 | `50-2220`, `50-4070`, `50-2890` | アーバンハイツ南前川, コンフォール西鳩ヶ谷, リプレ川口二番街 (vacant) |
| 川口市 | `50-1470` `50-3890` `50-4040` `50-2280` `50-3040` `50-1280` `50-1380` `50-1490` `50-2350` `50-2580` `50-3980` | 川口栄町第二, コンフォール川口飯塚, シティコート川口, エルハイツ末広, アーバンハイツ飯塚三丁目, 北園, 川口芝, 川口前川町, パークハイツ中青木, 飯塚四丁目ハイツ, リバピア川口青木 |
| 八潮市 / 三郷市 / 吉川市 | `50-1390` / `50-2230` `50-3000` `50-1561` / `50-1551` | 八潮 / 三郷早稲田パークハイツ(第二), みさと / 吉川 |
| 葛飾区 (UR, 19) | `20-3420` `20-5840` `20-4911` `20-2950` `20-3350` `20-6680` `20-1650` `20-3730` `20-6400` `20-3940` `20-2850` `20-2860` `20-2640` `20-3720` `20-5020` `20-3190` `20-3070` `20-2960` `20-3930` | エステート東新小岩 (1 vacant), アクシス東四つ木, 青戸第一, 金町第二, 西新小岩リバーハイツ, 青戸第二, 金町駅前, エステート東堀切, 金町第一, メゾン堀切八丁目, 東四ツ木二丁目第二, 青戸第三, 東四ツ木二丁目, エステート堀切, アーバンライフ東新小岩, 青戸第五, 金町五丁目, 青戸第四, メゾン堀切七丁目 |
| 葛飾区 (JKK, 4) | `th-higashishinkoiwa6`, `tomin-higashiyotsugi4chiyoumeapato`, `riverbreeze`, `hondenkawabatacho` | トミンハイム東新小岩六丁目, 東四つ木四丁目アパート, リバーブリーズ綾瀬, 本田川端町 |

越谷レイクタウン has no page here. The 埼玉 list has no レイクタウン 団地.

## 4. Identifiers

| Thing | Format | Example | Notes |
| --- | --- | --- | --- |
| UR 団地 | `{shisya}-{danchi3}{shikibetu1}` | `50-4090` | **This is UR's own code** with `-` in place of `_`. The JSON-LD `url` and the 「公式サイトで詳細を見る」 link point to `https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090.html`. All 1,372 IDs have 4 digits after the dash. A trailing non-zero digit is the 識別 code (`50-1551` 吉川, `50-3931` コンフォール南浦和, `20-6771`, `20-4911`). |
| 支社 prefix seen | 20 東京/北海道/宮城, 30 千葉/茨城, 40 神奈川, 50 埼玉, 70 東海, 80 関西/中国, 90 九州 | | Same as UR. |
| UR room | text only: `{棟}号棟{部屋}号室` | `1号棟701号室`, `1109号室`, `2-5-6号棟601号室` | The room label as UR shows it. **UR's room ID is not exposed.** The floor-plan image is hot-linked from UR (`sumai.r6.ur-net.go.jp//chintai/recruit/ArrNormal/10/50409/0000001/G9p/RA/Image/50_409_0-00-0001_G9p_RA_01_00007.gif`), so its path carries UR's danchi `50_409_0` and plan codes. |
| UR inquiry link | `sumai.r6.ur-net.go.jp/chintai/s/otoiawase/danchi.html?in=1050409` | | 「UR公式サイトで申し込む」 per room, at 団地 level only. |
| Photos | `chintai.r6.ur-net.go.jp/chintai/img_photo/50/50_409/50_409_photo.jpg` via `/_next/image` | | Copied straight from UR's paths. |
| JKK property | JKK東京's own page slug | `riverbreeze` → `https://www.to-kousya.or.jp/chintai/reco/riverbreeze.html` | Prefixes follow JKK's type: `kh-` (コーシャハイム), `th-` (トミンハイム), `tomin-` (都民住宅/アパート, labelled 使用料), `tt-`, `kt-`, `c-`, `et-`, `p-`. |
| JKK room | `{棟}-{部屋}` | `8-505`, `ｲ-6-106`, `1-3603` | |

**Joinability:** UR 団地 join exactly to UR's official site and to any other
site that keeps `shisya_danchi_shikibetu`. Rooms join only on the room label
(棟 + 号室) plus 団地, since no room ID is shown.

## 5. Page anatomy

The content is server-rendered: the room tables, history rows and list cards
are in the HTML text. The pages make no JSON XHR of their own. The only XHRs
are Next.js `?_rsc=` route prefetches (React Server Components flight data,
not JSON), Sentry, GA and ads. `self.__next_f` was empty after hydration.

### Prefecture page `/ur/area/kanto/saitama`
- Title 「埼玉県のUR賃貸｜全118物件の新着空室を無料通知」. One card per 団地,
  vacant ones first: name, 「募集中戸数: N」 or 「空無し」, 住所, 家賃 range,
  交通 (up to 4 lines, walk/bus minutes). The rent range is shown even when
  nothing is vacant. On 団地 pages it matches the last observed vacancy (for
  example 中目黒 shows ¥362,100 with nothing vacant).
- The largest 募集中戸数 seen anywhere was 6 (左近山), and most top entries
  show 5. This may be a cap from how UR's own pages list rooms (unverified).

### 団地 page `/ur/area/kanto/saitama/50-4090`
- Header: 「空室あり 1戸」 / 「現在空室なし」, **最終更新 `2026/10/9 13:33:39`**
  (the site's last check of this 団地), **「12人が通知登録中」** (how many people
  watch it), the official link and 「直近の空室発生は2026年10月9日です」.
- **現在の空室 table:** 間取り (UR's floor-plan GIF), 部屋, タイプ, 階, 面積,
  家賃, 共益費, 敷金 (`2か月`), 申込 link.
- **更新履歴 table:** 更新日時 (to the second), 部屋, タイプ, 家賃, 変動 (`+1`
  appeared / `-1` gone). The pager is client-side: 8 pages × 6 rows =
  **at most 48 events** (about 24 vacancy cycles). コンフォール松原's history
  went back to 2026-09-04. エステート東新小岩 (`20-3420`) had only 13 rows,
  the oldest from **2026-05-29**, so history goes back at least to late May 2026.
- 概要: 外観 photo, 住所, 建築年 (`平成20年8月～平成30年5月`), 家賃 range, 共益費,
  階数, 代表的な間取り, 交通, 主な設備 (about 40 bullet tags: エレベーター, 床暖房,
  ディスポーザー…).
- FAQ (also as `FAQPage` JSON-LD) with computed stats: 「過去に計24件の空室発生を
  確認。直近30日間では22件」, 「空室発生から申込みまで約5日（23件の実績）」.
  **Every page says 「計24件」**, so this count is limited by the 48-row history,
  not the true total. The blog's per-団地 widget gives 90-day counts instead
  (久喜青葉: 90 appearances in 90 days, average fill about 5 days).
- Four "nearby" 団地 cards (in practice, other vacant 団地 in the prefecture).
- JSON-LD `ApartmentComplex`: `name`, `address`, `url` (UR official),
  `yearBuilt`, `numberOfAvailableAccommodationUnits`. Also `BreadcrumbList` and `FAQPage`.

Sample history (コンフォール東鳩ヶ谷 `50-4020`): 3号棟303号室 2DK ¥99,000 went
+1 on 10/2 10:39, −1 on 10/3 12:43, then +1 again on 10/3 14:39. Rooms that
reappear like this show up in the history.

### Change feed `/ur/recent?page=N`
Columns: 更新日時, 都道府県, 物件名(部屋), タイプ, 家賃, 空室変動 ±1. 8 pages
reached back only about 2.5 hours (13:03 → 10:32 on 10/9). It is a live
ticker, not an archive.

### `/ur/vacancy/count`
Every 団地 with vacancies (489), sorted by 募集中戸数: name, count, prefecture,
address, rent range, stations.

### Analytics
- **`/ur/analytics/fill-speed`**: switches for 7 / 30 / 90 days. A distribution
  of fill times (30分以内 … 1日以上), a **人気物件ランキング Top 10** by average
  time to fill (e.g. 豊洲四丁目 1時間1分, 5件), and **詳細データ**:
  物件名, 部屋, タイプ, 家賃, 空き発生, 申込完了, 所要時間, sorted shortest
  first, 116 pages (`?page=N`). Example row: 久喜青葉 1-12号棟403号室 2LDK
  ¥45,000, 2026/10/3 16:58:55 → 17:22:16, 23分. Many rows are exactly 23–24
  minutes, which is probably the gap between two checks rather than a real
  fill time.
- **`/ur/analytics/hourly`** and **`/weekly`**: Recharts line charts with
  series `appearedCount` / `disappearedCount`. The numbers appear only as
  drawn SVG paths, not as text. Reading the hourly path, peaks are at
  16h (~2,100), 18h, 0h, 22h and 20h, with almost nothing from 4h to 15h. The
  history timestamps cluster at 10:3x, 12:3x, 14:3x, 16:4x and 18:5x JST, so
  the chart looks **shifted by +6 hours** (my inference). The site's own blog
  repeats the shifted peaks (「16時台、0時台、18時台」), while its editorial
  text says 9–10時.
- The blog's 7-day widget showed **+2,132 new vacancies / −2,167 filled** across UR.

### JKK pages
- `/jkk/area/katsushika`: 「全4物件」, cards like the UR ones (トミンハイム東新小岩六丁目
  ¥94,000〜121,300…). 都民住宅 cards say 使用料 instead of 家賃.
- `/jkk/area/katsushika/riverbreeze`: the same layout. 「通知登録者は現在いません」,
  「まだ更新履歴がありません」, JSON-LD `url` = JKK official page, 建築年 1993年9月.
- `/jkk/area/hachioji/yokokawachou`: the room table adds 敷金 in yen and a
  「内見申込」 button. History has 48 rows back to 2026-08-10.
- `/jkk/vacancy/count`: 15 properties with vacancies. Each card adds 建築年
  and 交通 with bus stops (the text still contains literal `<br>`, so it is
  copied from JKK's data unchanged).

### Blog
- `/blog/ur-vacancy-timing` (2026-03-06): month, weekday and hour tables.
  These are qualitative (★ ratings), not data.
- Per-団地 posts (`/blog/2026-10-06-ur-kukiaoba-vacancy-timing-analysis`)
  embed a live 90-day widget: current vacancies, appearance count, average
  time to fill, number of watchers, and the last 5 changes. The text is
  generated from templates. 125 posts; one is about Saitama
  (`2026-07-18-ur-chintai-pet-saitama-list`, `2026-04-20-ur-saitama-under-50000-yen`, `2026-05-04-ur-saitama-under-60000-yen`).

## 6. Information inventory

| Item | Here? | Notes |
| --- | --- | --- |
| Current vacancies, room level | Yes | Room label, type, floor, ㎡, rent, 共益費, 敷金 |
| Floor plans / photos | Yes, hot-linked from UR | |
| Coordinates | No | No map or lat/lng seen |
| Stations | Yes | With walk and bus minutes, up to 4 lines |
| Building age | Yes | 建築年 text (和暦 ranges) |
| Equipment | Yes | About 40 設備 tags per 団地 |
| **Appear / disappear history** | **Yes, room level, to the second** | Last 48 events per 団地 on its page; ~2.5 h globally on `/recent`; appear→fill pairs on fill-speed (116 pages per 30 days, up to 90 days) |
| 成約 (contract) history | Not as such | A `-1` means the listing left UR's site (filled, withdrawn or paused). The site calls it 申込完了. |
| Days on market | Yes | Per room (fill-speed) and as a per-団地 average (FAQ) |
| Rent history | Partly | Each event carries the rent at that moment; no separate rent series |
| Statistics / rankings | Yes | Fill-speed Top 10, hourly/weekly charts, 7-day totals |
| Popularity | Yes | 「N人が通知登録中」 per 団地: unique, and a demand signal |
| Reviews / 口コミ | No | |
| Waiting list | No (UR has none online) | |
| Notifications | Email (free, signup); X posts | |
| Freshness | 最終更新 per 団地 (to the second); sitemap lastmod = build time | Changes are stamped at roughly 2-hour steps (…:34–:58 past 10, 12, 14, 16, 18 JST) per 団地, so checks look about every 2 h by day (inferred) |

**Unique to this site:** the room-level appear/disappear log with timestamps,
fill durations, watcher counts, and hour/weekday aggregates. Everything else
(rooms, rent, 設備, photos, plans) is UR's or JKK's data copied over.

## 7. Collector notes

- **Terms forbid scraping.** 利用規約 第4条 lists
  「スクレイピング、クローリング等の自動的なデータ収集行為」, and commercial use
  needs permission. robots.txt allows everything, but the terms are explicit.
  **Do not build a recurring collector against this site** without asking
  the operator (contact form `/contact`, or Shun on note/X). Manual,
  occasional reading for reference is the most I would do.
- If permission were given, the useful paths would be:
  1. `/ur/area/kanto/saitama/{id}` and `/ur/area/kanto/tokyo/{id}` for the
     ~25 埼玉 and 19 葛飾 団地 listed above, about 2 times a day. Read
     現在の空室 and 更新履歴 from the HTML. Merge history rows by
     (団地 id, 部屋, 更新日時, 変動); they come back in every load, so this is
     idempotent.
  2. `/ur/analytics/fill-speed?page=N` for the 30/90-day appear→fill pairs.
     The period switch is client-side, so its URL is unknown (unverified).
  3. Join to our UR collector by `shisya-danchi` → `shisya_danchi`, and by
     room label to UR's room rows.
- Pitfalls: the 48-row history cap; 「計24件」 is a cap, not a count; the hourly
  chart looks 6 h off; ~23–24 min fill times are polling artifacts; only
  1,372 団地 are covered (UR coverage in 埼玉 is partial; レイクタウン missing);
  `?_rsc=` flight responses are not a public API.
- Our own UR collector polling the official site would give the same signal
  (diffs over time). This site is mainly useful as evidence of what that
  signal looks like and how fast rooms fill.

## 8. Checked (2026-10-09)

31 page loads in total: robots.txt and `/ur` (round 1), sitemap ×2, `/ur/area/kanto/saitama`,
`/ur/area/kanto/tokyo`, 団地 `20-7090`, `50-4090` ×3 (map, flight-data probe,
history pager), `50-3880`, `50-1820`, `50-4020`, `20-3420`, `/ur/vacancy`,
`/ur/vacancy/count`, `/ur/recent`, `/ur/recent?page=8`, `/ur/analytics`,
`/fill-speed`, `/hourly` ×2, `/weekly`, `/jkk`, `/jkk/vacancy/count`,
`/jkk/area/katsushika`, `/jkk/area/katsushika/riverbreeze`,
`/jkk/area/hachioji/yokokawachou`, `/ur/terms`, two blog posts. Not opened:
`/signup`, `/contact`, `/guide/*`, `/ur/privacy`, the weekly SVG values, and
the 90-day toggle.
