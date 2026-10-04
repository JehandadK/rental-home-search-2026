# Soka Rental Scorer — 草加市・越谷市・川口市賃貸スコアラー

A weighted scoring tool for comparing rental homes in **Soka City**,
**Koshigaya City**, and nearby **Kawaguchi City**, Saitama, Japan. Kawaguchi's
eastern/northern neighbourhoods can be close to Al Sanad School. Koshigaya's
southern wards (蒲生・新越谷) and the 北越谷 area sit close to both POIs and
offer strong rent/size options, so all three cities are searched. **Katsushika
Ward** (葛飾区, Tokyo), just south of Yashio and Misato, is searched as well.
Cities live in `src/collectors/shared/targetCities.ts`.

Every listing is scored 0–100 across numeric proximity/cost/size parameters
plus any qualitative property features the user chooses. Every captured source
feature is retained and presented with English + Japanese labels; each feature
has an independent user-adjustable weight (0 means display but do not score),
and can prefer either Yes or No. Unknown is never silently treated as No.

Built with **React 19 + TypeScript + Vite**. No backend — reference data and
listings are static JSON, geocoding and enrichment happen offline via scripts.

**Refresh operations:** see [REFRESH.md](REFRESH.md) for the current bounded,
checkpointed workflow and the latest recovery results. Numeric examples below
include historical dataset snapshots, not live inventory guarantees.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit tests for the scoring engine and geo math
npm run build      # data:web + typecheck + production build + release check → dist/
npm run rank       # print the current top listings in the terminal
npm run rank -- -n 30
```

## Static site

The dashboard needs no server. `npm run build` writes a self-contained static
site to `dist/`, and `npm run check:release` (the last build step) refuses to
pass anything else:

| Path | What it is | Changes when |
| --- | --- | --- |
| `index.html` | The page | the app changes |
| `assets/` | The app bundle (hashed JS and CSS, no theme colours) | the app changes |
| `themes/default.css` | The theme: the interface and map colours, the page font, the radius | the look changes |
| `data/` | `listings.json` and `reference.json` | data is committed |

Upload `dist/` as-is to any static host. Every URL is relative, so it works
from a domain root or a sub-path (`https://example.com/rentals/`) with no
rebuild. Serve a sub-path with its trailing slash (or redirect to it): from
`/rentals` without one, the browser resolves `./assets/` against the domain
root.

- **Data** stays in Git: refresh, commit `data/`, and rebuild. The page
  revalidates its JSON on every load, so a redeploy shows up without cache
  busting.
- **Your marks, notes, compare list, presets and custom listings** stay in the
  visitor's browser (`localStorage`). They are never uploaded, and they do not
  follow you to another browser or device.
- **Theme**: `index.html` links `themes/default.css` separately from the app.
  To match a host site, replace that file, or define the same `--rs-*`
  properties in the host's own stylesheet. The file lists them all, with the
  core ones first. The red → green score scale is not themed: it encodes the
  score itself (`scoreColor` in `src/domain/scoring.ts`).
- **Sharing a page with a host stylesheet**: the app's styles are scoped to
  `.rs-app` and never reach the host's elements. Inside it, a host's bare
  element rules (`body {…}`, `button {…}`, `* {…}`) are reset. Stronger host
  selectors (`a:hover`, `input[type=checkbox]`, ids, a full reset such as
  Bootstrap Reboot) can still reach in, so share the host's theme properties
  with this page rather than its whole stylesheet.
- **Outside requests**: listing photos load straight from the portals, and the
  map links open Google Maps. Nothing else leaves the page.

## Numeric and qualitative scoring parameters

