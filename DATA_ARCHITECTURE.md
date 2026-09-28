# Data architecture migration plan

## Goal

Separate the codebase into three independently evolvable layers—**collectors** (scrapers and importers), the **data layer** (application rules plus replaceable storage adapters), and the **web frontend**—over a shared, pure domain model. Each layer lives in its own directory and talks to the others only through published contracts; dependency direction is enforced by tests, not convention (see "Target layers and dependency rules"). Preserve the usable app, current CLI workflows, and existing data throughout the migration. Do not combine a data rewrite with a frontend rewrite or a directory reorganization.

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

## Target layers and dependency rules

Established by M4. Locations are directories inside this one package; converting them to workspace packages is the optional M8.

| Layer | Location | Owns | May import |
|---|---|---|---|
| Domain | `src/domain/` | Shared types (`RawListing`, places, scoring keys), scoring configuration, and pure rules: identity keys, deduplication, Japanese text parsing, scoring, filters | Only `src/domain/`. No Node, React, DOM, or network APIs. |
| Data layer (application) | `src/data-layer/` | Public contracts, ingestion/correction/bootstrap services, per-source identity/merge/detail policies, lifecycle rules, schema migrations | Domain |
| Storage adapters | `src/storage/json/` | Filesystem implementation of data-layer ports: source store, listing and reference repositories, catalog files, derived canonical build | Data layer, domain, `src/node/` |
| Collectors | `src/collectors/` | Browser/HTTP fetching, capture cache, per-site HTML parsers, collection loops (page budgets, stopping, backoff), building submissions | Data-layer **contracts and errors only** (`**/contracts.ts`, `errors.ts`, `contentIdentity.ts`), domain, `src/integrations/`, `src/node/` |
| Refresh orchestration | `src/refresh/` | Refresh plan, run ledger, stage ordering across collectors | Collectors, data layer, storage, domain, `src/node/` |
| Web | `src/web/` | React app, hooks, components, CSV export, browser adapters | Domain, `src/integrations/`, and type-only imports of data-layer contracts. Never services, policies, storage, collectors, or Node. |
| CLI | `scripts/` | Argument parsing, composing adapters with services, logging, exit codes | Anything above. Nothing imports a CLI file. |
| Shared platform code | `src/node/`, `src/integrations/` | `node/`: generic filesystem primitives (locks, atomic writes, data-root paths) with no domain knowledge. `integrations/`: browser-safe external API clients (geocoding). | `node/`: Node built-ins only. `integrations/`: domain and `fetch` only. |

Rules:

- **Collectors only submit.** They reach the data layer through public contracts and a client injected by the CLI composition root. They never import policies, service internals, or storage, and never re-export them for compatibility.
- **Source policies stay in the data layer, behind a registry.** The data layer owns identity and deduplication, so SUUMO/Nifty/portal matching, merge, and detail policies remain there. A `SourcePolicy` registry keyed by source lets a new site add one policy file plus one collector without editing the ingestion service. HTML parsing stays in collectors.
- **Data files are storage, not frontend source.** The web app receives listings and reference data through a client (M5). Persisted files move from `src/data/` to `data/` once nothing bundles them.
- **Shared code moves down, not across.** When two layers need the same logic, it moves to the domain (or to `src/node/`/`src/integrations/` for platform code). A layer never imports a sibling's internals.
- **Enforced mechanically.** An architecture test checks every import specifier against this table. The web code is typechecked with a configuration that excludes Node types.

## Public data-layer boundaries (clarified during M3)

