# Efficient listing refresh

## Start offline

- `npm run refresh:status` — latest durable run and failed stages.
- `npm run refresh -- --plan` — plan a new run, no writes or network.
- `npm run refresh:plan` — dependency-aware plan for the latest unfinished run.
- `npm run refresh -- --prepare` — create a native-capture checkpoint without
  running collectors or rebuilding unchanged data. Add `--skip-roomspot` to
  exclude RoomSpot collection for the new run and its resumes; existing source
  data is retained (not removed from the dashboard).
- `npm test -- --reporter=dot && npm run typecheck` — offline regression checks.

## Current policy

- Incremental discovery follows verified newest-first results **until it crosses
  the previous observation boundary**: two consecutive all-known family-result
  pages. It no longer stops after a tiny fixed three-page window. A 100-page
  emergency ceiling guards broken pagination; explicit `--max-pages` is an
  operator/diagnostic hard cap, not the normal stopping policy.
- A city also stops at its last results page (`src/collectors/shared/resultPages.ts`):
  SUUMO's page 1 numbers the last page; a RoomSpot or AtHome page with fewer
  than 30 cards is the last. A page past page 1 that comes back empty, without
  cards, or as a 404 ends that city too (`EndOfResultsError`). Blocks (403/429),
  verification pages (認証, including a 404 one), REST error objects, whole
  error documents, any empty page 1, and a missing SUUMO page that page 1
  numbered still fail.
- SUUMO, AtHome and RoomSpot commit **per city**. A failure keeps the cities
  committed before it, stops the run (no further cities are requested) and
  fails the stage; a re-run re-stages the committed cities from the 6-hour
  capture cache (a replay, or an update that changes nothing). The one
  "Discovered N new" summary line totals every city. Source provenance
  (`cities`, `pagesFetched`, `newListingIds`) now describes the last city
  committed, and each city's commit takes a backup (10 kept per source).
- **Minimum floor area per source** lives in `collectors.config.json`
  (`sources.<source>.minAreaM2`; 60 for every portal since 2026-10-12, `null` =
  any). `--min-area N` on a collector or on `npm run refresh` overrides it for
  one run (`0` = any) and is saved in the run ledger, so `--resume` keeps it.
  Each collector logs its `Area filter:` line. SUUMO (`mb=…&mt=9999999`), Nifty
  (`r10=…`) and RoomSpot (`occupied_area_from=….0`) send the portal's own
  search parameter, read from each search form in the headed browser and
  rounded down to the portal's nearest step (`src/collectors/shared/searchFilters.ts`).
  AtHome keeps search conditions in the browser session, not the URL, so the
  AtHome/RoomSpot collector drops each page's rooms below the exact minimum.
  UR ignores it: one API sweep per city sees every room, and a room it skipped
  would be recorded gone. Rooms with no stated area are always kept. A filtered
  search is still newest-first, so the two-all-known-pages stop applies to it.
- Capture list fields once, including fees, amenities and parking flags when
  present. Nifty now parses list cards instead of fetching each detail page.
- Refresh always tries detail pages, bounded by `--detail-limit` (default 10 per
  portal; `0` turns them off): SUUMO's `detail:enrich` stage (rent <=150000, size
  >=40), and AtHome/RoomSpot detail pages loaded by `scrape:athome` /
  `scrape:roomspot` right after their list data is committed. A failed, blocked or
  paused detail load is logged and never fails the list stage or changes the list
  data already stored.
- A detail fetch parses parking, lease, availability, fees, structure and amenities
  together. Valid HTML is cached; `--replay` re-parses it with zero requests.
  `--force` explicitly rechecks within the budget. Deferred URLs live in
  `data/detail-queue.json`, independent of scrape `newListingIds`.
- AtHome and RoomSpot list pages do not name the agency. `npm run detail:athome`
  and `npm run detail:roomspot` (default `--limit 10`) read current ads' detail
  pages in the headed Playwright browser (e.g. `npm run detail:roomspot -- --limit 10`)
  for the store block only (掲載不動産会社 / 広告主情報):
  `agency` and `agencyInfo`, added together and never overwritten or cleared.
  Queues live in `data/<source>-detail-queue.json`; captures in
  `data/.captures/details/`, replayed with `--replay` and zero requests. A
  verification, block (403/429) or unrecognised page stops all requests and pauses
  the source for an hour, doubling on repeats; `ATHOME_VERIFY_WAIT_SECONDS` lets
  a person complete AtHome's check in the window first. Refresh never runs them.
- Shared-address geocodes persist in `data/geocodes.json`. New results are
  checkpointed immediately, reused within the same run, and written atomically.
  No-match results expire after 7 days; transient HTTP failures are not cached.
- Source observation times come from the capture, not the build clock, and any
  contributing source can establish freshness. Old evidence cannot reactivate
  a property delisted after that observation.
- Source/import/build writes are atomic with backups. Successful independent
  stages are reused on resume; only failed work and dependent stages rerun.
- `--full` now fails safely: existing fixed-page collectors do NOT prove full
  per-city exhaustion. Use `--deep` for wider non-destructive discovery. Automated
  SOLD auditing remains unavailable until explicit exhaustion is implemented.

## Parallel collection and the Playwright browser

- Collectors for different sources (SUUMO, AtHome, RoomSpot, UR, Nifty) run at the
  same time; the Nifty cities share `nifty.json`, so they run in order
  inside one group. `--concurrency N` caps it (`1` = fully sequential).
- Every portal page loads in a local Playwright Chromium (`src/collectors/shared/playwrightBridge.ts`),
  **headed** by default: Nifty and AtHome serve a wait/verification page to
  headless Chromium. `PLAYWRIGHT_HEADLESS=1` opts out; `PLAYWRIGHT_EXECUTABLE_PATH`
  overrides the browser, else the newest cached Chromium is used.
- The AtHome adapter handles both templates: the legacy `#search-parameter` AJAX
  form and the modern `.property-card` pages, which it reads as
  `/list/pageN/?sort=33` documents and projects offline with
  `athomeDownloadedCapture`. It never retries or works around AtHome's
  verification page ("認証にご協力ください"); it stops with an error instead.
