# Data architecture migration plan

## Goal

Separate the frontend, application/data rules, storage, and ingestion so each can evolve independently. Preserve the usable app, current CLI workflows, and existing data throughout the migration. Do not combine a data rewrite with a frontend rewrite or a directory reorganization.

## Compatibility rules

- Every milestone must leave `npm run dev`, `npm test`, `npm run typecheck`, and `npm run build` usable.
- Keep existing JSON paths and schemas readable until an explicitly tested migration replaces them.
- Retain existing CLI commands and wrap them with adapters/use cases before changing their behavior.
- Preserve atomic writes, backups, shrink guards, source ownership, deduplication, lifecycle reconciliation, and refresh checkpoints.
- Filesystem read/compare/write operations must be serialized per dataset with an exclusive lock. Check `expectedRevision` only after acquiring that lock. Use unique temporary files in the same directory, flush before atomic rename where supported, and never auto-retry a stale write with new data. Lock recovery must be explicit and safe; do not remove a lock merely because it looks old.
- For a data format transition, use dual-read/parity checks first. Keep a versioned migration and a known-good backup. Do not delete the old representation until a later milestone has demonstrated parity.
- Do not run a live refresh as part of migration validation. Use tests, local fixtures, and `npm run refresh -- --plan` where relevant.
- Finish and verify one milestone before starting the next. Keep each milestone small enough to revert independently.

## Data ownership and update rules

1. **Reference datasets are managed, changing data—not compile-time constants.** Cities, boundaries, POIs, stations, schools, childcare facilities, bus stops, and future categories can be added, updated, or retired. Their IDs and counts come from the dataset; no consumer may infer identity from array position or assume a fixed number of cities or POIs.
2. **Stable IDs define identity.** Names, coordinates, and labels are changeable attributes. Dataset snapshots have a schema version, revision, update time, and provenance.
3. **Updates are explicit.** Apply upserts and explicit retirements; absence from a partial input is not removal. Reject a stale revision rather than overwriting a concurrent update. Preserve prior revisions/backups.
4. **Sources own observations, not canonical records.** An ingestion adapter submits source-scoped observations. The application/data layer validates them, resolves identity/deduplication, and controls lifecycle changes.
5. **Listing history is non-destructive.** Ingestion is idempotent. Incremental absence never means sold/deleted. Complete snapshots may trigger a lifecycle transition, but old records and provenance remain recoverable. Physical deletion/corrections require explicit, auditable operations.
6. **User data is separate.** Preferences, filters, marks, and manual edits cannot be overwritten by a source refresh.
7. **Storage is replaceable.** Domain/application contracts do not depend on JSON, TOON, filesystem paths, or a database. The browser talks to a client/API, never directly to filesystem or database storage.

## Public data-layer boundaries (clarified during M3)