- **Scraper input:** `ScrapeIngestion.ingestScrape(ScrapeSubmission)` in `src/data-layer/ingestion/contracts.ts` accepts full-listing observations (`ScrapeBatch`) or explicit partial-detail observations (`DetailPatchBatch`). Require a supported schema version, source, scraper name/version/parser version, run/batch IDs, capture time, scrape mode, scope, and source-scoped observations with capture evidence. Scrapers submit parsed observations, not merged source snapshots or storage revisions. The application layer chooses identity/deduplication, timestamp eligibility, detail preservation, and retirement rules; `ListingRepository` is its internal storage port.
- **Bounded SUUMO discovery:** `SuumoDiscoveryClient.beginSuumoDiscovery()` opens an application-owned session over one source revision. `stagePage()` validates producer/capture metadata and page/query/city sequence, maintains known/seen aliases, and returns novelty/overlap/duplicate counters and a stop reason. `commit()` runs once, after every configured city's bounded window finishes; it never interprets that window as a complete market snapshot. Collectors do not receive source rows or revisions, and failed/incomplete crawls leave the source unchanged while retaining cached pages. Exact source URLs/portal aliases identify observations; legacy generated display IDs alone do not.
- **Exact-row reconciliation:** the internal `ListingRepository.reconcileSource()` port checks unique ID/URL pairs and requires an explicit reason for every omitted prior pair. Rows, prior-ad archives, provenance, and ingestion receipts commit together under the expected revision and shrink guard. Unseen legacy duplicates are retained; only aliases actually absorbed by an eligible discovery are compacted. This is distinct from SOLD/lifecycle reconciliation and preserves the original display IDs of untouched records.
- **Replay and caching:** the scraper owns page/capture caching and must retain original observation times. The data layer independently fingerprints requests and records source/run/batch identity with producer metadata/evidence. Its journal and reconciled rows commit atomically under the source revision check. Same-ID/same-content replay is a no-op, including after newer batches; changed content under an existing ID is rejected. Concurrent revision conflicts are surfaced without automatic retry. Journals are additive and are not silently pruned.
- **Completeness:** discovery and detail enrichment cannot establish absence. New public full-snapshot submissions fail closed until a reviewed scope/exhaustion-evidence policy exists. Legacy Nifty detail observations may explicitly have unknown capture time; they can add missing rows, but cannot overwrite known rows or establish current availability. SUUMO detail patches require known capture times and existing exact source URLs; they cannot add/retire records, change identity/prices/lifecycle, or advance list-observation timestamps/completeness. Their independent per-URL detail timestamps prevent older cached details from rolling back newer details.
- **Detail selection:** `DetailEnrichmentPlanner.planDetailEnrichment()` returns eligible URLs after application-owned cross-source deduplication, completeness checks, and rent/size/layout filters. The collector owns the queue, fetch budget, backoff, and capture cache, but never reads source snapshots or merges stored listings. Internal `ListingRepository` enrichment uses `completeness: "preserve"` plus exact ID/URL locators; it preserves legacy row order, count, IDs, archives, source capture time, and completeness. Managed replay/detail-time provenance survives omission by older compatibility writers.
- **Derived source corrections:** `SourceCorrections.applyCorrection()` in `src/data-layer/corrections/contracts.ts` accepts a supported schema/source/rule version, operation ID, actor, and reason—not replacement rows or arbitrary field patches. The application reads current stored evidence and commits exact ID/URL updates plus a protected `correctionJournal` atomically under the observed source revision. Audit entries retain the input revision, rule metadata, application time, source notes, and field-level before/after values (unset, null, and zero stay distinct). Committed operation IDs replay without reapplying to newer data; changed metadata under the same committed ID conflicts. Missing-source and no-change results deliberately create no receipts/writes/backups; fresh CLI runs remain true no-ops when the rule has nothing to change. The actor is local audit metadata, not an authentication mechanism; any future API must add M7 authorization.
- **Historical source bootstrap:** `SourceBootstrap.bootstrapSources()` in `src/data-layer/bootstrap/contracts.ts` validates a versioned migration, operation ID, actor, reason, dataset identity, and the entire legacy input before accessing target sources. It groups by the original source (missing/null/empty source goes into `unknown` without rewriting the row), skips existing sources unconditionally, and uses the internal create-only `ListingRepository.initializeHistoricalSource(..., { expectedRevision: null })` port. Creation preserves every row, order, missing/colliding ID, unknown field, and lifecycle value; it never deduplicates or normalizes historical rows. Audit metadata/fingerprints commit atomically with each source. Source existence—not operation ID—is the idempotency key; completed source checkpoints survive later failures, while concurrent creators conflict without retry. Portable source-ID and lossless-JSON validation prevent unsafe paths and silent coercions.
- **Bootstrap time compatibility:** the existing string `scrapedAt` slot holds import time only for the tagged initial historical envelope. `bootstrapAudit.importedAt` records its true meaning; `completeSnapshot` is false and observation keys/times are empty. Consumers must not treat this envelope time as capture evidence or a freshness barrier for unobserved historical rows. `sourceObservationTime` helpers, Nifty eligibility, native-capture eligibility, and `data:status` handle that distinction; original row timestamps remain unchanged. `bootstrapAudit` is protected across compatibility provenance replacement and reserved from ordinary scrape submissions.
- **Consumer side (planned, not implemented by this M3 step):** asynchronous listing queries/detail reads and reference snapshots in M5. A separate shared-fact submission use case will accept listing ID, revision, actor, evidence, and timestamped facts/corrections. Property-specific eligibility/restriction information belongs there with unknown/conditional/disputed states and provenance, not in personal preferences and not as an unchecked canonical overwrite. Personal filters, favorites, and notes remain in the M6 user-data boundary; transport/auth/shared-write implementation remains M7 work. Read-model contracts live in the data layer so the web app can import their types without importing services.
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