- If AtHome shows that page to the automated browser, pass it once by hand: run
  with `PLAYWRIGHT_USER_DATA_DIR=.context/athome-profile` (gitignored), complete
  the check in the headed window, and later runs reuse the session. Add
  `ATHOME_VERIFY_WAIT_SECONDS=300` so the run waits (passively; no reloads or
  extra requests) while you complete it, and `--verbose` to see the prompt. As of
  2026-09-30 a fresh Playwright profile was shown the page on the homepage.
- Chromium allows one instance per profile directory, so `npm run refresh` passes
  `PLAYWRIGHT_USER_DATA_DIR` only to the AtHome stage (`stageEnv` in
  `src/refresh/refreshPlan.ts`). SUUMO, RoomSpot and Nifty get a fresh,
  non-persistent context and run in parallel with it. Before this, every collector
  launched the shared profile and Chromium refused the second one ("Opening in
  existing browser session… profile is already in use"); on 2026-10-02 AtHome
  and RoomSpot failed at launch, and only `--concurrency 1` worked. The default
  parallel run now works with the profile set.

## Rented-out detection

A property is **rented out** when every portal ad we know for it has been seen
gone. One live ad keeps it available. This is separate from `sold`, which is
only inferred from absence in crawls.

- `npm run check:availability` visits ad pages in the **headed browser only**
  (Playwright; never curl/fetch).
  It picks the properties a refresh has not seen for longest, checks the
  cheapest portal first (Nifty, SUUMO, RoomSpot, Yahoo, AtHome) and stops at the
  first live ad, so an available property costs one page load. Ads already
  recorded gone are never revisited. Flags: `--limit N` (25), `--stale-days D`
  (3), `--city`, `--min-size`, `--max-rent`, `--recheck-gone`, `--url <ad>`,
  `--dry-run` (no browser).
- What "gone" looks like (`src/collectors/availability/classify.ts`): AtHome
  HTTP 404 「お探しのページが見つかりません」; SUUMO HTTP 404 「エラー｜SUUMO」 or a
  redirect to the building's `/library/` page; RoomSpot HTTP 404 with 掲載終了;
  Nifty a redirect from `detail_…` to the building's `/mansion-info/` page.
  A `/mansion-info/…/mansion_<id>/` (Nifty) or `/library/…` (SUUMO) URL is a
  **building page, not a rental ad**: portals send taken-down ads there, and the
  live ad's breadcrumb also links to it. Stored ad URLs are always
  `/rent/<pref>/<city>/detail_<id>/` and `/chintai/jnc_<id>/`; if you click one
  and land on a building page, the ad is gone (run `check:availability --url
  <ad>`), not mis-collected. Seen 2026-10-07 for 日商岩井草加マンション.
  Verification/busy pages, errors and anything unrecognised are `unknown` and
  never recorded as gone. Use `ATHOME_VERIFY_WAIT_SECONDS` to pass a check by hand.
- Results live in `data/availability.json` (newest check wins per ad), separate
  from the source snapshots so refreshes cannot wipe them. `npm run data:web`
  bakes them into each ad in `public/data/listings.json`.
- Dashboard: rented-out properties are hidden by default (filter: hide / show /
  only), badged **RENTED OUT**, and each portal link has a small ✕ / ↺ to mark
  that ad gone or still listed by hand (browser-local, newest check wins).

## Manual capture import

Collectors save every page they load to the capture cache (`data/.captures/`).
`npm run capture:import -- --file <export.json>` imports saved list pages
offline from a `{ captures: PageCapture[] }` file, each city's pages in order:
it validates and parses locally, checkpoints each page, updates the source, and
prints added/refreshed counts and STOP/continue (STOP after two consecutive
all-known pages). Replays are idempotent. `npm run capture:athome-html -- --file
<html> --url <pageUrl> --captured-at <iso>` turns a saved AtHome results HTML
file into a PageCapture. After imports, `npm run
refresh -- --resume --local-only` merges, geocodes and rebuilds the dashboard
without any portal collection.

PageCapture schema: `schemaVersion:1, source, city, url, page, capturedAt,
httpStatus:200, sortedNewest:true, html`. Cities: Soka/Koshigaya/Kawaguchi/Katsushika
(`src/collectors/shared/targetCities.ts` is the one list every collector reads).
Captures and progress receipts live in `data/.captures/`; never put full
HTML, source JSON, browser storage, cookies or tokens into model context.

## Run log

Dated entries are a historical record. Runs before 2026-10-02 used the Pi
Control Chrome bridge and agent-native browser tools; both have since been
removed, and every collector now uses the headed Playwright browser.

## 2026-09-07 recovery result

- Preserved successful SUUMO + parking stages; recovered AtHome, RoomSpot and
  all three Nifty city stages. Latest run status: SUCCESS.
- 25 unique list pages imported: AtHome 9, RoomSpot 7, Nifty 9. Nifty needed no
  detail-page fetches. One blocked automatic export required recapturing 5 AtHome
  pages before switching to explicit native downloads; that is not a saving.
- Source discoveries: AtHome 20, RoomSpot 2, Nifty 75 (before cross-source merge).
- Recovery build: 56 newly tracked rows; archival total 1841 -> 1885 (net +44
  after merging older duplicates). Dashboard final deduplication: 1883 rows.
- All 1885 archival rows geocoded; enrichment completed in ~4.6 seconds.
- Dashboard JSON: ~2.39 MB compact-serialized vs ~4.08 MB before recovery,
  despite more listings. Bilingual attributes are dictionary-encoded losslessly.
- 221 tests and typecheck pass; production build succeeds. Vite still warns
  about the large static data JS chunk; future code/data splitting is optional.

## 2026-09-09 continuation result

- Resumed the September 8 checkpoint without refetching completed SUUMO,
  Nifty or RoomSpot stages. Applied pending RoomSpot data in a local-only rebuild.
- Added 2 newly tracked rows in this rebuild: archival/dashboard total
  **1935 -> 1937**, all geocoded. No listings marked SOLD or reactivated.
- Run remains **PARTIAL: AtHome only**. Its September 7 snapshot is preserved.
  Native Chrome opened an AtHome tab and read its sort control, but subsequent
  read-only evaluation and status inspection timed out. No new AtHome pages
  were saved; no automatic restart or stale-runtime cleanup was attempted.
- 221 tests, typecheck and production build pass. The existing Vite large-chunk
  warning remains. Current recovery details: `.context/refresh-blockers.json`.

## 2026-09-09 AtHome recovery — completed

- The user's open multi-city search worked without a browser restart. Used
  native browser tools only, preserving the user's tab URL and search state.
- Imported **8 pages / 164 family rows**: Soka 3, Koshigaya 3, Kawaguchi 2.
  Kawaguchi stopped after two entirely known pages. Six source additions and
  78 overlap updates; no detail requests. One extra combined-search request
  was used to inspect the new markup before city-scoped collection.
- Original Japanese HTML was fetched from the public list URL inside the
  existing first-party tab; the Chrome-translated DOM was not used as data.
  Each response verified newest-first sorting and every card's city address.
- New template normalization: `.property-title` -> building name;
  `.info-item--location`, `--station`, `--type` -> address, transit, build info;
  each `.room-info-section` supplies its detail link ID, `.price > .rent`,
  `.price > span:not(.rent)`, `.fees > span`, and `.layout-size > span`.
  Project these into the legacy `p-property` parser markup, escaping text and
  retaining only property fields. Skip layouts below 2K. Missing amenities
  remain unknown, not false or empty.
- Fixed missing-amenity merge semantics in `scripts/lib/athome.ts`; saved
  captures were replayed locally against the pre-import backup to preserve
  62 historical parking/amenity records. Explicit unavailable parking still
  overrides older availability. Two regression tests added.
- Final rebuild: **6 newly tracked properties, 1936 total** (1937 before this
  pass; older duplicate consolidation explains the net -1). All geocoded;
  no SOLD or reactivation changes. Full checkpoint status: **SUCCESS**.
- **223 tests, typecheck and production build pass.** Existing Vite large-chunk
  warning remains. Captures and progress receipts are in `src/data/.captures/`.

## Yahoo! Real Estate user-selected detail import (2026-09-10 JST)

- Added `src/data/sources/yahoo.json` with the requested first-floor
  グランコート草加 listing (Yahoo ad `0703661102`). Preserved the public detail
  tables in `src/data/.captures/yahoo/0703661102.json`, observed at
  `2026-09-09T21:26:42.838Z`; stripped email tracking from its canonical URL.
- ¥81,000 rent + ¥4,000 management; optional ¥11,000 parking; 3LDK, 70.72㎡;
  zero deposit/key money; immediate availability. The station's bus connection
  is not converted into a station walking time. Unstated lease type/cleaning
  fee remain unknown; guarantor-company alternatives retained verbatim.
- Source discovery automatically includes the new independent file, but no
  Yahoo-wide crawler was added. Other source snapshots were not changed.
- Verification exposed an existing transitive deduplication bug: an unknown-
  floor member could bridge explicit first- and third-floor units. Group-level
  floor-conflict checks now prevent this (two regression tests). The Yahoo ad
  is linked to the first-floor SUUMO/Nifty row, not the separate third-floor row.
- Rebuild after the correction: 1944 archival rows / 1943 dashboard rows, all
  archival rows geocoded. The increase reflects previously over-merged units,
  not an additional market crawl. No properties marked SOLD.
- 225 tests, typecheck and production build pass; targeted checks verify the
  first-floor Yahoo link, ¥85,000 rent, ¥11,000 parking and separate third floor.

## 2026-09-11 newest-first discovery — completed

- Run `2026-09-10T20-40-41-739Z-8eb43eab`: **SUCCESS**, about 7 minutes.
  Nine list pages each for SUUMO, AtHome, Nifty and RoomSpot (three per city).
  Zero detail requests; user-selected Yahoo data preserved, not recrawled.
- Source additions before cross-source merge: SUUMO **43**, AtHome **23**,
  Nifty **65**, RoomSpot **19**. All browser-backed portals worked with native
  `browser_evaluate` / explicit native downloads; no recovery or restart needed.
- **103 newly tracked properties**, with **2039 archival/dashboard rows** after
  consolidation (1944 archival rows before the run; net +95). All geocoded;
  no SOLD or reactivation changes. The Yahoo first-floor link remains correct.
- **66** newly tracked rows have rent including management <=¥150,000 and
  area >=50㎡. Default bicycle-mode ranking highlights ＪＡプレミール (¥85,000,
  65.21㎡, 3LDK), ハイマウンテンI (¥70,000, 54.65㎡, 3DK), and ヴィルヌ－ブ
  (¥72,000, 54.6㎡, 2LDK). These use default weights, not browser-saved settings.
- **225 tests, typecheck and production build pass.** Fixed the header lifecycle
  test to freeze its clock at the fixture date rather than age out with the real
  calendar. Production lifecycle logic unchanged. Existing Vite chunk warning
  remains. Current checkpoint summary: `.context/refresh-blockers.json`.

## 2026-09-16 newest-first discovery — completed

- Incremental run `2026-09-16T03-07-23-367-8b3f489e`: **SUCCESS**.
  Three list pages each for SUUMO, AtHome, Nifty and RoomSpot across Soka,
  Koshigaya and Kawaguchi (9 pages per portal, stopping at overlap).
  Zero detail requests; user-selected Yahoo data preserved, not recrawled.
- Source additions before cross-source merge: SUUMO **33**, AtHome **37**,
  Nifty **47**, RoomSpot **15**.
- **132 newly tracked properties**, bringing dashboard listings to **2297**
  and archival raw rows to **2298** (vs 2132 dashboard / 2142 raw before the run).
  All geocoded (33 GSI queries, 0 unresolved); no SOLD or reactivation changes.
- `scripts/lib/roomspotBrowser.ts` updated with `wait: true` on tab navigation
  so page evaluate calls never run on transition-pending tabs.
- AtHome captured via first-party in-page fetch + property-card projection to
  `p-property` and imported with `npm run capture:import`.
- **227 tests, typecheck and production build pass.**

## AtHome homepage-first fix (2026-09-18)

- `scripts/lib/athomeBrowser.ts` now opens the homepage, waits for that load,
  then navigates the same owned tab to the original search URL. City changes
  reuse the warmed tab and wait for navigation before any capture evaluation.
- Homepage/search navigation has a 30-second load timeout and a 35-second
  Bridge request deadline. The list AJAX fetch has a 20-second abort deadline;
  capture requests no longer wait 120 seconds. Missing search forms fail
  immediately rather than polling a blocked/unsupported document.
- Failed navigation invalidates capture readiness so the old city's page cannot
  be imported as the new city. No automatic navigation retries or verification
  bypasses were added. The legacy AJAX parser and search filters are unchanged.
- Native-browser agents must follow the same homepage-first sequence above;
  they must not invoke the human CLI's direct-Bridge adapter from the shell.
- Regression coverage uses a mocked Bridge (no live browser or portal requests).
  Live verification of the fix is still pending; homepage-first is not a
  guarantee that AtHome will accept the subsequent search.

## 2026-09-19 recent-listing refresh — dashboard rebuilt; AtHome pending

- Run `2026-09-19T05-53-05-254Z-c78bb371` rechecked newest-first page 1 because
  September 18's partial captures were now a day old. Preserved every saved
  source, including yesterday's SUUMO backfill and the selected Yahoo listing.
- Explicit recent-pass cap: 10 pages/city. All successful sources stopped on
  two all-known pages before the cap: SUUMO 6/6/2 pages, RoomSpot 3/3/3,
  Nifty 5/3/7 (Soka/Koshigaya/Kawaguchi). Source additions today: **24 / 3 / 62**
  respectively, before cross-source deduplication. Zero detail requests.
- AtHome opened its homepage first, loaded and exposed normal rental navigation,
  then navigated the same tab to the saved modern search. The loaded search
  confirmed `SORT=33`, but a bounded public-card `browser_evaluate` read still
  timed out with an uncertain-operation error. No captures saved, retries,
  restarts, or further page actions. Homepage-first fixes the startup sequence
  but has **not** resolved capture evaluation. September 17 data is preserved.
- `refresh --resume --local-only` applied both yesterday's pending discoveries
  and today's captures: **2335 -> 3019 archival rows**, **759 newly tracked**;
  final web deduplication gives **3015 dashboard rows / 758 newly tracked**.
  These are new to this dataset, not necessarily newly advertised; yesterday's
  deeper Kawaguchi scan contributes most of them.
- **141 newly tracked dashboard properties exceed 70 m²**: Soka 3, Koshigaya 8,
  Kawaguchi 130. Dashboard total over 70 m²: **398**. All 3019 archival rows
  geocoded (71 address queries, zero unresolved); no SOLD/reactivation changes.
- **240 tests, typecheck and production build pass**. Existing Vite large-chunk
  warning remains. Local dashboard responds HTTP 200. Browser visual verification
  was not attempted after the AtHome read timeout. Latest checkpoint is partial
  **only for AtHome**; all derived artifacts and other source stages succeeded.

## 2026-09-20 latest-listing refresh — RoomSpot excluded; AtHome pending

- Run `2026-09-20T11-53-41-815Z-cb4893c3`: `--skip-roomspot --max-pages 10`.
  Added durable `--skip-roomspot` support to the refresh command and ledger;
  exclusion survives resume. RoomSpot was not collected and its source file's
  SHA-256 is unchanged. Selected Yahoo data also preserved.
- SUUMO: **45 source additions**, 6/2/10 pages (Soka/Koshigaya/Kawaguchi).
  First two cities reached overlap; Kawaguchi hit the explicit recent-pass cap,
  so this does not claim exhaustive discovery or authorize SOLD detection.
- Nifty: **73 source additions**, 4/4/6 pages; every city reached two all-known
  pages. Soka p3 returned a transient HTTP 404; one later read succeeded and
  all successful captures were validated/imported. Zero detail requests.
- AtHome homepage opened and was readable. A homepage rental-link click was
  confirmed, but the following read failed during an extension disconnect;
  diagnostics saw a reconnect, then status verification timed out. No action
  replay, restart, or new AtHome capture. Preserve September 17 source data;
  further AtHome work needs browser recovery/diagnosis rather than blind retries.
- Local-only rebuild: **3098 archival / 3096 dashboard rows**, **84 newly
  tracked properties**. **13 new properties exceed 70 m²** (Soka 0, Koshigaya 3,
  Kawaguchi 10); dashboard total over 70 m² is **409**. All 3098 geocoded,
  9 address queries, zero unresolved; no SOLD or reactivation changes.
- **241 tests, typecheck and production build pass**; existing Vite large-chunk
  warning remains. Local dashboard responds HTTP 200. Browser visual verification
  was not attempted after the AtHome failure. Run remains partial only for
  AtHome; RoomSpot is intentionally skipped, not a failure.

## 2026-09-25 Chrome recent-listing refresh — completed

- Resumed run `2026-09-24T05-02-40-770Z-ac3f466d`: **SUCCESS (bounded discovery)**.
  Chrome's evaluation calls returned uncertain-operation errors and the extension
  reconnected repeatedly. No uncertain page action was replayed and no browser
  restart was performed. Native Chrome downloads worked; public result HTML was
  validated/sanitized offline before import. No shell-driven browser collectors.
- **61 validated list pages**: SUUMO 3/7/7, RoomSpot 3/5/3, Nifty 3/20/4,
  AtHome 1/2/3 (Soka/Koshigaya/Kawaguchi). Two additional AtHome Soka pages
  returned explicit zero matches and were not imported as valid result pages;
  one RoomSpot shell download supplied its public REST search parameters.
- Source additions before cross-source merge: SUUMO **27**, AtHome **18**,
  RoomSpot **13**, Nifty **90**. Zero detail requests. The selected Yahoo
  snapshot is byte-for-byte unchanged; no Yahoo-wide crawler exists.
- **Coverage limits:** Nifty Koshigaya hit an explicit **20-page cap** with
  discoveries still present; this is not exhaustive. AtHome preserved the user's
  saved filters (**¥60,000–150,000 base rent, area >=70m²**). Its pagination
  verified Soka p1 and Kawaguchi p3 as final filtered pages; proof receipts are
  in `src/data/.captures/filtered-end-<run-id>.json`. Koshigaya reached overlap.
  Other source/city passes reached two all-known pages. No absence/SOLD inference.
- Rebuild: **77 newly tracked properties**, **3455 archival / 3452 dashboard
  rows**, all archival rows geocoded. Before: 3406 archival rows; the net +49
  includes consolidation of older duplicates. New dashboard rows: Soka **12**,
  Koshigaya **33**, Kawaguchi **32**; **24 exceed 70m²**. No SOLD/reactivations.
- Added native SUUMO capture-import support by exporting the existing parser
  without running its CLI collector; two offline regression tests added.
  **250 tests, typecheck and production build pass**. The existing Vite large
  static-chunk warning remains; local dashboard responds HTTP 200.
- The task-local offline download adapters are in `.context/`; only sanitized
  captures and compact progress receipts are imported into the durable dataset.

## 2026-10-02 recent-listing refresh (Playwright, no Chrome bridge) — completed

- Run `2026-10-02T10-37-14-683Z-6b3c2254`: **SUCCESS**, all four portals, no
  page cap; every source/city stopped on two all-known pages. Headed Playwright
  (then opted into with `BROWSER_DRIVER=playwright`, since removed) with the
  AtHome profile in `.context/`.
- Source additions before cross-source merge: SUUMO **99**, AtHome **336**
  (390 overlaps refreshed, 39 pages: 6/20/13), RoomSpot **37** (128 refreshed),
  Nifty **83** (Soka 18, Koshigaya 25, Kawaguchi 40). Zero detail requests.
- Rebuild: **3822 archival / 3820 dashboard rows**, ~160 newly tracked (Soka 21,
  Koshigaya 56, Kawaguchi 83); 23 exceed 70m². All geocoded; none SOLD.
- Gotcha: with `PLAYWRIGHT_USER_DATA_DIR` set, parallel collectors contend for
  one Chromium profile and AtHome/RoomSpot fail at launch. Resume with
  `--concurrency 1`. AtHome showed its verification page; passed by hand.
- `check:availability --limit 150`: **112 rented out**, 38 still listed,
  0 unresolved. One Nifty ad was recorded gone on HTTP 404 with its ad title
  still shown (ソライエアイル草加 207, 1K); its sibling unit redirected as gone.
- **610 tests, typecheck and production build pass.**

## 2026-10-04 recent-listing refresh + photo backfill (Playwright)

- Run `2026-10-04T05-50-30-782Z-39b938f4`: **SUCCESS**, all four portals,
  every source/city stopped on two all-known pages. Source additions: SUUMO
  **20**, AtHome **92**, RoomSpot **34**, Nifty **39** (8/5/26). Zero detail
  requests; **57 unique properties added** (3860 → 3897). AtHome reused the
  October 3 profile without a verification page.
- Photo backfill: photo capture landed after the October 3 run, so 1235 active
  AtHome/Nifty/RoomSpot-only rows had no picture. Deep newest-first passes
  re-read older result pages: RoomSpot 18 pages, Nifty 39/40/40 (Soka 404'd
  past its last page), AtHome 34/34/16 (Kawaguchi then showed its verification
  page; not bypassed). Photo-less active rows: **1235 → 803**. The deep passes
  also found ads the incremental pass never reached: **3968 archival / 3964
  dashboard rows**, all geocoded (18 queries, 0 unresolved). None SOLD.
- Gotcha (fixed 2026-10-10): `--deep` AtHome/RoomSpot ran off the end of a
  city's results and threw, and they committed only after every city, so
  nothing was saved. They now stop at the last page and commit per city.
- **697 tests, typecheck and production build pass.**

## 2026-10-04 Katsushika-ku (Tokyo) first load (Playwright)

- Added Katsushika as the fourth target city (`targetCities.ts`). Portal paths,
  each checked in the headed browser first: SUUMO `tokyo/sc_katsushika`, AtHome
  `tokyo/katsushika-city`, Nifty `tokyo/katsushikaku_ct`, RoomSpot
  `pref_13/city_122`. SUUMO list pages now load in the headed browser too.
- Loaded with `--city Katsushika`, to each portal's last page: SUUMO **38** pages
  (572 rooms), AtHome **81** (1121), Nifty **110** (page 111 is a 404; one
  transient HTTP 405 on page 59 was resumed from cache with `--deep`), RoomSpot
  **2** (21). AtHome showed its verification page once; it was passed by hand.
- Gotcha (fixed 2026-10-10): each collector's last page is far below the
  100-page ceiling, and AtHome/RoomSpot/SUUMO threw on the page after it, so
  nothing committed; the workaround was re-running with `--city <label>
  --max-pages <last page>`. Collectors now stop on the last page (or on a
  "no results" page past it) and commit each city, so no re-run is needed.
- RoomSpot dropped whole-man rents (`<strong>12</strong>万円`): the parser read
  only `<strong>`. Fixed; Saitama ads with such rents were affected too and
  reappear as refreshes revisit them.
- Rebuild: **929 Katsushika properties** after cross-source dedup (3965 → 4894
  dashboard rows), all geocoded (291 GSI queries, 0 unresolved); none SOLD.
  Katsushika median rent ¥130,000; 155 at ≤¥150,000 and ≥50㎡; 143 ≥70㎡.
- **766 tests, typecheck and production build pass.**

## 2026-10-05 city-by-city, source-by-source refresh (Playwright)

- Ran each collector on its own with `--city <label>` (SUUMO → AtHome →
  RoomSpot → Nifty), rebuilding after each city. No `npm run refresh` ledger
  entry. Every source/city stopped on two all-known pages or its last page.
  Zero detail requests. AtHome showed its verification page once (Soka);
  it was passed by hand.
- Source additions (SUUMO / AtHome / RoomSpot / Nifty): Soka 5/21/53/3,
  Koshigaya 8/10/136/6, Kawaguchi 56/8/57/21, Katsushika 21/18/0/13.
- RoomSpot ran off the last page in Soka (7), Koshigaya (11) and Kawaguchi (6)
  and threw, so nothing committed; re-run with `--max-pages <last page>`.
  Kawaguchi page 7 failed the same way on a second try before the cap was used.
- Dashboard **4894 → 4975** (+81 newly tracked: Soka 6, Koshigaya 15,
  Kawaguchi 48, Katsushika 12). All geocoded (72 queries, 0 unresolved); none SOLD.
- **770 tests, typecheck and production build pass.**

## 2026-10-07 parallel per-source load (Playwright, one worktree per source)

- One agent per collector, each in its own git worktree off `main` (node_modules
  symlinked; AtHome got a copy of the warmed profile), all four cities each,
  committing only its `data/sources/<source>.json`. Each finished branch was
  merged into main on its own and the derived data rebuilt (`data:build`,
  `enrich`, `data:web`) before the next, so rebuilds never conflicted.
  Every source/city stopped on two all-known pages; zero detail requests.
- Source additions (Soka / Koshigaya / Kawaguchi / Katsushika): Nifty 20/29/58/28
  (29 pages), RoomSpot 15/17/0/0 (11 pages), SUUMO 9/17/3/26 (28 pages),
  AtHome 48/121/19/101 (44 pages). AtHome showed its verification page once
  (Soka); it was passed by hand.
- Gotcha: RoomSpot and AtHome both timed out on their first navigation waiting
  for the load event. The pages arrived (AtHome's homepage in 374 ms, no
  verification page), but trackers (`b6.im-apps.net/topics`, `clarity.ms`) never
  finish, so `load` never fires. RoomSpot now navigates with `wait: false`
  (`fetchPage` polls for `window.localize`); AtHome waits for
  `domcontentloaded`, which the Playwright bridge now accepts as `wait`.
- Gotcha: the Bash sandbox blocks Chromium launch, ssh commit signing and the
  GSI geocoder (`enrich` reports every new address as a transient failure);
  run those outside it.
- Archival rows **4978 → 5110** (126 newly tracked across the four merges; older
  duplicates consolidated after the AtHome merge). Dashboard **4972 → 5108**;
  120 rows first seen today (Soka 23, Koshigaya 22, Kawaguchi 40, Katsushika 35),
  12 of them ≥70㎡, 59 at ≤¥150,000 and ≥50㎡. All geocoded; none SOLD.
- **774 tests, typecheck and production build pass.**

## 2026-10-08 repeat parallel per-source load (hours after the 2026-10-07 one)

- Same layout: one agent and worktree per source, each merged and rebuilt on
  its own. Every source/city stopped on two all-known pages or its last page;
  zero detail requests. The `domcontentloaded` (AtHome) and `wait: false`
  (RoomSpot) navigation fixes held: no load-event timeouts.
- Source additions (Soka / Koshigaya / Kawaguchi / Katsushika): Nifty 0/2/5/2
  (11 pages), RoomSpot 10/6/0/1 (11 pages; Katsushika ran off its last page
  and was re-run with `--max-pages 2`), SUUMO 0/5/41/12 (39 pages; Kawaguchi
  needed 23), AtHome 4/12/19/10 (11 pages). AtHome showed its verification
  page once (Soka); it was passed by hand.
- Gotcha: `git worktree remove --force` deletes the worktree's untracked
  `.context/athome-profile` too. Move the profile out first, or AtHome is
  back on an older profile and shows its verification page again.
- An AtHome card can show fewer photos than before; the source row then keeps
  only the current ones, but the property document keeps every photo URL seen.
- Archival rows **5110 → 5143** (36 newly tracked: Nifty 6, RoomSpot 1,
  SUUMO 28, AtHome 1). All geocoded; none SOLD.
- **774 tests, typecheck and production build pass.**

## 2026-10-09 recent-listing refresh (Playwright)

- Run `2026-10-09T06-18-02-330Z-4dc22904`: all four portals, every source/city
  stopped on two all-known pages. AtHome reused the profile without a
  verification page. Source additions: SUUMO **2**, AtHome **98**, Nifty **5**
  (1/2/2/0), RoomSpot **13** (Soka 5, Koshigaya 8).
- RoomSpot Katsushika is down to **1 page**: the run read page 1 (all known),
  then page 2 returned no HTML and the whole stage committed nothing. Re-ran it
  per city (`--city <label>`; the first three from the capture cache) with
  `--city Katsushika --max-pages 1`, then `refresh -- --resume --local-only`.
  The ledger still lists RoomSpot as pending; `--resume` would only repeat the
  Katsushika error.
- Every run since 11:16 had been PARTIAL on "SUUMO details" only because ended
  ads count as failures (exit 2); this run's 10 SUUMO details all applied.
- **13 newly tracked properties**, 5195 → **5208** archival rows; all geocoded
  (2 queries, 0 unresolved); none SOLD. 10 agency stores added from RoomSpot.
- **902 tests and typecheck pass.**

## 2026-10-10 recent-listing refresh (Playwright)

- Run `2026-10-10T02-37-48-405Z-12e91218`: all portals plus UR; every
  source/city stopped on two all-known pages. AtHome showed its verification
  page once; it was passed by hand. Source additions: SUUMO **63**, AtHome
  **76**, Nifty **51** (7/7/23/14), RoomSpot **15** (Soka 5, Koshigaya 8,
  Kawaguchi 2); 12 RoomSpot agency stores added.
- RoomSpot Katsushika (one page) failed again on page 2, so the stage committed
  nothing; re-ran per city as on 2026-10-09, then `--resume --local-only`.
- **68 newly tracked properties** (Soka 5, Koshigaya 10, Kawaguchi 33,
  Katsushika 20); 11 ≥70㎡, 26 at ≤¥150,000 and ≥50㎡. **5293** archival rows,
  all geocoded; none SOLD.
- **944 tests and typecheck pass.**

## 2026-10-10 evening recent-listing refresh (Playwright)

- Run `2026-10-10T11-29-26-315Z-a637c994`, nine hours after the morning one.
  AtHome showed its verification page once; it was passed by hand. Source
  additions: SUUMO **36**, AtHome **56**, Nifty **6** (2/2/1/1), RoomSpot **4**
  (Soka 3, Koshigaya 1); 10 RoomSpot agency stores added.
- RoomSpot Katsushika failed on page 2 a third time; re-ran per city as before.
- **35 newly tracked properties** (Soka 6, Koshigaya 12, Katsushika 17); 7 ≥70㎡,
  19 at ≤¥150,000 and ≥50㎡. **5320** archival rows, all geocoded; none SOLD.
- **944 tests and typecheck pass.**

## 2026-10-10 RoomSpot end-of-results fix

- `npm run refresh` failed the RoomSpot stage on 2026-10-09 and 2026-10-10:
  the request for the page after Katsushika's last results page failed with
  "RoomSpot returned no response HTML" (on 10-10 Katsushika had one page, 22
  family rooms), and the single end-of-run commit dropped Soka, Koshigaya and
  Kawaguchi too. The Playwright bridge reports an
  in-page throw as `exceptionDetails` with no value, so the real reason was
  hidden; RoomSpot and AtHome now surface it ("capture stopped on page N: …").
- Fixed in the collectors (see Current policy): last-page stop, end-of-results
  past page 1, per-city commits, for SUUMO, AtHome and RoomSpot. Tests use
  mocked pages only; no portal was contacted for this change.

## 2026-10-11 recent-listing refresh (Playwright)

- Run `2026-10-11T04-15-02-073Z-745d1ff2`: **SUCCESS**, the first since the
  end-of-results fix; RoomSpot read every city in one stage with no per-city
  re-run. AtHome showed its verification page once; it was passed by hand.
  Source additions: SUUMO **46**, AtHome **63**, Nifty **77** (5/22/40/10),
  RoomSpot **5**.
- **63 newly tracked properties**; 5320 → **5390** archival rows, all geocoded;
  none SOLD.
- Possible duplicates: 750 pairs the automatic matcher keeps apart now appear in
  the dashboard's review panel (`src/domain/possibleDuplicates.ts`) for a person
  to mark same or different; the matcher itself is unchanged.

## 2026-10-12 first refresh with the 60㎡ minimum (Playwright)

- Run `2026-10-12T11-27-36-793Z-6f74705d`: **SUCCESS** after one resume. Every
  portal searched ≥60㎡ (`collectors.config.json`); every source/city stopped
  on two all-known pages or its last page. Nifty Koshigaya, Kawaguchi and
  Katsushika "failed" with HTTP 404, but not on page 1 and not transiently:
  the filtered results were short (7/17/8 pages, all cached), and the crawler
  asked for the page after the last one, which Nifty answers with 404. Every
  page read was already checkpointed; the retry and `--resume` only replayed
  them. Fixed the same evening (next entry).
- Before the run, each portal's area parameter was read from its own search
  form in the headed browser (SUUMO `mb`, Nifty `r10`, RoomSpot
  `occupied_area_from`). AtHome's list page has no condition form (it keeps
  conditions in the session) and showed its verification page once to the
  probe; it was passed by hand.