| Parameter | Default weight | Logic |
|---|---|---|
| Rent (incl. 管理費) | 7 | ¥50,000 or less → 100; ¥200,000+ → 0 |
| **Value — rent/exclusive area** | **10** | **≤¥1,200/㎡/mo → 100; ≥¥2,800/㎡/mo → 0** |
| Move-in cost (初期費用) | 4 | **sunk** cost in months of rent: ≤2 → 100; ≥6 → 0 |
| Size | 5 | 70 ㎡+ → 100; 18 ㎡ or less → 0 |
| Year built | 3 | new → 100; 45 years old → 0 |
| POI 1 — Al Sanad School Japan (原町2-3-1) | 8 | doorstep → 100; 12 min walk → 0 |
| Nearest mosque / masjid / musalla | 8 | Nearest of Baitul Aman, Baitul Aqsa, Mizumoto Musalla, Yashio Masjid, Yashio Gujarati Masjid, etc.; doorstep → 100; 12 min → 0 |
| Nearest station | 9 | doorstep → 100; 20 min walk → 0 |
| Nearest bus stop | 4 | doorstep → 100; 10 min walk → 0 |
| Nearest kindergarten | 6 | doorstep → 100; 15 min walk → 0 |
| Nearest elementary school (市立小学校) | 6 | doorstep → 100; 15 min walk → 0 |

The high-weight **Value · Rent/㎡** criterion divides monthly rent including
management fees by exclusive-use floor area. It highlights genuinely spacious,
good-value homes rather than merely cheap small apartments. Parking is included
in the numerator when “Add parking to rent” is enabled.

All anchors ("12 min = zero", "¥50k = perfect", …) and weights are adjustable
live in the UI; missing data simply removes that parameter's weight from the
average. A **Property features & lease terms** section exposes parking, bathroom,
comfort, kitchen, connectivity, security, storage, building and tenancy
features (e.g. free internet, city gas, pets, parcel box, fixed-term lease).
Each is bilingual, can prefer Yes/No, and defaults to weight 0 so existing scores
do not change until the user opts in. Unmapped portal details are still stored
under **Other source details**. A **保育園 toggle** optionally counts daycares
towards kindergarten. Settings persist in `localStorage`.

### Parking (駐車場)

In Saitama a car space is billed **separately from rent**, so it is tracked as
its own recurring cost. SUUMO's search pages omit it, so
optional `npm run detail:enrich -- --limit 10` selects relevant cross-source-unique
units, caches each detail page, and parses all useful details together, including the
駐車場 row (`敷地兽6600円`, `近隣143m9592円`, `敷地内無料`, `空無`, `-`).

In the current dataset (492 of 661 listings have parking data):

| | Count |
|---|---|
| Space available | **324** (222 on-site, 63 nearby) |
| — of which **free** | **39** |
| — of which paid | 285 — **¥1,100–19,800/mo, median ¥8,000** |
| No space available | 168 |

At the median that is **¥96,000 a year** on top of rent. Tick **"Add parking
to rent"** in the Weights panel and the rent criterion scores
`rent + parking` instead — the honest comparison if you keep a car. The
Filters panel adds **any / must have / free only** plus a max ¥/month cap.
Listings that never stated their parking are never silently dropped by these
filters.

The effect is real: コート　ボヌール charges **¥21,000/month** (¥252,000/yr)
for parking and falls ~78 places in the ranking once it is counted.

### Move-in costs — and what you never get back

Japanese move-in money is not one number, because only part of it is ever
refunded. The scorer therefore penalises **sunk cost**, not headline cash:

| Component | Returned? | Treatment |
|---|---|---|
| **敷金 deposit** | **Partly** — refunded at move-out minus 原状回復 (restoration) | Only the assumed loss (default **30%**) counts as sunk |
| **礼金 key money** | **Never** — a gift to the landlord | 100% sunk |
| **清掃費 cleaning fee** | **Never** — charged upfront or deducted from the 敷金 | 100% sunk |
| 仲介手数料 agency fee | Never (≈1.1 months incl. tax) | 100% sunk |
| 保証会社 guarantor fee | Never (≈0.5 months) | 100% sunk |
| 火災保険 fire insurance | Never (≈¥20,000) | 100% sunk |
| First month’s rent | — | Counted in the upfront total, **excluded** from sunk cost (it buys a month of housing) |