- **Scraper input:** `ScrapeIngestion.ingestScrape(ScrapeSubmission)` in `src/data-layer/ingestion/contracts.ts` accepts full-listing observations (`ScrapeBatch`) or explicit partial-detail observations (`DetailPatchBatch`). Require a supported schema version, source, scraper name/version/parser version, run/batch IDs, capture time, scrape mode, scope, and source-scoped observations with capture evidence. Scrapers submit parsed observations, not merged source snapshots or storage revisions. The application layer chooses identity/deduplication, timestamp eligibility, detail preservation, and retirement rules; `ListingRepository` is its internal storage port.
- **Bounded SUUMO discovery:** `SuumoDiscoveryClient.beginSuumoDiscovery()` opens an application-owned session over one source revision. `stagePage()` validates producer/capture metadata and page/query/city sequence, maintains known/seen aliases, and returns novelty/overlap/duplicate counters and a stop reason. `commit()` runs once, after every configured city's bounded window finishes; it never interprets that window as a complete market snapshot. Collectors do not receive source rows or revisions, and failed/incomplete crawls leave the source unchanged while retaining cached pages. Exact source URLs/portal aliases identify observations; legacy generated display IDs alone do not.
- **Exact-row reconciliation:** the internal `ListingRepository.reconcileSource()` port checks unique ID/URL pairs and requires an explicit reason for every omitted prior pair. Rows, prior-ad archives, provenance, and ingestion receipts commit together under the expected revision and shrink guard. Unseen legacy duplicates are retained; only aliases actually absorbed by an eligible discovery are compacted. This is distinct from SOLD/lifecycle reconciliation and preserves the original display IDs of untouched records.
- **Replay and caching:** the scraper owns page/capture caching and must retain original observation times. The data layer independently fingerprints requests and records source/run/batch identity with producer metadata/evidence. Its journal and reconciled rows commit atomically under the source revision check. Same-ID/same-content replay is a no-op, including after newer batches; changed content under an existing ID is rejected. Concurrent revision conflicts are surfaced without automatic retry. Journals are additive and are not silently pruned.
- **Completeness:** discovery and detail enrichment cannot establish absence. New public full-snapshot submissions fail closed until a reviewed scope/exhaustion-evidence policy exists. Legacy Nifty detail observations may explicitly have unknown capture time; they can add missing rows, but cannot overwrite known rows or establish current availability. SUUMO detail patches require known capture times and existing exact source URLs; they cannot add/retire records, change identity/prices/lifecycle, or advance list-observation timestamps/completeness. Their independent per-URL detail timestamps prevent older cached details from rolling back newer details.
- **Detail selection:** `DetailEnrichmentPlanner.planDetailEnrichment()` returns eligible URLs after application-owned cross-source deduplication, completeness checks, and rent/size/layout filters. The collector owns the queue, fetch budget, backoff, and capture cache, but never reads source snapshots or merges stored listings. Internal `ListingRepository` enrichment uses `completeness: "preserve"` plus exact ID/URL locators; it preserves legacy row order, count, IDs, archives, source capture time, and completeness. Managed replay/detail-time provenance survives omission by older compatibility writers.
- **Derived source corrections:** `SourceCorrections.applyCorrection()` in `src/data-layer/corrections/contracts.ts` accepts a supported schema/source/rule version, operation ID, actor, and reason—not replacement rows or arbitrary field patches. The application reads current stored evidence and commits exact ID/URL updates plus a protected `correctionJournal` atomically under the observed source revision. Audit entries retain the input revision, rule metadata, application time, source notes, and field-level before/after values (unset, null, and zero stay distinct). Committed operation IDs replay without reapplying to newer data; changed metadata under the same committed ID conflicts. Missing-source and no-change results deliberately create no receipts/writes/backups; fresh CLI runs remain true no-ops when the rule has nothing to change. The actor is local audit metadata, not an authentication mechanism; any future API must add M6 authorization.
- **Historical source bootstrap:** `SourceBootstrap.bootstrapSources()` in `src/data-layer/bootstrap/contracts.ts` validates a versioned migration, operation ID, actor, reason, dataset identity, and the entire legacy input before accessing target sources. It groups by the original source (missing/null/empty source goes into `unknown` without rewriting the row), skips existing sources unconditionally, and uses the internal create-only `ListingRepository.initializeHistoricalSource(..., { expectedRevision: null })` port. Creation preserves every row, order, missing/colliding ID, unknown field, and lifecycle value; it never deduplicates or normalizes historical rows. Audit metadata/fingerprints commit atomically with each source. Source existence—not operation ID—is the idempotency key; completed source checkpoints survive later failures, while concurrent creators conflict without retry. Portable source-ID and lossless-JSON validation prevent unsafe paths and silent coercions.
- **Bootstrap time compatibility:** the existing string `scrapedAt` slot holds import time only for the tagged initial historical envelope. `bootstrapAudit.importedAt` records its true meaning; `completeSnapshot` is false and observation keys/times are empty. Consumers must not treat this envelope time as capture evidence or a freshness barrier for unobserved historical rows. `sourceObservationTime` helpers, Nifty eligibility, native-capture eligibility, and `data:status` handle that distinction; original row timestamps remain unchanged. `bootstrapAudit` is protected across compatibility provenance replacement and reserved from ordinary scrape submissions.
- **Consumer side (planned, not implemented by this M3 step):** asynchronous listing queries/detail reads and reference snapshots in M5. A separate shared-fact submission use case will accept listing ID, revision, actor, evidence, and timestamped facts/corrections. Property-specific eligibility/restriction information belongs there with unknown/conditional/disputed states and provenance, not in personal preferences and not as an unchecked canonical overwrite. Personal filters, favorites, and notes remain in the M4 user-data boundary; transport/auth/shared-write implementation remains M6 work.
- Existing importer-to-`ListingRepository` migrations are an intermediate step. Each importer must eventually use the metadata-gated public ingestion service; canonical cross-source deduplication/lifecycle and enrichment remain explicit derived operations.

