# UR AKI (www.ur-aki.jp): LINE vacancy notifier

Mapped on **2026-10-09** in a headed Playwright browser, one tab, 8–14 s between
pages, 24 page loads (robots, home, both sitemaps, every fixed page, the blog
index, 2 area hubs, 5 posts, and 4 probes of URLs found by search). Nothing was
fetched with curl or fetch.

## 1. What it is

- **Independent notifier, not official.** It calls itself 「独立系の第三者サービス」
  and says it has no tie or approval from UR. It started in 2025 (terms
  制定日 2025-06-01). Contact: `support@ur-aki.jp`, LINE `@757mugsx`
  (`lin.ee/yWlCUdw`). No company or person is named. Columns are signed
  「UR AKI 編集部」.
- **Japanese only.** Built with Astro (`/_astro/ClientRouter…js`). GA4 and AdSense.
- **How it works:** you add the LINE account and send `物件名[:間取り&間取り]`,
  for example `恵比寿ビュータワー:2LDK&3LDK`. The name must match UR's official
  spelling. It checks UR's public site **once a day** (「空室情報を1日1回確認」)
  and sends **one LINE message per room**: room name, layout, floor, ㎡, rent,
  共益費, and links to UR's room and 団地 pages. After one notification the
  watch is removed automatically. Rooms already sent are never sent again.
- **Limits:** 1 property per person and **at most 1 notification per month**
  (「運営コストの都合」). Covers 14 prefectures: 東京 神奈川 埼玉 千葉 茨城 大阪 京都
  兵庫 奈良 愛知 福岡 北海道 広島 宮城.
- **Paid "応援" is suspended.** `/pricing` redirects to `/support`
  (「応援の受付状況」). It says 「現在、応援（監視枠の追加）の受付を停止しております」.
  Existing 応援 slots stay valid until they expire, and the free tier stays at
  1 property. From search snippets of older pages (not loaded): 応援 was a
  one-off payment of ¥100 per extra slot for 40 days, up to 6 properties; an
  earlier FAQ described ¥100/month per slot via Stripe with up to 3
  notifications. The JSON-LD now lists only 「無料プラン」 (price 0).

## 2. robots.txt and sitemaps

```
User-agent: *
Allow: /
Sitemap: https://www.ur-aki.jp/sitemap-index.xml
```

`/sitemap-index.xml` → one child, `/sitemap-0.xml`, with **77 URLs** and no
`<lastmod>`:

| Group | URLs |
| --- | --- |
| Blog posts `/blog/{slug}/` | 57 |
| Blog area hubs `/blog/area/{pref}/` | 8 (aichi chiba fukuoka hyogo kanagawa osaka saitama tokyo) |
| Blog category hubs `/blog/category/{akimachi,area,move-in,service}/` | 4 |
| Fixed pages | `/`, `/about/`, `/blog/`, `/editorial-policy/`, `/faq/`, `/guide/`, `/privacy-policy/`, `/terms/` |

**There are no property or vacancy pages.** Search results still list
`/subscribe/` 「物件を検索して通知登録」 and `/kansai/` 「関西地方のUR賃貸空き状況」.
Both now return **404** 「ページが見つかりません」, and so does `/kanto/`. They
existed earlier and have been removed. The guide still mentions a
「物件検索ページ」, but nothing links to one.

## 3. URL hierarchy

```
/                         landing (how it works, 14 prefectures, LINE button)
├ /guide                  usage, command list, layouts accepted
├ /faq                    accordion FAQ (answers in the HTML, collapsed)
├ /support                応援 status (/pricing redirects here)
├ /about, /editorial-policy, /terms, /privacy-policy
└ /blog/                  「UR賃貸お役立ちコラム」 57 posts
  ├ /blog/category/{area|move-in|akimachi|service}/   46 / 9 / 1 / 1 posts
  ├ /blog/area/{pref}/     埼玉5 千葉5 東京26 神奈川4 愛知1 大阪2 兵庫1 福岡1
  └ /blog/{slug}/          団地 essays and guides
```

Our area: `/blog/area/saitama/` lists 5 posts: `confouru-soka` (コンフォール草加),
`confouru-matsubara` (コンフォール松原), `harmoness-tower-matsubara`,
`tokorozawa-parktown`, `asaka-hamasaki`. None for 越谷 or 川口. `/blog/area/tokyo/`
(26 posts) has nothing in 葛飾区. The nearest is `parktown-higashi-ayase` (足立区).

## 4. Identifiers

- **No public ID of its own.** Posts use romaji slugs (`confouru-soka`,
  `harmoness-tower-matsubara`). Watches are keyed by the **UR 団地 name text**
  the user types, matched against UR's spelling.
- **UR codes appear only as outbound links:** each 団地 post links to
  `https://www.ur-net.go.jp/chintai/kanto/saitama/50_3910.html` (コンフォール草加),
  `…/50_3880.html` plus `_report.html` and `_map.html` (ハーモネスタワー松原).
  Map the slug to UR's `shisya_danchi` by reading that link. The notification
  example shows UR's room label (`E-305`) and links to UR's room page, so the
  backend holds UR room keys, but the website does not publish them.

## 5. Page anatomy