This is what makes the comparison honest: **a ¥200k deposit is far cheaper
than ¥100k of key money**, even though the deposit is the bigger cheque.

Real figures are scraped from SUUMO (`敷金`/`礼金` columns) — in the current
dataset **60% of listings are 礼金ゼロ and 145 are ゼロゼロ物件** (neither
deposit nor key money). Anything the ad omits is estimated from the
assumptions above and clearly marked `est.` in the UI. Cleaning fees are
rarely printed, so they default to ¥1,200/㎡ (min ¥30,000).

Sunk cost is normalised **in months of rent** so cheap and expensive flats
compare fairly, and every assumption (deposit loss %, cleaning ¥/㎡, agency
months) is adjustable live in the Weights panel. Expanding a table row shows
the full breakdown: what you pay, what is gone, and what you should get back.

A real example from the data — two houses at **identical ¥149,000 rent**:

| | Sunk cost | 礼金 | Move-in score |
|---|---|---|---|
| 草加市西町戸建 | ¥352,048 | ¥0 | **90** |
| 八幡町戸建て | ¥678,184 | ¥144,000 | **35** |

### Choosing which places count

Every listing is measured against **every** reference place (536 listings ×
1,182 places ≈ 634k distances) in the browser at load time — about 90 ms to
build the index, then **2–3 ms** to re-score everything when a choice changes.

That means the **Places** panel is pure selection, never a pipeline re-run:

- **Al Sanad POI** — fixed/curated school target.
- **Nearest mosque** — automatically uses the nearest mosque, masjid or musalla from the catalog; optionally restrict it to a trusted subset.
- **Station** — "nearest of all", or restrict it to the stations you would
  really commute from (e.g. only 獨協大学前〈草加松原〉).
- **Elementary school / childcare / bus stop** — same: keep all, or hand-pick
  a shortlist (e.g. only the 42 幼稚園, excluding 保育園).

Selections persist in `localStorage`. When you narrow the station set, the
scorer stops trusting the advertised 徒歩分 if the ad refers to a *different*
station than the one being measured, and falls back to the coordinate
estimate — otherwise the score would describe the wrong walk.

### Travel mode: walk vs bicycle

A **🚶 Walk / 🚲 Bicycle** toggle at the top of the Weights panel decides how
distances become minutes (80 m/min vs 250 m/min, both × the detour factor).
This matters enormously here: on foot, 98% of listings score **zero** on both
POI criteria, so the two heaviest-weighted parameters decide nothing. By
bicycle — how most Soka families actually do the school and mosque run — the
POIs become the deciding factor and the ranking changes completely:

| | Top result on foot | Top result by bicycle |
|---|---|---|
| Listing | 島根テラス (北越谷) | グリーンパークIII (新田) |
| Al Sanad | 102 min | **4 min** |
| Masjid | 69 min | **7 min** |
| Score | 53.3 | 72.2 |

The advertised station 徒歩分 is rescaled to the selected mode so every
parameter stays comparable.

### Criteria that decide nothing

A weighted criterion whose score is identical for nearly every listing
consumes weight without separating anything — it silently inflates the other
parameters. The Weights panel detects this over the **currently filtered** set
and shows:

- a ⚠ badge on the offending parameter, with the share of listings stuck at
  0 (or 100),
- a **Fit anchors to data** button that moves each flagged anchor to the 75th
  percentile of the observed values, so the criterion starts discriminating.

### Filters

The **Filters** panel narrows the listing set before scoring/ranking:

- **Area (町名)** — the headline filter: pick neighbourhoods and switch between
  **include** (keep only those areas) and **exclude** (drop those areas). Areas
  are derived from each address's 町名 (prefecture/city and block numbers
  stripped); there are 86 across the two cities.
- **City** — Soka / Koshigaya chips.
- **Rent** and **Size** — min/max bounds.
- **Rooms** — layout-family chips (2+, 3+, …).
- **Min score** — a 0–100 slider gating on the current weighted score.