## Current baseline

Captured before migration work:

- Source records: AtHome 2,011; Nifty 985; RoomSpot 297; SUUMO 2,317; Yahoo 1.
- `listings_raw.json`: 3,455 records. Its manifest reports 3,248 contributed rows before the canonical history/lifecycle total (per-source contributed counts sum to this lower number due to cross-source duplicate merging).
- `npm run data:web` emits 3,452 browser listings after a final 3-record deduplication.
- `npm test`: 252 tests pass; typecheck and production build pass. Production build currently warns that the bundled JS chunk is over 500 kB; bundled data is a known frontend coupling to remove.

These numbers are migration comparison points, not permanent expectations. Refresh activity can change them; compare parity against the captured input files/manifest for a migration rather than requiring future live counts to remain fixed.

### Filesystem-lock operating limits

M1 adds local-filesystem lock files, unique same-directory temp files, file sync, and atomic rename. Do not treat lock files as a distributed lock service; a shared/network filesystem or multi-host deployment should use a database/service with native transactions instead. If a process crashes and leaves a lock, inspect its JSON metadata and verify the PID is no longer running before removing that exact lock file. For example, inspect `src/data/.sources.lock` or the affected `<file>.lock`, check the recorded PID with `ps -p <PID>`, and only then remove the specific stale lock with `rm <lock-path>`. Never remove a lock based only on its age. A corrupt/empty lock also requires checking for active writers before manual removal.

## Milestones

### M0 — Baseline and guardrails (no runtime behavior change)

**Scope:** Record the current test/build/data status; identify all read/write paths and who owns each file. Confirm a clean working tree or explicitly account for pre-existing changes.

**Exit checks:** Baseline is written here; current tests, typecheck, build, and `data:status` work. No production/runtime data was changed.

**Rollback:** Documentation-only; no operational rollback required.

### M1 — Repository contracts and compatible JSON adapter

**Scope:**
- Define repository contracts for versioned reference datasets, source listing observations, canonical listing reads, and user data. Writes carry the revision observed by the caller (including an explicit `null` for a not-yet-created source/key).
- Implement the current source-file behavior behind a JSON adapter. Keep `scripts/lib/dataStore.ts` exports as compatibility wrappers initially, so scraper/refresh scripts do not all need to change at once.
- Add a reusable adapter contract-test suite with a small factory/harness. Run the same tests against every implementation (initial JSON adapter, then any future database adapter): idempotent ingestion, complete versus incremental batches, retirements/history, `expectedRevision` conflicts, and preservation of user/source ownership.
- Test filesystem race behavior with two writers using the same expected revision: exactly one may commit and the other must receive a conflict. Test crash/failed-write paths to ensure the last committed file remains readable.
- Serialize read/compare/write under an exclusive per-dataset lock. Write unique temp files in the destination directory, flush and atomically rename. Keep temp files and locks scoped by dataset, and provide a documented/manual stale-lock recovery path rather than unsafe auto-breaking.
- Do not move/rename data files or change scraper outputs in this milestone.

**Exit checks:** All current CLI scripts and existing data tests pass unchanged; the reusable contract suite runs against the JSON adapter in a temporary directory; concurrent-writer tests pass; status/build output and production data files have not been rewritten by tests.

**Rollback:** Restore the previous wrapper implementation; no data migration has happened.

### M2 — Managed reference datasets with parity migration

**Scope:**
- Add a versioned catalog representation for cities, boundaries, and places, including arbitrary POI counts and stable place IDs. Support polygon and multipolygon boundaries.
- Adapt existing reference JSON files into the catalog using a one-time, repeatable migration tool. Keep original files readable and unchanged during the first pass.
- Add a read adapter for existing files and a managed JSON/TOON adapter behind `ReferenceDataRepository`.
- Store pure, ordered schema migrations under `src/data-layer/migrations/`, grouped by dataset and named by version transition (for example `reference/v1-to-v2.ts`). A registry applies each missing migration sequentially in memory, validates the result, and fails closed on an unknown future schema version.
- Normal reads do not silently rewrite files. An explicit migration command backs up the original, migrates and validates into a temp file, then atomically replaces it; retain the backup so rollback is a restore, even if a reverse migration is unavailable. Test each migration with versioned fixtures and verify IDs/data preservation.
- Compare per-category record counts, stable IDs, coordinates, boundary points/rings, and checksums. Include source/provenance metadata.

