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

- **Scraper input:** `ScrapeIngestion.ingestScrape(ScrapeBatch)` in `src/data-layer/ingestion/contracts.ts`. Require a supported schema version, source, scraper name/version/parser version, run/batch IDs, capture time, scrape mode, scope, and source-scoped observations with capture evidence. Scrapers submit parsed observations, not merged source snapshots or storage revisions. The application layer chooses identity/deduplication, timestamp eligibility, detail preservation, and retirement rules; `ListingRepository` is its internal storage port.
- **Replay and caching:** the scraper owns page/capture caching and must retain original observation times. The data layer independently fingerprints requests and records source/run/batch identity with producer metadata/evidence. Its journal and reconciled rows commit atomically under the source revision check. Same-ID/same-content replay is a no-op, including after newer batches; changed content under an existing ID is rejected. Concurrent revision conflicts are surfaced without automatic retry. Journals are additive and are not silently pruned.
- **Completeness:** discovery and detail enrichment cannot establish absence. New public full-snapshot submissions fail closed until a reviewed scope/exhaustion-evidence policy exists. Legacy detail observations may explicitly have unknown capture time; they can add missing rows, but cannot overwrite known rows or establish current availability.
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
- **M3 in progress:** RoomSpot, AtHome, and direct SUUMO collectors, plus the native-browser capture importer for SUUMO/AtHome/Nifty/RoomSpot, now submit merged source rows through `JsonListingRepository.ingest`. Known duplicate/superseded source IDs are explicitly retired with a reason; incremental absence alone still does not remove a row. Repository contract and source-specific tests cover both cases. No scraper or capture import was run during this migration.
- The Nifty list crawler now checkpoints each page through `ingestNiftyListPage` (`scripts/lib/niftyIngestion.ts`), an injected `ListingRepository` use case using `sourceObservationBatch`. Browser capture/spooling, city/page/deep flags, overlap stopping, discovery output, and observation provenance are unchanged. Fixture tests verify legacy merge parity, retained details/unseen cities, explicit superseded-ID archives/backups, source/user/canonical isolation, failed-page checkpoint preservation, and stale-revision rejection without retry. Replay tests also caught and fixed an empty `tenancy` object being invented by the merger on a second import; identical captures now retain their revision without extra backups.
- Added the storage-independent `ListingIngestionService` with Nifty discovery/detail policies, strict producer/schema/scope validation, canonical-field ownership checks, and an atomically persisted ingestion journal in source provenance. Pure Nifty matching/merge and observation-batch rules now live under `src/data-layer/`; old script exports remain compatible. Tests cover durable replay after newer writes/restart, conflicting batch IDs, unknown/old timestamps, invalid metadata/evidence, superseded-ID history, failed commits, and concurrent conflicts without retries. Foundation validation: 318 tests, typecheck, and build pass; importer wiring is the next step.
- **Previous CLI migration checkpoint:** `npm test` (300 tests), typecheck, production build, `refresh -- --plan`, and `data:status` pass; the dev server serves the app entry point. Hash comparison confirms all 445 persisted files under `src/data/` and `data/` are unchanged (including capture/checkpoint files); source/listing counts remain unchanged. No live collector, import, enrichment, or canonical `data:build` was run. Pending writers to migrate: Nifty detail import, detail and parking backfills, and one-time source migration. The frontend still uses its bundled-data path until M4/M5.
- **Restart here:** check `git status` and this checkpoint, then migrate `scripts/merge-nifty.ts` (`npm run import:nifty`) through `sourceObservationBatch` + `ListingRepository.ingest`, preserving its timestamp eligibility rules and `--force`/`--verbose` flags. Do not run a live scraper or production import for migration validation. Continue one writer per commit, preserving CLI flags and source merge semantics.

## Per-milestone validation

At minimum, run `npm test`, `npm run typecheck`, and `npm run build`. For storage/ingestion milestones also run `npm run data:status`, adapter contract tests, and relevant refresh planning/tests. Inspect `git diff` and generated data paths after builds. A milestone is done only when its exit checks pass and the app remains usable; if not, revert that milestone before proceeding.