Filters persist in `localStorage`; the map, table, count line and CSV/Markdown
exports all reflect the filtered set live.

### Map ↔ table linking

The map draws the areas you choose, by default the search area (Soka,
Koshigaya, Kawaguchi, Yashio and Adachi): their municipal outlines (dashed),
prefecture borders (solid), Soka emphasised, their rail stations, and every
listing as a score-coloured dot. **⚙ Areas** (bottom-left) opens the area
picker: a small overview map of Kanto where clicking a municipality shows or
hides it, a checkbox list by prefecture (a prefecture's box takes all its
cities), search, *Search area* / *All* / *None*, and an **EN / 日本語** switch
for city, prefecture and scored-station names (the region's other stations are
named in Japanese only). The choice is remembered in the browser. Names appear
as you zoom in and never overlap. Only the 20 scored stations around the search
area count for the station score; the others are map context. **Hovering a dot
highlights the matching table row; clicking a dot pins it and scrolls that row
into view; hovering a table row highlights its dot on the map.** Hovering also shows a
preview card with the home's photo, rent, layout and score. Scroll to zoom, drag
to pan, use +/− to zoom, ◎ to fit the listings currently shown, and ⤢ to show
all the chosen areas.
The chips at the top toggle stations, schools, mosques and the green "new"
rings; the legend holds the score scale and a distance scale bar. The map keeps
true proportions (longitude is scaled by cos latitude).

### Photos

Listings show a thumbnail in the table, a gallery (exterior 外観, photo 写真,
floor plan 間取り) in the expanded row, and a photo in the map's hover and
pinned cards. Only image URLs are kept; the pictures stay on the portals and the
browser loads them when shown.

- **SUUMO:** nothing is stored. SUUMO builds its image paths from the `bc=`
  property code already in every ad URL, so `src/domain/listingPhotos.ts`
  derives them.
- **AtHome, Nifty, RoomSpot:** their ad URLs carry no image path, so each
  collector keeps the picture URLs its result page showed in `listing.photos`
  (at most four, cleaned by `src/collectors/shared/photos.ts`: spinners and
  "no image" art dropped, athome thumbnails asked for at gallery size).
  Captures made before this existed have no pictures, so these listings gain
  photos as they are refreshed. A refresh whose page shows none keeps the
  earlier ones, and cross-listed rooms keep every portal's pictures.

Photos a portal does not have (a load error or a ≤100×100 "no image"
placeholder) are skipped in favour of the next picture, then a house icon.

Walking minutes are estimated as `straight-line distance × 1.3 detour ÷ 80 m/min`
(the 徒歩分 convention). For stations, the agent-listed 徒歩分 from SUUMO is
preferred when available, since it reflects the real route.

## Data

Persisted data lives in `data/` (`DATA_DIR` in `src/node/dataPaths.ts` is the only
place that knows). The web app never imports it: `npm run data:web` publishes
the two files the browser fetches into `public/data/` (below).

| File | Contents | Source |
|---|---|---|
| `reference/v1/` | Managed reference catalog: versioned cities, boundaries, and places (private schools, mosques, stations, schools, childcare, bus stops), originally from OpenStreetMap and curated map pins; Kanto municipalities, boundaries and rail stations (`railStation`, map only) from MLIT 国土数値情報 N03/N02 | Revisioned updates through `JsonReferenceDataRepository`; `npm run data:reference:app-ids` after adding places; `npm run data:reference:ksj -- --n03 <dir> --n02 <N02-xx_Station.geojson> --names <総務省 code.xlsx>` to import a new N03/N02 edition with English names; `npm run data:reference:masjids` to add the saved Google Maps masjid list (`reference/imports/`) to the scored mosques |
| `sources/suumo.json` | SUUMO family rentals (2K+) | `npm run scrape` |
| `sources/athome.json` | AtHome family rentals (2K+), including move-in money and amenity flags | `npm run scrape:athome` |
| `sources/roomspot.json` | RoomSpot/POLUS family rentals (2K+), including exact addresses and move-in money | `npm run scrape:roomspot` |
| `sources/nifty.json` | Nifty list-page rentals + cached historical detail enrichment | `npm run crawl:nifty` / `npm run import:nifty` |
| `sources/yahoo.json` | User-selected Yahoo! Real Estate detail listings, retained across rebuilds | Native-browser detail extraction; no automatic market crawl |
| `listings_raw.json` | Cross-source merged/deduplicated listings | `npm run data:build` |
| `listings.json` | Full archival data, geocoded + enriched with baked nearest places | `npm run enrich` |
| `availability.json` | Every ad-page check (listed / gone), newest per ad plus its full `history` | `npm run check:availability` |
| `properties/<id>.json` | One additive document per property: every value each portal reported (conflicts kept side by side, plus the value shown), every sighting, every check and lifecycle event, and a derived summary (first seen and where, last seen, off-market window, days on market, portal posting dates) | `npm run data:properties` (run by `data:build`, `check:availability`, `data:journal:compact`); `npm run data:properties:backfill` replays git history and backups |