**Exit checks:** Old and new readers produce equivalent app-visible data for the current dataset; no record is lost; adding/retiring a city, boundary, or POI in fixtures updates the snapshot without code changes.

**Rollback:** Switch back to the old-file reader; retain generated catalog and originals for diagnosis. Do not delete or overwrite source files.

### M3 — Controlled ingestion and writes

**Scope:**
- Refactor one importer at a time to submit validated observations through the metadata-gated `ScrapeIngestion` application boundary; its implementation owns matching/merge decisions and uses `ListingRepository` internally. Keep compatibility exports while previously migrated importers are upgraded.
- Preserve complete versus incremental snapshot semantics and current provenance/capture workflow.
- Keep canonical list generation and enrichment as explicit derived operations.
- Remove direct writes from importer code only after its adapter-backed replacement has passed parity tests.

**Exit checks:** Existing `scrape`, `refresh`, capture import, enrichment, and data build commands keep their names and expected outputs. Replay tests show repeated imports are idempotent and partial/failed imports cannot erase unrelated records or user data.

**Rollback:** Revert the affected importer to its compatibility wrapper. Preserve both pre- and post-run source backups; never roll back by deleting canonical history.

### M4 — Frontend user-state boundary

**Scope:**
- Put `localStorage` behind a `UserDataRepository` browser adapter for configuration, filters, place selection, marks, custom listings, and hidden columns.
- Preserve current storage keys and add explicit versioned migrations for any changed shapes.
- Introduce a fake/in-memory adapter for UI tests.

**Exit checks:** Existing settings survive reloads; corrupt/old state still falls back safely; UI/domain code uses the adapter instead of direct storage access; app behavior is unchanged.

**Rollback:** Keep the existing keys and old loader available during the transition; fall back to the current browser adapter.

### M5 — Frontend data client and dynamic reference data

**Scope:**
- Replace direct JSON imports in `src/domain/reference.ts` with an injected client. Begin with a bundled/static client that returns the same data, then add a runtime dataset client with a bundled fallback.
- Model `loadSnapshot()` as asynchronous at the React boundary. Add explicit loading, error/retry, and empty-data states (or a Suspense boundary with an error boundary); do not render components that assume a catalog exists until loading succeeds. Test slow, failed, stale-fallback, and empty responses.
- Pass the loaded snapshot into place catalogs, proximity indexes, maps, filters, and enrichment instead of importing module-level arrays.
- Derive city options, boundary rendering, POI selection, labels, and map extent from the loaded datasets. Handle empty catalogs, multiple boundaries per city, and new POI counts/categories.
- Do not change scoring results for the current data as part of dependency injection. Any scoring model changes need their own explicit migration.

**Exit checks:** Current fixture gives equivalent scores, map, filters, and place options; tests add/remove cities and POIs without code edits; the frontend can run against a fake client; it no longer imports persisted data files.

**Rollback:** Select the bundled compatibility client. The old JSON files remain unchanged until parity has been demonstrated.

### M6 — Durable API for shared UI writes (only when required)

**Scope:**
- Add an API client/server boundary for manual listings and any user data that must be shared across devices or with ingestion.
- API handlers call the same application use cases/repositories as CLI ingestion. Add validation, authorization, revision checks, and auditable write reasons.
- Keep browser-local preferences browser-local unless there is a product requirement to synchronize them.

**Exit checks:** API integration tests exercise accepted, rejected, repeated, stale-revision, and unauthorized writes. Static/read-only mode remains usable if the API is unavailable.

**Rollback:** Switch the client back to local/static mode. No UI code should depend on a particular database engine.

### M7 — Physical package/repository reorganization (last, optional)

**Scope:** Move code only after logical boundaries and tests are established; e.g. `apps/web`, `packages/domain`, `packages/application`, `packages/storage-json`, and `packages/ingestion`. Move managed data out of frontend source directories without folding the move into a schema change.

**Exit checks:** All app, CLI, test, and build commands still work; package dependency direction is enforced; no frontend package imports Node filesystem code.

**Rollback:** Revert file moves independently; no data conversion is part of this milestone.

## Progress and changes already made