> **Renumbered 2026-09-29, after M3.** The layers were separated in logic but not in the tree, and nothing enforced them, so each M3 step added more mixed-responsibility files to `scripts/lib`. The layer split and its enforcement moved forward from the old M7 to the new M4, and the frontend data client now comes before the user-state wrapper. Old → new: M4 → M6, M5 → M5, M6 → M7, M7 → M4 (enforced layout) + M8 (optional packages). Commits before this date use the old numbers.

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

### M4 — Enforced layer boundaries (moves and import fixes only; no behavior change)

**Scope:**
1. **Write the architecture test first.** Add a test that resolves every relative import in `src/` and `scripts/` and checks it against the "Target layers and dependency rules" table. Start with an explicit allowlist of current violations; each later step must shrink it, and M4 ends with it empty. Add a web typecheck configuration (`tsconfig.web.json` over `src/web`, `src/domain`, `src/integrations`, and data-layer contracts, without Node types). `npm run typecheck` runs both configurations.
2. **Move files with `git mv`, one layer per commit, updating import paths only.** Tests move with their subjects. The `npm run` command names and `scripts/*.ts` entry points do not change.

   | Current | Target |
   |---|---|
   | `src/App.tsx`, `main.tsx`, `App.module.css`, `components/`, `hooks/`, `styles/`, `lib/export.ts` | `src/web/` (update the `index.html` entry) |
   | `src/types.ts`, `src/config/scoring.ts` | `src/domain/` |
   | `src/lib/geocode.ts` | `src/integrations/geocode.ts` |
   | `scripts/lib/jsonFile.ts`; the `DATA_DIR` path constants from `dataStore.ts` | `src/node/` |
   | `scripts/lib/dataStore.ts`, `jsonListingRepository.ts`, `jsonReferenceDataRepository.ts`, `referenceCatalog.ts`, `observations.ts`, `dataMigrations/`, `listingRepository.contract.ts` | `src/storage/json/` |
   | `scripts/lib/lifecycle.ts` (pure SOLD/lifecycle rules) | `src/data-layer/` |
   | `scripts/lib/` parsers, browsers, and captures (`athome*`, `roomspot*`, `nifty*`, `chromeBridge`, `parseJa`, `parking`, `detailEnrichment`), plus `captureStore`, `captureValidation`, `listCaptureBatch`, `portalCollector`, `niftyIngestion`, `suumoDetailIngestion`, `geocodeCache` | `src/collectors/`, grouped as `shared/`, `suumo/`, `athome/`, `roomspot/`, `nifty/`, `enrichment/` |
   | `scripts/lib/refreshPlan.ts`, `refreshLedger.ts` | `src/refresh/` |
   | `src/data/` | Unchanged in M4; moves in M5 |

3. **Fix the wrong-direction imports.** The allowlist names each of these:
   - Collector → CLI: move the SUUMO `parsePage` out of `scripts/scrape.ts` and `parseStationDistance` out of `scripts/merge-nifty.ts` into collectors. The CLIs may keep re-exports for their own tests.
   - Collector → storage: `captureStore` takes `CAPTURE_DIR` and atomic writes from `src/node/`, not from `dataStore`.
   - Collector → data-layer policies: remove the policy re-exports from `athome.ts`, `nifty.ts`, and `detailEnrichment.ts`, and point their callers at the data layer. Delete the compatibility shims `scripts/lib/sourceObservationBatch.ts` and the unreferenced `suumoIncremental.ts` once their tests import the data layer directly.
   - Collector → service internals: `niftyIngestion` and `suumoDetailIngestion` import `scrapeFingerprint` from `ingestion/service`, and `captureValidation` imports `sourceObservationFallbackTime`. Either publish these as deliberate public helpers next to `contentIdentity`, or move the need out of collectors.
   - Collector → refresh: `portalCollector` imports `DEFAULT_INCREMENTAL_PAGE_CEILING` from `refreshPlan`. Move the default into collectors, which own their page budgets; refresh passes overrides down.
   - Domain → web: `domain/diagnostics.ts` imports the `ScoredRow` type from `lib/export`; move the type into the domain.