Property documents are the analysis record: they only ever grow. A value that
changes (rent, fees, address spelling) is added beside the earlier one with
the portal and the capture times that reported it; `chosen` is the latest one
and is what a view should show. Events (`ad.checked`, `lifecycle.status`,
`ad.superseded`, `property.merged`) are appended once and never edited, so a
re-listing never erases the earlier sold or gone time. See
`src/domain/propertyDocument.ts` for the schema; readers must ignore fields
they do not know.

The catalog pins the id the app shows for each place (`attributes.appPlaceId`), so saved
place selections survive added and retired places. The original per-category JSON
files it was migrated from were retired after M5 (see `DATA_ARCHITECTURE.md`).

Published for the browser (`public/data/`, served by Vite and copied into `dist/`):

| File | Contents | Source |
|---|---|---|
| `listings.json` | Compact browser payload (redundant proximities/audit text removed) | `npm run data:web` |
| `reference.json` | Snapshot of the managed reference catalog | `npm run data:web` |

The app loads both at startup, with loading, error/retry, and stale-copy states.

### User-selected Yahoo! Real Estate listings

`data/sources/yahoo.json` stores individually requested Yahoo listings as
an independent source, so ordinary refreshes cannot erase them. Public detail
captures are retained in `data/.captures/yahoo/`; email/tracking parameters
are removed from the saved listing URLs. These are partial observations, not a
complete Yahoo market snapshot or an automated Yahoo collector.

The first import is **グランコート草加**, 1st floor, 3LDK, 70.72㎡, ¥85,000/month
including management, with optional ¥11,000/month parking. It matches the
existing Nifty and SUUMO first-floor listings, so the dashboard retains one
property row with all three source links. The separate third-floor unit remains
separate; unknown-floor adverts cannot bridge conflicting known floors. The
advertised 草加 station connection is bus 15 minutes plus a 6-minute walk from
the bus stop—not a 6-minute walk from the station. Unknown cleaning fees and
lease type remain unknown; alternative guarantor fees are kept verbatim.

### Refreshing listings

```bash
# Inspect the request budget without any writes or network.
npm run refresh -- --plan

# Human CLI: bounded source discovery, then one derived-data rebuild.
# Optional detail requests default to zero; add --detail-limit 10 to opt in.
npm run refresh
npm run find:new -- --min-score 45 --max-rent 150000 --min-size 40

# Less frequent wider discovery (more pages, still preserves unseen history).
npm run refresh -- --deep

# Add --verbose only when diagnosing a collector; normal refresh output is a
# small per-source summary to avoid wasting terminal/model tokens.
npm run refresh -- --verbose

# Inspect durable run history and resume the first unfinished stage. The
# aliases below are equivalent to `npm run refresh -- --resume`.
npm run refresh:status
npm run refresh:resume

# Exclude RoomSpot collection for this run (and its later resumes).
# Existing RoomSpot source data is preserved in the merged dashboard.
npm run refresh -- --skip-roomspot

# Agent/native-browser workflow: prepare a checkpoint without starting collectors.
# Add --skip-roomspot here too when that portal should not be collected.
npm run refresh -- --prepare
# Use native browser tools to capture public list cards, then:
npm run capture:import -- --file <capture.json>
npm run refresh -- --resume --local-only

# Wider discovery is non-destructive. --full is currently rejected because
# configured page caps cannot prove complete per-city market coverage.
```

