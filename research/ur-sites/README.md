# UR rental data sites: map and source plan

Research only, no collector code yet. Mapped on **2026-10-09** in a headed
Playwright browser (one tab per site, 8–14 s between pages, about 290 page
loads across 20-odd sites). Nothing was fetched with curl or fetch; the few
JSON API reads were made from inside each site's own page. Discovery used web
search.

UR (独立行政法人都市再生機構) is the only landlord. Every other site copies its
public vacancy data, and some add things UR does not publish: **history**
(when a room appeared and disappeared, days to fill, past rents), coordinates,
rankings and reviews.

## Files

| File | Site | Kind |
| --- | --- | --- |
| [ur-net-official.md](ur-net-official.md) | www.ur-net.go.jp/chintai + API `chintai.r6.ur-net.go.jp/chintai/api/` | Official, the source of truth |
| [uralert.md](uralert.md) | uralert.jp (UR Alert) | Independent e-mail notifier with history stats |
| [ur-tsuchikun.md](ur-tsuchikun.md) | ur-tsuchikun.jp (UR通知くん) | Independent LINE notifier, map + rankings |
| [kuushitsu-info.md](kuushitsu-info.md) | kuushitsu-info.jp (空室情報.jp) | Independent tracker, UR + JKK東京, room-level history |
| [ur-aki.md](ur-aki.md) | www.ur-aki.jp (UR AKI) | LINE notifier + blog; no data pages |
| [ur-s-rakuchin.md](ur-s-rakuchin.md) | www.ur-s.jp (ラク賃不動産) | Broker; per-room vacancy history ("成約"), 口コミ |
| [hereur.md](hereur.md) | hereur.eunjay.com (Here UR) | Multilingual aggregator; coordinates, parking, postal codes |
| [other-sites.md](other-sites.md) | Whitestone sites (urjkkplus-ws.com …), k-royal.jp, SUUMO, HOME'S, ur.penpen-dev.com, swimple, GitHub watchers, X bots, open data | Brokers, portals, discovery |

## The join key

Every site worth using names a 団地 by **UR's own code**, so they can all be
joined without fuzzy matching:

```
50_4090            danchi ID = 支社 shisya (50 埼玉) + 団地 danchi (409) + 識別 shikibetu (0)
000010701          room JKSS (9 digits, unique within a danchi; NOT parseable into 棟/号室)
50_4090 + 000010701   room key (UR's own bookmark_key is 50_4090000010701)
```

| Site | Danchi ID as written | Room ID |
| --- | --- | --- |
| UR official | `/chintai/kanto/saitama/50_4090.html` | `50_4090_room.html?JKSS=000010701` |
| UR Alert | own UUID `/buildings/{uuid}`, but the page embeds UR's URL | JKSS (in the UR room link) |
| UR通知くん | `?u=/chintai/kanto/saitama/50_4090.html` | none (danchi level only) |
| 空室情報.jp | `/ur/area/kanto/saitama/50-4090` | none; 「1号棟701号室」 labels only |
| ラク賃 | `/kanto/saitama/50_4090/` | JKSS |
| Here UR | `/ja/complexes/kanto-saitama-50_4090/` | `50-409-0-000010701` |
| Whitestone sites | own ids; title `UR:50_2100`; ur-whitestone.com `/kanto/50_3880/` | own ids |
| ur.penpen-dev.com | UR room link | JKSS |
| k-royal, SUUMO, HOME'S | own ids only | own ids |

City codes: UR's `skcs` is the JIS city code without the prefecture
(草加 `221` = JIS 11221), which joins with `TARGET_CITIES.code`.

## Who has what

✓ = has it, ~ = partial or derived, blank = no.

| Information | UR official | UR Alert | 通知くん | 空室情報.jp | ラク賃 | Here UR |
| --- | --- | --- | --- | --- | --- | --- |
| Current vacant rooms (rent, 共益費, layout, ㎡, floor, 棟/号室) | ✓ source | ✓ | ~ count + rent range (metered) | ✓ | ✓ | ✓ |
| Floor plans, photos | ✓ | ✓ plans | | | ✓ plans | ~ |
| Coordinates | ✓ `map_marker` API | ~ disallowed API only | ✓ map JSON | | | ✓ |
| 戸数, structure, 管理年数 | ✓ | | ✓ ranking profiles | | ~ | ~ |
| Parking spaces + fees | ✓ | | | | | ✓ |
| Discount schemes (近居割, U35, すくすく割 …) | ✓ + pre-discount rent | ✓ | | | ✓ | ✓ |
| First-seen time of a vacancy | | ✓ `/listings` | | ✓ | ✓ `listed_from` | ~ snapshot time |
| Vacancy disappear history | | ~ aggregates | | ✓ last 48 events per danchi | ✓ full per room since 2026-04/05 | |
| Days on market / fill speed | | ✓ per building + `/trends` | ✓ hours to fill (top 50) | ✓ `/ur/analytics/fill-speed` | ✓ per room + per danchi | |
| Rent bands / rent history | ~ prefecture average today | ✓ min/median/max per layout | | | ~ rent per history row | |
| Rankings | ✓ popularity | ✓ | ✓ | ✓ fastest-filling | ✓ | |
| 口コミ / reviews | | | | | ✓ 7 categories (few) | |
| Waiting list / alerts | e-mail for 子育て/若者夫婦 only | e-mail | LINE | e-mail | e-mail / LINE | |
| Freshness | 「前日以前の状況」, daily | crawls 8:30–17:30 | every 30 min, 9:00–1:00 | about every 2 h by day | lastmod per page | snapshot time shown |
| Server-rendered data | API (POST, JSON) | Next.js flight JSON | JSON API | HTML | Next.js flight JSON | `vike_pageContext` JSON |
| Terms on reuse | no republishing without permission (private use OK) | no commercial use or resale | no reposting, no reverse engineering, may ban automated use | **scraping/crawling forbidden** (第4条) | no terms page found | no terms page found |