4. **Add the `SourcePolicy` registry** as a separate refactor after the moves. The ingestion, discovery, and detail services look up a source's identity/merge/detail policy by source ID instead of importing each policy module. Behavior and journals stay identical; existing source-specific tests pass unchanged.

**Exit checks:** The architecture allowlist is empty, and a planted violation makes the test fail. Web typecheck passes without Node types. `npm test` passes with the same test count plus the new architecture tests; `npm run typecheck`, `npm run build`, `npm run data:status`, and `npm run refresh -- --plan` pass; the dev server renders the same listing count with no console errors. Every persisted file under `src/data/` and `data/` hashes identically. `git log --follow` traces moved files.

**Rollback:** Revert individual move commits; each moves one layer. No data or schema changes are involved.

### M5 — Frontend data client and dynamic reference data

**Scope:**
- Define read-model contracts (listing query, reference snapshot) in the data layer; the web app imports only their types. Replace the direct JSON imports in `src/domain/reference.ts` with an injected client, and move the loading code out of the domain into `src/web/`. Begin with a static client that returns the same data, then add a runtime dataset client with a bundled fallback.
- Model `loadSnapshot()` as asynchronous at the React boundary. Add explicit loading, error/retry, and empty-data states (or a Suspense boundary with an error boundary); do not render components that assume a catalog exists until loading succeeds. Test slow, failed, stale-fallback, and empty responses.
- Pass the loaded snapshot into place catalogs, proximity indexes, maps, filters, and enrichment instead of importing module-level arrays.
- Derive city options, boundary rendering, POI selection, labels, and map extent from the loaded datasets. Handle empty catalogs, multiple boundaries per city, and new POI counts/categories.
- Do not change scoring results for the current data as part of dependency injection. Any scoring model changes need their own explicit migration.
- **Final step, as a pure move:** once nothing in `src/web/` imports persisted files, move `src/data/` to `data/` by changing the single root in `src/node/`. `data:web` output becomes a static asset that the client fetches, not a bundled module. Verify with hash parity before and after the move.

**Exit checks:** Current fixture gives equivalent scores, map, filters, and place options; tests add/remove cities and POIs without code edits; the frontend can run against a fake client; no web or domain module imports persisted data files; the architecture test forbids such imports; the >500 kB bundle warning caused by bundled data is gone; persisted files hash identically after the move.

**Rollback:** Select the bundled compatibility client. The old JSON files remain unchanged until parity has been demonstrated; the directory move reverts independently.

### M6 — Frontend user-state boundary

**Scope:**
- Put `localStorage` behind a `UserDataRepository` browser adapter (in `src/web/`) for configuration, filters, place selection, marks, custom listings, and hidden columns.
- Preserve current storage keys and add explicit versioned migrations for any changed shapes.
- Introduce a fake/in-memory adapter for UI tests.

**Exit checks:** Existing settings survive reloads; corrupt/old state still falls back safely; UI/domain code uses the adapter instead of direct storage access, and the architecture test forbids direct `localStorage` access outside the adapter; app behavior is unchanged.

**Rollback:** Keep the existing keys and old loader available during the transition; fall back to the current browser adapter.

### M7 — Durable API for shared UI writes (only when required)

**Scope:**
- Add an API client/server boundary for manual listings and any user data that must be shared across devices or with ingestion.
- API handlers call the same application use cases/repositories as CLI ingestion. Add validation, authorization, revision checks, and auditable write reasons. The server is another composition root, like the CLIs.
- Keep browser-local preferences browser-local unless there is a product requirement to synchronize them.

**Exit checks:** API integration tests exercise accepted, rejected, repeated, stale-revision, and unauthorized writes. Static/read-only mode remains usable if the API is unavailable.

**Rollback:** Switch the client back to local/static mode. No UI code should depend on a particular database engine.

### M8 — Workspace packages (optional)

**Scope:** Only if independent builds, deployment, or versioning are needed, convert the M4 directories into workspace packages (for example `apps/web`, `packages/domain`, `packages/data-layer`, `packages/storage-json`, `packages/collectors`) and replace the architecture test with package dependency declarations. M4 already enforces the direction, so this milestone is not required for separation.

**Exit checks:** All app, CLI, test, and build commands still work; package dependency direction is enforced by the package manager/build; no frontend package depends on Node code.