- Source additions: SUUMO **65**, AtHome **25**, RoomSpot **8**, Nifty **1**
  (Soka). Every source row added this run is ≥60㎡ (SUUMO 331, AtHome 40,
  RoomSpot 10, Nifty 373 rows checked; none smaller, none without an area).
- **95 newly tracked properties** (Soka 5, Koshigaya 14, Kawaguchi 65,
  Katsushika 11), all ≥60㎡, 50 ≥70㎡, 47 at ≤¥150,000. **5497** archival rows,
  all geocoded; none SOLD.

## 2026-10-18 refresh with the 60㎡ minimum (Playwright)

- Run `2026-10-18T07-49-18-993Z-2b471ba8`: **SUCCESS**, no resume.
- Source additions: SUUMO **15**, AtHome **14**, RoomSpot **0**, Nifty **17**.
- UR swept 74 of 74 municipalities: 138 estates, 94 vacant rooms (82 with 2+
  rooms), 267 API calls. The `ur` source went 131 → 137 rooms (6 added, none
  gone, no rent changes); the rooms page has 90 open of 1551.
- **24 newly tracked properties**: 20 from the portals, all ≥60㎡
  (60.53–105.9㎡, 9 ≥70㎡, 12 at ≤¥150,000), and 4 UR rooms. All geocoded.
  **5714** archival rows. The 東川口 3SLDK house (90.46㎡, ¥220,000) came in
  as two properties, one from Nifty and one from SUUMO (東川口4丁目戸建).