- `src/data-layer/contracts.ts` defines initial storage-independent contracts for versioned cities, boundaries, places, source observations, listings, and user data. Listing batches and user writes carry an explicit expected revision.
- `PointOfInterest.id` is now a string instead of a two-value union, to avoid encoding POI cardinality in the type.
- **M1 complete:** `scripts/lib/jsonFile.ts` uses exclusive per-path lock files, unique same-directory temp files, file sync, atomic rename, and manual-only stale-lock recovery. `atomicWriteJson()` uses this primitive.
- `JsonSourceStore` serializes source read/compare/write transactions, hashes legacy files to provide an initial revision, persists revisions on the next successful write, and rejects stale expected revisions. Existing source-writing scripts now pass the revision they read. Shrink checks and backups remain in place.
- `JsonListingRepository` implements source observation ingestion. Incremental batches preserve unseen rows; complete batches move absent rows into an archive; repeated observations are idempotent. A reusable contract suite in `scripts/lib/listingRepository.contract.ts` runs against the JSON adapter and is designed to be reused by future adapters.
- Added `updateJsonFile()` for serialized read/modify/write operations; refresh-ledger updates use it. Source builds share a transaction lock with source writes. Standalone geocode/detail enrichment runs are mutually exclusive to prevent stale-cache/queue overwrites.
- Added tests for lock serialization, atomic failure safety, manual stale-lock behavior, legacy revision upgrades, concurrent stale writers, idempotent ingestion, incremental preservation, complete-snapshot archives, and shrink-guard preservation.
- **M1 adapter work is complete:** the reusable `ListingRepository` contract suite runs against the JSON adapter; source updates/builds, refresh-ledger updates, geocode-cache writes, and detail-queue writes are serialized at their read/modify/write boundary. Manual lock recovery instructions are documented above.
- **M2 complete:** `src/data-layer/migrations/registry.ts` applies contiguous, pure schema transformations in memory and validates the result; persisted files are not rewritten during reads. The Node-only converter in `scripts/lib/dataMigrations/legacyReference.ts` maps the existing variable-sized reference collections into v1 managed city, boundary, and place datasets without pulling filesystem/crypto code into the frontend package.
- `scripts/lib/jsonReferenceDataRepository.ts` reads the versioned catalog and supports revision-checked upserts/retirements. Changed datasets are written as immutable revision files and published by an atomic manifest update; old dataset versions and manifest checkpoints are retained. Catalog updates validate record IDs, coordinates, polygon/multipolygon geometry, city references, retirement reasons, and manifest checksums.
- Added `npm run data:reference:upgrade` for explicit persisted schema/catalog upgrades. Reads may use the registered pure migrations in memory, but writes are blocked until the upgrade command has published the current schema. It retains immutable old dataset files and a manifest checkpoint; the catalog root revision includes dataset schema versions. The existing catalog was upgraded to the schema-aware root revision without rewriting its place/city/boundary records.
- Added the explicit, additive `npm run data:reference:migrate` command. It wrote `data/reference/v1` without changing legacy files, refuses to overwrite a different existing catalog, and is idempotent for unchanged inputs. Current conversion has 5 cities, 5 boundaries, and 1,189 places (including 2 POIs); category counts and input checksums are in the generated manifest.
- Added tests for schema migration chaining/fail-closed behavior, variable POI counts, stable IDs, legacy-field preservation, manifest/source parity, revision conflicts, archive/retirement behavior, immutable versions, and multipolygon updates.
- **M2 validation:** `npm test` (285 tests), `npm run typecheck`, `npm run build`, `npm run data:status`, `npm run data:reference:migrate`, and `npm run data:reference:upgrade` pass. Migration tests compare every current legacy place field and every boundary ring, verify variable counts/category parity, and exercise idempotency, revision conflicts, immutable versions, in-memory schema migration, and explicit persisted upgrades. No live refresh or canonical `data:build` was run; source and listing counts remain unchanged.
- **Initial M3 repository migrations:** RoomSpot, AtHome, and direct SUUMO collectors, plus the native-browser capture importer for SUUMO/AtHome/Nifty/RoomSpot, were first routed through `JsonListingRepository.ingest` with merged source rows. Subsequent public-boundary upgrades are recorded below. Known duplicate/superseded source IDs are explicitly retired with a reason; incremental absence alone still does not remove a row. Repository contract and source-specific tests cover both cases. No scraper or capture import was run during this migration.
- The initial Nifty list crawler migration introduced per-page `ingestNiftyListPage` (`scripts/lib/niftyIngestion.ts`) with an injected repository. It has since been upgraded to the public ingestion boundary described below. Browser capture/spooling, city/page/deep flags, overlap stopping, discovery output, and observation provenance are unchanged. Fixture tests verify legacy merge parity, retained details/unseen cities, explicit superseded-ID archives/backups, source/user/canonical isolation, failed-page checkpoint preservation, and stale-revision rejection without retry. Replay tests also caught and fixed an empty `tenancy` object being invented by the merger on a second import; identical captures now retain their revision without extra backups.
- Added the storage-independent `ListingIngestionService` with Nifty discovery/detail policies, strict producer/schema/scope validation, canonical-field ownership checks, and an atomically persisted ingestion journal in source provenance. Pure Nifty matching/merge and observation-batch rules now live under `src/data-layer/`; old script exports remain compatible. Tests cover durable replay after newer writes/restart, conflicting batch IDs, unknown/old timestamps, invalid metadata/evidence, superseded-ID history, failed commits, and concurrent conflicts without retries. Foundation validation: 318 tests, typecheck, and build pass; subsequent CLI migrations are below.
- `scripts/merge-nifty.ts` (`import:nifty`) now submits only parsed observations and versioned capture metadata to `ScrapeIngestion.ingestScrape`; it no longer reads source state or selects/merges updates. The data-layer policy preserves newer-only detail updates and unknown legacy timestamps. `--force`, `--verbose`, discovery counts, and explicit next-step build/enrichment commands remain. Missing parking text now omits the field rather than emitting an `undefined` overwrite, retaining prior parking evidence. Tests cover isolated full checked-in dump/source parity, replay, alias archives, failed captures, shrink/force behavior, and source/user/canonical isolation.
- The Nifty list crawler now also submits only parsed observations through `ScrapeIngestion`, with deterministic capture/run/batch identity, producer versions, URL/city/filter/page scope, and original capture timestamps. Its adapter no longer reads or merges stored rows. Fresh and spooled copies share an identity; replays neither write nor double-count discoveries. The data-layer policy additionally prevents an older cached page from rolling back newer price evidence. Browser caching, CLI flags, page checkpoints, overlap stopping, and output format remain in place.
- `scripts/enrich-details.ts` and its unchanged `backfill:parking` alias now use the public URL-planning/detail-patch boundary. Partial fields are allowlisted and merged in `suumoDetailPolicy`, not the collector; captured HTML remains independently cached. Offline tests cover defaults/flags, budgets, backoff/circuit breaking, cached/fresh/failed captures, queue retention, commit failure/replay, original timestamps, stale details, snapshot completeness, archives, source/user/canonical isolation, and concurrent changes. The output format remains; `applied` now counts accepted detail observations (zero on an idempotent replay), not merely parsed captures.
- Full-source parity exposed 43 legacy SUUMO ID-collision groups (45 rows would be lost by an ID-keyed Map). Existing-row enrichment now matches exact ID/URL pairs and keeps every other row, including colliding IDs, untouched. A temporary-copy test compares all current SUUMO rows with the old detail overlay; no production file was rewritten. Future SUUMO discovery/backfill migrations must account for these legacy collisions rather than assume generated IDs are unique.
- `scripts/backfill-suumo.ts` (`data:backfill`) now requests the audited `suumo-notes-backfill` v1 rule through `SourceCorrectionService`; the CLI no longer reads or rewrites source data. The rule preserves the old floor/total-floor parsing and unknown-admin-fee semantics, original observation times, lifecycle/completeness, archives, row order, and colliding ID/URL pairs. `backfilledAt` advances only for a changing commit. Shared text parsing/content fingerprints were extracted into pure data/domain helpers with compatibility exports. Tests cover legacy rule/full-source parity, explicit unset/null/zero audit values, unknown-field preservation, CLI output/missing-source behavior, durable replay after later source writes, malformed/future requests/journals, failed writes, concurrent conflicts without retry, and source/user/canonical isolation.
- `scripts/migrate-sources.ts` (`data:migrate`) now reads the legacy input and delegates grouping/creation to `SourceBootstrapService`; it no longer writes source files. The CLI retains missing-input, per-source creation/skip, next-step output, and resumable partial-progress behavior. A reusable repository contract covers create-only races, source ownership, verbatim legacy shapes/duplicates, and empty observation evidence. Application tests cover metadata/input validation before any target access, no-op replays/changed-input skips, partial commit failure/resume, input ownership across awaits, real captures after historical bootstrap, lifecycle preservation, and isolated parity for all 3,455 current canonical rows. The input file and pre-existing/unrelated sources remain untouched.
- `scripts/scrape.ts` now submits parsed SUUMO pages through the public staged discovery interface, with versioned metadata and original capture timestamps/year. It no longer reads source snapshots, determines overlap, merges rows, or writes the repository directly. The data layer preserves the two-all-known-page stop, deep/page budgets, all-cities-before-commit behavior, source revision read at crawl start, `--force` shrink protection, and the guarded `--full` behavior. Missing-source guidance now points to the supported historical bootstrap instead of the disabled `--full` path; the final log no longer suggests that a capped/full flag can authorize SOLD detection.
- New SUUMO ingestion preserves expensive nested detail fields absent from summary cards, rejects stale price replays, retains unobserved historical aliases, and archives every superseded exact ID/URL pair. Legacy helper exports remain available to not-yet-upgraded capture imports. Tests cover metadata/scope validation, source-ID collisions, exact URL fallback, archive/shrink behavior, source/user/canonical isolation, staging failures, commit-once semantics, capture cache identity, original-year parsing, replay after newer writes, and concurrent changes without retry. A temporary-copy test accounts for every current SUUMO row and verifies legacy merge survivors remain equivalent, with unseen old duplicates additionally retained.
- **Last verified committed M3 checkpoint — `67c90b3`:** `npm test` (471 tests), typecheck, production build, `refresh -- --plan`, `data:status`, and a dev-server HTTP smoke check pass. These results apply to that commit, **not** to the paused, uncommitted worktree described below. Hash comparison confirms all 445 persisted files under `src/data/` and `data/` are unchanged. No live collector, production migration/import/enrichment/backfill, or canonical `data:build` was run. No CLI importer directly calls `writeSource`; remaining calls are in the JSON storage adapter/compatibility wrapper. AtHome, RoomSpot, and the multi-source capture importer still need upgrading from the internal repository port to the public metadata-gated interface. The frontend remains on its bundled path until M4/M5; consumer/shared-fact interfaces are documented targets, not implemented runtime APIs yet.
- **Restart here:** read the paused-worktree section below and inspect `git status`/`git diff` before making changes. Resolve the known type error and review the unfinished shared plumbing before wiring the remaining CLI adapters. The user wants the rest of M3 completed in one implementation pass when resumed, with no M4/M5 work or directory/package reorganization; retain independently reviewable commits per writer and do not claim M3 complete before its exit checks pass.