All pages are static HTML (Astro). There are no XHRs except GA and ads.
JSON-LD: `WebApplication` (with `offers`) on every page; `BlogPosting` (published and modified
dates, author 「UR AKI 編集部」), `BreadcrumbList` and `CollectionPage` on blog pages.

### 団地 post (`/blog/confouru-soka/`, `/blog/confouru-matsubara/`)
- 物件概要 box: 所在地, 最寄り駅, 竣工, 総戸数, 間取り, 家賃帯, おすすめ. For example
  コンフォール松原: 草加市松原1〜5丁目, 獨協大学前〈草加松原〉徒歩2〜7分, 2002〜2020
  建替, about 3,050戸 in 30棟, 1K〜3LDK, ¥70,100〜140,800 + 共益費 about ¥3,500.
- Long text: history, transport times, shopping, school district, hospitals, safety.
- **「募集住戸の観測データ（YYYY年M月〜YYYY年M月）」**: the site's own
  observations of rooms UR advertised, grouped by layout: 観測戸数, 家賃レンジ,
  中央値, 平均専有面積, with a range chart. コンフォール松原 (Jul–Aug 2026, 7
  rooms): 1K ¥81,300 37㎡; 1DK ×4 ¥88,600〜93,200, median ¥93,050, 44㎡;
  2LDK ¥118,100 56㎡; 3LDK ¥137,300 71㎡. コンフォール草加 (Jun 2026, 3 rooms):
  1LDK ×2 ¥127,300〜135,800, 63.5㎡; 2LDK ¥148,600, 70㎡. ハーモネスタワー松原 has no such block.
- Links to UR's official 団地 pages.

### Monthly rent article (`/blog/ur-chintai-yachin-soba-2026-07/`, and `ur-chintai-yachin-soba` for June)
Aggregates of the rooms it saw on UR's site that month (Jul 2026: about 230
rooms in 133 団地; Jun: about 180). Overall median about ¥106k. By layout:
average, median, ㎡, ¥/㎡ (2DK median about ¥81k, 47㎡; 3LDK about ¥122k, 76㎡).
By prefecture: 埼玉 median about ¥93k, 52㎡, 27 rooms. It also compares with
the previous month and explains changes in area mix. The figures are rounded
in prose; there is no table to download.

## 6. Information inventory

| Item | Here? | Notes |
| --- | --- | --- |
| Current vacancies | **No** (web) | Only through the LINE push, once a day, 1 property, 1 message a month |
| Rent / 共益費 / layout / ㎡ / floor | Only in the LINE message, and as monthly aggregates | |
| Floor plans, photos, coordinates | No | Points to UR |
| Stations, building age, 総戸数 | In 団地 posts (prose plus a summary box) | 26 posts in 東京, 5 in 埼玉 |
| Vacancy history / days on market | No | Rooms are recorded internally (to avoid repeat alerts) but not published |
| Observed rents | **Yes**, per 団地 post (a few rooms, by layout) and monthly market aggregates | The only data of its own |
| Statistics / rankings | Monthly 家賃相場 posts only | |
| Reviews | Paraphrased public 口コミ in posts, marked as such | |
| Waiting list | Explains UR's in-store 「空き待ち」 registration (`/blog/ur-akimachi-touroku-toha/`) | |
| Freshness | Posts show 公開 / 最終更新 dates; the sitemap has no lastmod | |

**Unique:** small per-団地 observed rent samples and the monthly market
summaries. Everything else is editorial or a copy of UR's facts. Its editorial
policy says it will not publish counts it cannot support, such as how many
people are waiting.

## 7. Collector notes

- **Low value for a collector.** There are no listing or vacancy pages to read.
  The one data feed (LINE) requires adding a friend, which we will not do. It
  is also limited to 1 property, a daily check and 1 message a month.
- At most, read the 5 埼玉 団地 posts and the monthly 家賃相場 post now and then
  as context, or to cross-check observed rents for コンフォール松原 / 草加. The
  link inside each post gives the UR `shisya_danchi` key.
- Terms 第4条 forbid commercial use of information obtained from the service
  (「本サービスによって得られた情報を商業的に利用する行為」). There is no explicit
  anti-scraping clause, unlike 空室情報.jp, and robots.txt allows everything.
  Our use is personal and occasional; keep it to a few page loads.
- The pages and plans change often (`/subscribe/` and `/kansai/` removed, 応援
  stopped, pricing changed). Re-check before relying on any path.

## 8. Checked (2026-10-09)

24 page loads: robots.txt, `/` (round 1); `/sitemap-index.xml`, `/sitemap-0.xml`;
`/guide`, `/faq` ×2 (second load read the collapsed answers), `/about`, `/terms`,
`/editorial-policy`, `/privacy-policy/`; `/blog/`, `/blog/area/saitama/`,
`/blog/area/tokyo/`, `/blog/category/service/`; posts `confouru-soka`,
`confouru-matsubara`, `harmoness-tower-matsubara`, `ur-akimachi-touroku-toha`,
`ur-chintai-yachin-soba-2026-07`; probes `/subscribe/` (404), `/pricing`
(→ `/support`), `/kansai/` (404), `/kanto/` (404). LINE was not added.