## 2026-10-17 refresh with the 60㎡ minimum (Playwright)

- Run `2026-10-17T05-36-19-350Z-47156b5e`: **SUCCESS**, no resume.
- Source additions: SUUMO **13**, AtHome **9**, RoomSpot **2**, Nifty **12**.
- UR swept 74 of 74 municipalities: 138 estates, 102 vacant rooms (92 with 2+
  rooms), 260 API calls. The `ur` source went 125 → 131 rooms (6 added, none
  gone, no rent changes); the rooms page has 100 open of 1547.
- **18 newly tracked properties**: 13 from the portals, all ≥60㎡ (60–103.65㎡,
  6 ≥70㎡, 10 at ≤¥150,000), and 5 UR rooms. All geocoded. **5684** archival rows.

## 2026-10-16 refresh with the 60㎡ minimum (Playwright)

- Run `2026-10-16T10-10-44-998Z-c1f7d75b`: **SUCCESS** after one resume. A
  network change mid-run (`net::ERR_NETWORK_CHANGED`) failed AtHome and left
  Nifty Soka and Koshigaya on "results not ready"; `--resume` re-ran just those
  three and they passed.
- Source additions: SUUMO **17**, AtHome **23**, RoomSpot **7**, Nifty **6**.
- UR swept 74 of 74 municipalities: 138 estates, 108 vacant rooms (95 with 2+
  rooms), 258 API calls. The `ur` source went 86 → 125 rooms (39 added, none
  gone, no rent changes); the rooms page has 103 open of 1543.