`npm run scrape` (SUUMO), `npm run scrape:athome` (AtHome), and
`npm run scrape:roomspot` (RoomSpot/POLUS) are incremental by default: they ask
for **newest-first** results, merge them into their source snapshots, and never
remove unseen old records (a partial crawl cannot prove a listing is sold).
`npm run scrape:all` runs all three. They use source IDs plus
normalized property/market identities to absorb rent changes, duplicate agency
adverts and cross-portal overlap gracefully. `--deep` scans every configured
newest-first page without early stopping; `--max-pages N` bounds a diagnostic
run. `--full` is currently rejected until collectors can positively verify per-city
exhaustion; page limits never authorize SOLD reconciliation. See REFRESH.md.

AtHome's public pages use browser verification, so its collector reads the
public search-result HTML through the local Pi Control Chrome Bridge and the
site's own list endpoint. It opens **the AtHome homepage first**, waits for it to
load, then navigates the same tab to the requested search; it never cold-opens
that tab at a deep results URL. Navigation and capture requests are bounded,
with no automatic retries on a blocked/uncertain page. Run `/chrome connect`
first if needed. It captures
rent + management fee, layout, area, build year, deposit, key money, station
walk time, parking availability, pet/instant-move-in and other visible amenity
flags without crawling every detail page.

Incremental collectors continue newest-first until they cross the previous
observation boundary (two consecutive all-known pages). A generous emergency
ceiling prevents runaway pagination; `--max-pages N` is an explicit cap and can
miss new listings when set too low.

`npm run find:new` ranks only active listings first seen in the last 14 days.
Optional hard gates: `--min-score`, `--max-rent`, `--min-size`, `--parking
any|required|free`, `--bike`, and `-n`/`--limit`.

A full refresh reconciles against the previous build (tracked by
name+address+size, so a rent change is an update, not a new listing):

- **New listings** get `firstSeenAt` and are highlighted in the UI for **14
  days** — green `NEW` badge in the table, green halo on the map, and a
  **✦ new only** chip in the Filters panel.
- **Listings that vanish** from every source are **kept and marked `SOLD`**,
  never deleted: dimmed row + grey badge in the table, grey dot on the map.
  The Filters panel's **Status** chips (all / active only / sold only)
  control their visibility; `soldAt` records when they left the market.
  If a sold listing is re-advertised it becomes active again and keeps its
  original `firstSeenAt`.

Refresh and loading are kept cheap: `npm run refresh` orchestrates all sources
and emits only a compact summary; portal collectors stop after two all-known
pages when newest-first sorting is confirmed. Nifty now parses family units and
parking/amenity flags directly from list cards, so discovery needs no detail
requests. Browser captures are replayable locally; only summaries reach the model. Every invocation is checkpointed in
`data/refresh-runs.json` with start/completion times, durations, attempts,
per-stage status and discoveries, pre/post totals, net unique additions after
deduplication, duplicate counts, and lifecycle results. A process lock prevents
two refreshes from corrupting each other's checkpoints. If a portal fails its
last atomic source snapshot remains available, downstream data is rebuilt and
the command exits with status 2; `npm run refresh:resume` retries failed stages and their dependents, preserving successful independent
collectors even when they appear later in the pipeline. A mandatory build
stage failure stops immediately and is resumed the same way. `scrape.ts` carries parking data forward,
`enrich.ts` durably caches geocodes by normalized address (`--regeocode` to distrust), and `npm run data:web`
creates the compact dashboard payload with dictionary-encoded bilingual attributes. The browser recomputes distances from
coordinates, so baked nearest-place objects are not shipped twice. The table
renders 100 rows initially and loads more on demand; non-score filters run
before scoring. `npm run build` regenerates web data automatically.