Nobody has true contract (成約) records. Every "成約" or "fill" figure is
**the moment a vacancy disappeared from UR's site**, measured by each tracker's
own polling interval. A room that returns after a cancelled 仮申込 shows up as a
second fill. Treat days-on-market as an upper bound on demand, not a fact.

## Our area (2026-10-09)

All sites agree on the set of 団地 (UR official, UR Alert, 通知くん, ラク賃):

| City | UR `skcs` | 団地 | Vacant rooms (UR official, that day) |
| --- | --- | --- | --- |
| 草加市 | 221 | 5: コンフォール松原 `50_4090`, ハーモネスタワー松原 `50_3880`, コンフォール草加 `50_3910`, 草加旭町 `50_1340`, グリーンアベニュー谷塚 `50_2610` | 1 (コンフォール松原 1号棟701, 2DK ¥108,400) |
| 越谷市 | 222 | 3: せんげん台パークタウン三番街 `50_2180` / 四番街 `50_2070`, ペアハイツ越谷 `50_2300` | 0 |
| 川口市 | 203 | 16 (川口芝園 `50_1820`, コンフォール東鳩ヶ谷 `50_4020` …) | 6 |
| 八潮市 | 234 | 1: 八潮 `50_1390` | 0 |
| 葛飾区 | 122 | 20 (エステート東新小岩 `20_3420`, 金町駅前 `20_1650` …) | 1 |

There is **no UR 団地 in 越谷レイクタウン** on any site. 吉川 `50_1551` (next to
越谷) is the nearest extra candidate. Full lists are in each site doc.

## Recommendation for a later collector

1. **Primary: UR official, our own daily snapshots.** One headed-browser page
   per prefecture, then the page's own API calls: `bukken_result` per city →
   `detail_bukken_room` for 団地 with vacancies → `detail_room` for new JKSS;
   `map_marker` once for coordinates. About 5 list calls plus a few per vacant
   room a day for our area. Storing every daily observation gives us our own
   first-seen / gone history, which is exactly what the trackers sell and
   fits the additive property store. Details:
   [ur-net-official.md §10](ur-net-official.md).
2. **Backfill history (optional, one-off): ラク賃.** Its danchi pages embed
   `pastListings[]` (jkss, rent, listed_from, listed_until, listing_days) back
   to about 2026-05-29 for Kanto: 45 pages cover all of our area. No terms page
   is linked; read once, merge rows per (jkss, listed_from). See
   [ur-s-rakuchin.md §8](ur-s-rakuchin.md).
3. **Reference only, do not collect:** UR Alert's rent bands and fill-speed
   stats and 通知くん's 戸数 and hours-to-fill. Their terms forbid reuse, and
   our own snapshots will produce the same figures over time. 空室情報.jp
   explicitly forbids scraping.
4. **Skip:** UR AKI (no data pages), k-royal (Kanagawa only), SUUMO/HOME'S UR
   ads (no UR codes; SUUMO's UR ads already arrive through the existing
   collector, named 「ＵＲ…」), Whitestone sites (undated "成約" tables only).
5. **Join existing listings:** the 27 UR ads already in `data/listings_raw.json`
   (SUUMO 11, AtHome/Nifty 16) carry no UR codes. Match them to a 団地 by
   name/address, then to a room by 棟/号室 + layout + area.

Before building on any of these (UR's API included), check whether the
internal **External Service Review** applies: none of these services is used
in the codebase today.

## Open questions

- Does a room keep the same JKSS when it is advertised again? (Likely, unverified.)
- Which 11 埼玉 団地 are 空室情報お届けサービス targets (their new rooms are
  reserved for target households for 3 business days)?
- The API host's own robots.txt was not checked.