- **40 newly tracked properties**: 16 from the portals, all ≥60㎡
  (62–122.62㎡, 9 ≥70㎡, 10 at ≤¥150,000), and 24 UR rooms (UR is
  unfiltered, so 15 are under 60㎡). All geocoded. **5667** archival rows.
- uralert.jp (considered as a per-city vacancy page) answered its first page
  load with HTTP 429 and a Vercel Security Checkpoint; nothing more was loaded.
  UR's own API remains the vacancy source.

## 2026-10-15 refresh with the 60㎡ minimum (Playwright)

- Run `2026-10-15T05-18-07-677Z-17bce530`: **SUCCESS**, no resume (AtHome
  passed first time with the main checkout's profile).
- Source additions: SUUMO **3**, AtHome **19**, RoomSpot **1**, Nifty **16**.
- UR swept 74 of 74 municipalities: 138 estates, 80 vacant rooms (72 with 2+
  rooms), 206 API calls. The `ur` source went 82 → 86 rooms (西本郷, 狭山台,
  パークタウン若宮, 北本 added; no rent changes); the rooms page has 80 open of 1517.
- **16 newly tracked properties** (Kawaguchi 7, Katsushika 3, Soka 2,
  Koshigaya 1, and UR in Kitamoto, Okegawa, Saitama Kita-ku). All 13 from the
  portals are ≥60㎡ (63.41–99.36㎡); UR's 北本 room is 45㎡ (UR is unfiltered).
  All geocoded. **5611** archival rows.

## 2026-10-14 refresh with the 60㎡ minimum and the wider UR sweep (Playwright)

- Run `2026-10-14T09-42-37-544Z-c5fdbc8c`: **SUCCESS**, no resume. Started
  from the worktree with `PLAYWRIGHT_USER_DATA_DIR` set to the main checkout's
  `.context/athome-profile`, so AtHome passed first time.
- Source additions: SUUMO **9**, AtHome **18**, RoomSpot **0**, Nifty **2**.
  The AtHome ads all matched properties already tracked.
- UR swept 74 of 74 municipalities (none skipped): 138 estates, 84 vacant
  rooms (76 with 2+ rooms), 202 API calls. The `ur` source still holds 82
  rooms, none added or gone; the rooms page has 84 open of 1517.
- **4 newly tracked properties** (Kawaguchi 2, Katsushika 1, Soka 1), all
  ≥60㎡ (62–109.3㎡) and geocoded. **5597** archival rows.

## 2026-10-13 refresh with the 60㎡ minimum (Playwright)

- Run `2026-10-13T13-22-24-921Z-526e721c`: **SUCCESS** after one resume.
  Run from a worktree, AtHome got a fresh browser profile and was shown its
  verification page; the resume pointed `PLAYWRIGHT_USER_DATA_DIR` at the main
  checkout's `.context/athome-profile` (with `ATHOME_VERIFY_WAIT_SECONDS=300`)
  and passed without a prompt. Every source/city stopped on two all-known pages
  or its last page.
- Source additions: SUUMO **21**, AtHome **17**, RoomSpot **6**, Nifty **37**.
- **24 newly tracked properties** (Soka 3, Koshigaya 5, Kawaguchi 10,
  Katsushika 6), all ≥60㎡ (60.02–146.24㎡), 11 ≥70㎡, 11 at ≤¥150,000, all
  geocoded. **5527** archival rows; none SOLD.

## 2026-10-12 Nifty site structure and end-of-results fix

Explored in the headed browser (Koshigaya, ≥60㎡), one list page and two
same-tab fetches:
- List URL `/rent/<pref>/<city>_ct/[<page>/]?sort=regDate-desc&r10=60` is
  valid: HTTP 200, the form shows `r10=60`, the sort stays newest-first, and
  the pager links carry the query. `<link rel=canonical>` drops the query
  (informational only). 40 rooms per page; 「物件数266件」 = 7 pages.
- Page 1's pager shows only 2–5 and 「>」, never the last page. The page after
  the last answers **HTTP 404 「ページが見つかりません」** (page 7: 200, page 8: 404).
- The search form (GET `/rent/saitama/search/`) also offers `r1`/`r2` rent,
  `r6` walk minutes, `r10`/`r11` area, `r12` building age
  (shin, 2–20 years), `r3` layouts (21=2K, 22=2DK, 24=2LDK, 31=3K, 32=3DK,
  34=3LDK, 41=4K, 42=4DK, 44=4LDK, 52=5DK, 54=5LDK以上; 10–14 are 1R–1LDK),
  `r14` 管理費込み, `r20` building type (1 マンション, 2 アパート, 3 一戸建て),
  `struct`, and `ex*` amenity checkboxes. Not adopted yet: `r3` would let
  Nifty drop 1R–1LDK rooms the parser already discards, after its own check.

Fix: `src/collectors/nifty/niftyCrawl.ts` is the crawl loop, now unit-tested.
The capture expression reports Nifty's not-found page distinctly; past page
1 it ends the city ("page N: no results; end of the city's results"), while
a 404 on page 1 or any other failure still stops the run. The tab now always
opens on page 1, so a cached page 1 plus a past-the-end page 2 cannot hang.
Each page is logged. Live check: a `--deep` Koshigaya crawl read its 7 cached
pages and ended on page 8 with exit 0.

## 2026-10-14 UR in all of Saitama and Noda (Playwright)

- `npm run scrape:ur` now sweeps every target city plus every active catalog
  municipality of Saitama (72) and Noda, Chiba (`urSweepCities`, scripts/scrape-ur.ts):
  74 municipalities, 138 estates (44 before; Noda has none), 84 vacant rooms,
  202 API calls. 76 of the rooms have 2+ rooms and go to the `ur` source
  (+69 new, 7 updated). A municipality UR answers HTTP 500 for is retried once,
  then skipped and left out of the sweep's scope, so nothing is concluded about it
  (one 500 was seen in a dry run, none in the real sweep).
- `npm run scrape:ur-history` read ラク賃 for the 94 new estates (93 read; 50_4130
  コンフォール西浦和田島 was HTTP 404). The rooms page lists 1517 rooms (81 open)
  in 138 estates.

## Entry points

`refresh.ts`, `lib/refreshPlan.ts`, `lib/refreshLedger.ts`: planning/checkpoints.
`import-capture.ts`, `lib/captureStore.ts`: capture import/cache.
`lib/{athome,roomspot,nifty}.ts`: pure list parsers and incremental merge.
`enrich-details.ts`, `lib/detailEnrichment.ts`: optional bounded SUUMO detail work, loaded in the headed browser (`src/collectors/shared/browserFetch.ts`). Detail pages carry 情報更新日 / 次回更新予定日, which the property documents keep.
`lib/observations.ts`: actual source evidence and lifecycle restoration.
`sync-properties.ts`, `src/data-layer/properties/`: additive per-property documents (`data/properties/`), synced by `data:build` and `check:availability`.
`enrich.ts`, `lib/geocodeCache.ts`: address caching.
`build-web-data.ts`, `src/domain/webPayload.ts`: dictionary payload + hydration (layout 3: attributes and their verbatim source texts are each written once; layout 2 is still read; `npm run data:web` writes it compact, and a test fails if the published file is not in that shape).
