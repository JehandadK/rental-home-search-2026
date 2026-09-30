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
- Capture list fields once, including fees, amenities and parking flags when
  present. Nifty now parses list cards instead of fetching each detail page.
- Cross-source deduplication precedes optional detail selection. Default refresh
  performs **zero detail requests**. `npm run detail:enrich -- --limit 10` opts
  into up to 10 SUUMO detail requests, with default rent <=150000 and size >=40.
- A detail fetch parses parking, lease, availability, fees, structure and amenities
  together. Valid HTML is cached; `--replay` re-parses it with zero requests.
  `--force` explicitly rechecks within the budget. Deferred URLs live in
  `data/detail-queue.json`, independent of scrape `newListingIds`.
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

## Parallel collection and the Playwright driver

- Collectors for different sources (SUUMO, AtHome, RoomSpot, Nifty) run at the
  same time; the three Nifty cities share `nifty.json`, so they run in order
  inside one group. `--concurrency N` caps it (`1` = fully sequential).
- Without the Pi Control Chrome bridge, set `BROWSER_DRIVER=playwright` (for
  example `BROWSER_DRIVER=playwright npm run refresh -- --resume`). It launches
  a local Playwright Chromium (`src/collectors/shared/playwrightBridge.ts`),
  **headed** by default: Nifty and AtHome serve a wait/verification page to
  headless Chromium. `PLAYWRIGHT_HEADLESS=1` opts out; `PLAYWRIGHT_EXECUTABLE_PATH`
  overrides the browser, else the newest cached Chromium is used.
- The AtHome collector still expects the old `#search-parameter` AJAX form; on
  the modern template it fails with "search form not found". See the AtHome
  city-path + `capture:athome-html` steps below.

## Agent-operated browser collection

Use the loaded pi-control-chrome Skill and native `browser_*` tools only. Do not
run the human CLI's direct-Bridge collectors from the agent shell.

1. Confirm browser identity; create at most one owned tab per portal. For
   Nifty/RoomSpot, use `wait: false`, then wait/read the required DOM rather than
   slow third-party assets. AtHome requires the homepage-first sequence below.
2. AtHome: **open `https://www.athome.co.jp/` first**, wait for the homepage to
   load, and inspect it before navigating the same tab to results. Do not create
   a cold tab at a deep search URL: that can trigger blocking and stuck reads.
   If the homepage is blocked or times out, stop for manual inspection; do not
   proceed to results, replay navigation, or restart the browser automatically.
   Then use the city-path search `/chintai/saitama/<city>-city/list/?sort=33`
   (`soka`, `koshigaya`, `kawaguchi`). As of 2026-09-29 the prefecture search
   `/chintai/saitama/list/?pref=11&cities=...&cityCds=...` ignores its city
   filter and returns Saitama-wide cards (the importer rejects them as wrong
   city). Pagination is `/list/pageN/`, retaining `?sort=33`. Verify
   `select[name=SORT]` is **33** in every response. Save each page's HTML and
   convert it with `npm run capture:athome-html -- --file <html> --url <pageUrl>
   --captured-at <iso>` before `capture:import`. This modern
   template uses `.property-card` / `.room-info-section` (mapping below), not
   `.p-property`, and honours the `?sort=33` query. Only the older `.p-property`
   template needed the AJAX form `SORT=33` (as `scripts/lib/athomeBrowser.ts`
   still sends); on that template the URL query alone did not select it.
3. RoomSpot: confirm `sort=new_arrival`; the existing page's public REST search
   parameters support each configured city, avoiding full navigations per city.
4. Nifty: newest is **sort=regDate-desc**, NOT the default `recommend` order.
   Verify the response's selected option. See `scripts/lib/niftyCapture.ts` for
   the bounded deterministic DOM projection (safe to use with native evaluate).
5. Capture only public property-card markup. Remove scripts, images, inputs,
   tracking attributes and unrelated page content. Retain parser-required
   class/title/href/data-bukken-no/data-transport-access attributes.
6. Keep each successful page in a transient task-owned in-page array until its
   local save is confirmed. Export `{ captures, errors }` to a JSON Blob, return
   **only its Blob URL/counts**, then use native `browser_download` with
   `action: "start"`, `wait: true`. Do not auto-click repeated downloads:
   Chrome may block them. Do not revoke the Blob before download confirmation.
7. Import the returned local path:
   `npm run capture:import -- --file <download-path>`.
   Continue each city until the import receipt says `STOP` after two consecutive
   all-known pages. Only pass `--max-pages N` when intentionally imposing a cap.
   This validates/parses locally, checkpoints each page, updates the source, and
   returns only added/refreshed counts and STOP/continue. Replays are idempotent.
   Once every required city reaches overlap/budget, the corresponding failed
   ledger stage is completed and dependent local stages are invalidated.
8. After all source captures: `npm run refresh -- --resume --local-only`.
   This prevents portal collection, but permits missing-address GSI geocoding.
   It imports cached Nifty details only if newer than list evidence, then merges,
   geocodes, and builds the dictionary-encoded dashboard payload.
9. `npm run build` validates and builds the dashboard. No browser cleanup command
   is needed; temporary Agent tabs follow normal host turn cleanup.

PageCapture schema: `schemaVersion:1, source, city, url, page, capturedAt,
httpStatus:200, sortedNewest:true, html`. Cities: Soka/Koshigaya/Kawaguchi.
Captures and progress receipts live in `data/.captures/`; never put full
HTML, source JSON, browser storage, cookies or tokens into model context.

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

## Entry points

`refresh.ts`, `lib/refreshPlan.ts`, `lib/refreshLedger.ts`: planning/checkpoints.
`import-capture.ts`, `lib/captureStore.ts`: native capture import/cache.
`lib/{athome,roomspot,nifty}.ts`: pure list parsers and incremental merge.
`enrich-details.ts`, `lib/detailEnrichment.ts`: optional bounded detail work.
`lib/observations.ts`: actual source evidence and lifecycle restoration.
`enrich.ts`, `lib/geocodeCache.ts`: address caching.
`build-web-data.ts`, `src/domain/webPayload.ts`: dictionary payload + hydration.