`backfill:parking` is now a compatibility alias for `detail:enrich`. The optional
stage selects relevant deduplicated units (default rent <=¥150,000, size >=40㎡),
limits network requests with `--limit N`, and captures parking, lease, fees and
amenities together. `--replay` uses cached HTML with no requests; `--force`
rechecks within the budget. A persistent detail queue survives later scrapes.
The old `--all-missing` sweep is no longer supported.

The cities scraped and their page counts are configured at the top of
`scripts/scrape.ts` (`CITIES`).

Geocoding uses the free [GSI address search](https://msearch.gsi.go.jp/address-search/AddressSearch)
(no API key), which resolves to the 丁目/block level — good enough for walk-time
estimates, but treat exact positions as ±100–200 m.

## Project layout

```
src/
  web/                  ← React app (reads data; never imports Node, storage or collectors)
    data/                 · WebDataBoundary + runtime client that fetches public/data/
    components/           · PlacePanel, FilterPanel, WeightPanel, ListingTable, MapView, AddListingForm
    hooks/                · persisted config, filters, places, marks, custom listings
    userState/            · the only localStorage adapter (plus an in-memory one for tests)
    lib/export.ts         · CSV/Markdown export
  domain/               ← pure, testable logic shared by every layer
    types.ts              · listing, place and score shapes
    scoringConfig.ts      · all weights & anchors (the single tuning point)
    scoring.ts            · the 0–100 engine
    geo.ts                · haversine, walk-time estimation
    referenceData.ts      · the reference model built from a loaded snapshot
    places.ts             · the flat catalog of every reference place
    proximityIndex.ts     · runtime listing × place distance matrix
    placeSelection.ts     · applies "which places count" to a listing
    diagnostics.ts        · finds criteria that decide nothing
    filters.ts            · area/city/rent/size/layout predicates
  collectors/           ← fetch, parse and submit observations (suumo/, athome/, roomspot/, nifty/, enrichment/, shared/)
  data-layer/           ← contracts, ingestion/correction/bootstrap services, per-source policies, lifecycle
  storage/json/         ← JSON-file implementation of the data-layer repositories
  refresh/              ← refresh plan and run ledger
  node/                 ← locks, atomic writes, data root path
  integrations/         ← GSI geocoding client
data/                   ← the persisted datasets above
public/data/            ← published web assets (npm run data:web)
scripts/                ← CLI entry points only (npm run …)
  scrape.ts             ← incremental SUUMO collector
  scrape-athome.ts      ← Chrome-backed incremental AtHome collector
  scrape-roomspot.ts    ← Chrome-backed incremental RoomSpot/POLUS collector
  enrich.ts             ← cached batch geocode + enrich
  rank.ts               ← terminal top-N (`--bike` for cycling distances)
tools/architecture/     ← test enforcing the layer rules in DATA_ARCHITECTURE.md
```

## Known caveats

- **POI zero-anchors are harsh.** Al Sanad School sits in far-north Soka and the
  masjid is across the border in Koshigaya (大間野町), so for most of the search
  area both POI scores are 0 (12-min anchor) and totals top out around 53. Raise
  the anchors in the UI if you want POI proximity to differentiate more gently.
- **The northern city (Koshigaya) has strong options.** 北越谷・新越谷-area
  listings often top the ranking on rent/size, and 新越谷/蒲生 listings are the
  closest of all to the masjid (a few are <20 min walk). School, kindergarten,
  bus and station reference data all cover both cities so the comparison is fair.
- **松原団地駅 no longer exists** — it was renamed **獨協大学前〈草加松原〉** in
  April 2017. Soka has four Tobu Skytree stations: 谷塚・草加・獨協大学前・新田.
- SUUMO cassettes only expose the 町名 (no banchi), so geocodes are block-level.
- One representative room per property is kept (the largest family-size room).