## Paused worktree — M3 is not complete

Implementation is paused at the user's request. **Do not treat the current worktree as a tested checkpoint or run its live collectors/importers.** The last known-good commit is `67c90b3` (`Route SUUMO discovery through public ingestion sessions`). No unfinished implementation has been committed. This pause update changes the plan only; the code edits below are retained for review/resumption, not discarded.

### Uncommitted work already started

- **Portal rules extracted:** `src/data-layer/ingestion/portalPolicy.ts` contains AtHome/RoomSpot identity, legacy compatibility merge/batch exports, and a draft public ingestion policy. `scripts/lib/athome.ts` and `scripts/lib/roomspot.ts` keep their parsers and re-export the moved rules. The public policy is intended to preserve unseen historical duplicates and RoomSpot's nested detail fields; parity tests still need to verify this.
- **Portal discovery sessions drafted:** `src/data-layer/ingestion/portalDiscovery.ts` and additions to `src/data-layer/ingestion/contracts.ts` introduce staged AtHome/RoomSpot discovery, including automatic deep bootstrap, bounded page sequencing, empty non-family page handling, and a single source commit. These are **not wired into either collector yet**.
- **Exact reconciliation extended:** `SourceReconciliation.expectedRevision` now permits `null`, and `scripts/lib/jsonListingRepository.ts` has draft create-on-first-observation support under the existing locked revision check. `src/data-layer/ingestion/reconciliation.ts` builds explicit exact-row retirements. Nifty's policy has been switched to this port as well; existing Nifty tests that spy on the old `ingest` port need review/adaptation.
- **Capture boundary plumbing drafted:** `scripts/lib/listCaptureBatch.ts` parses captures from all four portals into observation batches. The service now recognizes AtHome/RoomSpot list producers and a `native-capture` producer. SUUMO's policy has a draft missing-source path for native captures only; the direct SUUMO collector's existing-source requirement is unchanged.
- **Checkpoint recovery support drafted:** ingestion receipts/journal entries can retain original `effect` counts so replay after a source commit but failed progress-file write can repair counts without reapplying observations. `annotateCaptureRun()` is a draft metadata-only application operation replacing the capture importer's direct source annotations. `captureSummary` is reserved/protected in source provenance. Neither path has been wired or tested end-to-end yet.
- **CLI wiring remains untouched:** `scripts/scrape-athome.ts`, `scripts/scrape-roomspot.ts`, and `scripts/import-capture.ts` still use their prior repository-backed flow. Browser navigation, progress-file writes, and refresh-ledger integration have not yet been refactored in this pass.