**Rollback:** Revert package moves independently; no data conversion is part of this milestone.

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
- **Portal and capture writers migrated:** `scripts/scrape-athome.ts` and `scripts/scrape-roomspot.ts` keep only browser navigation, URL construction, and the capture cache; both run the shared, injectable `scripts/lib/portalCollector.ts` loop over the staged `beginPortalDiscovery` session (`src/data-layer/ingestion/portalDiscovery.ts`), whose rules live in `portalPolicy.ts`. First-run deep bootstrap, two-known-page stopping, empty non-family pages (no log/sleep, not counted as known), page budgets, `--force`, guarded `--full`, browser cleanup, exit codes, and log lines (including the `Discovered N new` line read by refresh) are preserved. `scripts/import-capture.ts` is now `runCaptureImport(args, deps)`: each validated page is parsed by `listCaptureBatch` and submitted with its progress receipt as the batch ID, and the per-run source summary goes through `annotateCaptureRun`. If a source commit succeeds but the progress write fails, the retry replays the journaled original effects, so additions are neither lost nor double counted. Capture spooling, progress schema/receipts, `--file`/`--run-id`/`--max-pages`, the refresh lock, ledger stage completion, and downstream invalidation are unchanged.
- **Intentional behavior differences from the legacy CLIs:** unseen historical duplicates are retained instead of implicitly compacted; RoomSpot merges nested `costs`/`building`/`tenancy` instead of overwriting them; stale observations are filtered in the data layer for direct collectors too, and an observation is rejected if any stored row it could update or supersede is newer; `observedAtByKey` never moves backwards within one commit; an observation with the same source ID keeps the stored URL (AtHome list hrefs carry a changing sibling-room query), so it updates in place rather than being archived and re-appended; a direct crawl drops an earlier native run's `captureRunId`; RoomSpot logs the shared bootstrap line; a replayed collector commit logs the journaled original counts.
- **Tests:** `scripts/scrape-athome.test.ts`, `scripts/scrape-roomspot.test.ts`, and `scripts/import-capture.test.ts` run offline against temporary stores. They cover bootstrap, stopping/budgets/empty pages, replay without rewrite, fetch/parser/identity failures without partial commits, `--full` cleanup, shrink/`--force` archives, revision conflicts without retry, stale prices, detail/parking retention, same-ID URL changes, mixed-source imports, receipt skipping with legacy progress files, page-order enforcement, per-page persistence, commit/progress-write recovery, and ledger invalidation. Temporary-copy parity tests over every current AtHome and RoomSpot row require retirements to equal the legacy batch's, minus only unseen duplicates. Each regression test for a review fix was checked to fail without its fix.
- **M3 complete:** `npm test` (503 tests), `npm run typecheck`, `npm run build`, `npm run data:status`, `npm run refresh -- --plan`, and a dev-server render check (3,452 listings, no console errors) pass. No CLI reads source snapshots to merge them or writes the repository directly; the remaining `listSources` callers are the explicit derived commands `data.ts` (status/canonical build) and `merge-duplicates.ts` (rebuilds `listings_raw.json`). A hash comparison confirms every persisted file under `src/data/` and `data/` in this worktree (26 tracked files) is unchanged. No live collector, production capture import, migration, enrichment, backfill, or canonical `data:build` was run. The frontend remains on its bundled path until M5; consumer/shared-fact interfaces are documented targets, not implemented runtime APIs yet.
- **Known follow-ups (not M3 blockers):**
  - The ingestion journal grows without bound (one evidence entry per observation per commit, now for AtHome/RoomSpot and per native page too); cap or compact older entries.
  - Collector `scrapedAt` is the latest capture time, not the commit time, so `data:status` can miss "changed since the last build" when cached pages are committed after a build (same as SUUMO).
  - A native-import retry after a parser change hits `ScrapeReplayConflictError` for an already-committed page; give an actionable error or include a real parser version in the batch identity.
  - The SUUMO collector's replayed commit still logs zero counts.
  - AtHome's `property:` alias (building name|address|size) can treat two same-size rooms in one building as the same unit; this is pre-existing.
- **Milestones renumbered after M3 (2026-09-29).** See the note at the top of "Milestones"; the layer split and its enforcement are now M4.
- **Restart here:** begin M4, step 1 (architecture test and allowlist of current violations). Then move one layer per commit. Do not change behavior, data files, or schemas in M4.

## Per-milestone validation

At minimum, run `npm test` (including the architecture test from M4 onward), `npm run typecheck`, and `npm run build`. For storage/ingestion milestones also run `npm run data:status`, adapter contract tests, and relevant refresh planning/tests. Inspect `git diff` and generated data paths after builds. A milestone is done only when its exit checks pass and the app remains usable; if not, revert that milestone before proceeding.
