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
- Refactor one importer at a time to submit validated observations through application use cases and `ListingRepository`.
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
- **M2 in progress:** `src/data-layer/migrations/registry.ts` applies contiguous, pure schema transformations in memory and validates the result; persisted files are not rewritten during reads. The Node-only converter in `scripts/lib/dataMigrations/legacyReference.ts` maps the existing variable-sized reference collections into v1 managed city, boundary, and place datasets without pulling filesystem/crypto code into the frontend package.
- `scripts/lib/jsonReferenceDataRepository.ts` reads the versioned catalog and supports revision-checked upserts/retirements. Changed datasets are written as immutable revision files and published by an atomic manifest update; old dataset versions are retained. Catalog updates validate record IDs, coordinates, polygon/multipolygon geometry, city references, retirement reasons, and manifest checksums.
- Added the explicit, additive `npm run data:reference:migrate` command. It wrote `data/reference/v1` without changing legacy files, refuses to overwrite a different existing catalog, and is idempotent for unchanged inputs. Current conversion has 5 cities, 5 boundaries, and 1,189 places (including 2 POIs); category counts and input checksums are in the generated manifest.
- Added tests for schema migration chaining/fail-closed behavior, variable POI counts, stable IDs, legacy-field preservation, manifest/source parity, revision conflicts, archive/retirement behavior, immutable versions, and multipolygon updates.
- **Validation:** `npm test` (283 tests), `npm run typecheck`, `npm run build`, `npm run data:status`, and the idempotent `npm run data:reference:migrate` pass. No live refresh or canonical `data:build` was run; source and listing counts remain unchanged. Scrapers still use compatibility `writeSource` wrappers until M3, and the frontend still uses its current bundled-data path until M4/M5. M2 still needs end-to-end legacy/catalog field parity review and an explicit persisted schema-upgrade command for future dataset versions.

## Per-milestone validation

At minimum, run `npm test`, `npm run typecheck`, and `npm run build`. For storage/ingestion milestones also run `npm run data:status`, adapter contract tests, and relevant refresh planning/tests. Inspect `git diff` and generated data paths after builds. A milestone is done only when its exit checks pass and the app remains usable; if not, revert that milestone before proceeding.