New, untracked files at pause:

- `scripts/lib/listCaptureBatch.ts`
- `src/data-layer/ingestion/portalDiscovery.ts`
- `src/data-layer/ingestion/portalPolicy.ts`
- `src/data-layer/ingestion/reconciliation.ts`

Other modified implementation files are `scripts/lib/athome.ts`, `scripts/lib/roomspot.ts`, `scripts/lib/jsonListingRepository.ts`, `src/data-layer/contracts.ts`, `src/data-layer/ingestion/contracts.ts`, `src/data-layer/ingestion/niftyPolicy.ts`, `src/data-layer/ingestion/service.ts`, `src/data-layer/ingestion/suumoPolicy.ts`, and `src/data-layer/sourceProvenance.ts`. No new tests have been added in this unfinished pass.

### Validation at pause

- `npm run typecheck` **fails** at `src/data-layer/ingestion/suumoPolicy.ts:31:44`: `TS2339: Property 'observedAtByKey' does not exist on type 'Readonly<Record<string, unknown>> | {}'`. The draft empty-source fallback needs correctly typed provenance (or a read through the nullable original snapshot).
- Tests/build/refresh planning have **not** been rerun for these uncommitted changes. Do not reuse the earlier 471-test/build result as validation of this worktree.
- A read-only hash comparison against the start of this pass confirms **all 445 persisted files under `src/data/` and `data/` are unchanged**. No live scrape, production capture import, migration, enrichment, backfill, or canonical build was run.

### Remaining plan to close M3

1. **Stabilize the shared plumbing:** fix the type error, review nullable-revision creation and exact-row retirement safety, run existing tests, and adapt only tests whose internal port legitimately changed. Keep the scope to ingestion boundaries; avoid further framework expansion or file reorganization.
2. **Finish AtHome:** wire its existing browser/capture/cache loop to the public portal session. Preserve first-run deep bootstrap, two-known-page stopping, empty-page behavior, budgets, `--force`, guarded `--full`, browser cleanup, and CLI output. Add offline parsing/merge parity, replay, failure, and revision-conflict coverage.
3. **Finish RoomSpot:** use the same tested session boundary while preserving its URL construction, browser flow, timing/budget behavior, source-specific matching, and detail retention. Add equivalent isolated tests. Verify each writer before its own commit.
4. **Finish native capture import:** submit parsed observations only; keep capture spooling, existing progress-file schema/receipt hashes, `--file`/`--run-id`/`--max-pages`, refresh locking, ledger stage completion, and downstream invalidation. Move source annotations behind the application method. Test the source-commit/progress-write failure gap using stored original effects so retries neither lose nor double-count additions. Preserve legacy progress files, stale-capture filtering, empty non-family pages, per-page persistence, mixed-source imports, and error exit behavior.
5. **M3 exit audit:** confirm importer code no longer reads source snapshots to merge/write them, while canonical generation and enrichment remain explicit derived commands. Run all tests (including repository contracts and refresh tests), typecheck, build, `data:status`, `refresh -- --plan`, and a dev smoke check. Compare persisted data hashes/counts and inspect the final diff. Use temporary datasets/fixtures only. Mark M3 complete and update the next milestone only once these checks pass.

## Per-milestone validation

At minimum, run `npm test`, `npm run typecheck`, and `npm run build`. For storage/ingestion milestones also run `npm run data:status`, adapter contract tests, and relevant refresh planning/tests. Inspect `git diff` and generated data paths after builds. A milestone is done only when its exit checks pass and the app remains usable; if not, revert that milestone before proceeding.
