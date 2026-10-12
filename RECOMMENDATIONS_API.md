# Recommendations API — plan

## Goal

Let a new system or agent ask "which homes suit **these** criteria, and why?" with no
prior knowledge of this codebase. It discovers the criteria from the API, sends its
own, and gets ranked homes with plain explanations.

Decisions (2026-10-12):

| Question | Decision |
|---|---|
| Transport | One pure core, two thin adapters: an HTTP JSON API (OpenAPI 3.1) and an MCP server |
| Hosting | Local now (`127.0.0.1`); deployable later without a rewrite |
| "Descriptive" | A **self-describing schema** (every criterion, its labels, units, defaults and allowed values) and **explained results** (breakdown, reasons, gaps, relaxation hints). No natural-language parsing: the calling agent turns words into criteria using the schema. |
| User state | **Stateless.** The request carries everything. The server stores nothing per caller. |

Non-goals for v1: writes of any kind (marks, notes, listings), server-side profiles
(that is DATA_ARCHITECTURE's M7), calls to an LLM, and live portal access.

## Why most of the work is a refactor

The ranking pipeline is pure domain code, but it is assembled inside React
(`src/web/App.tsx`, the `resolved → withMarks → available → candidates → scored →
filtered → relaxHints` memo chain):

1. `ProximityIndex` + `applySelection` — distances to the chosen places
2. `withAvailability` — availability overlay
3. `applySameDecisions` — the user's "same home" answers
4. `matchesListing` + `matchesMarkFilter` — filters
5. `scoreListing` — the weighted score
6. `minScore` cut, sort, and `relaxationHints` when nothing matches

If the API built its own copy of this chain, the UI and the API would drift apart.
So step one moves the chain into the domain as named stages. App.tsx keeps its
memoisation by calling the stages one at a time, and the API composes the same
stages. **The same criteria must give the same ranking in the UI and the API**, and
a test enforces it.

## Architecture

```
src/domain/recommend/          pure, no I/O (domain layer)
  pipeline.ts                  the stages above + recommend(snapshot, request)
  criteriaSchema.ts            ONE descriptor for every criterion → validation, /criteria, JSON Schema
  request.ts                   decode + validate a request; resolve preset/defaults → full ScoringConfig etc.
  explain.ts                   per-listing reasons, contributions, gaps, cost summary
  describe.ts                  the self-describing catalogue (criteria, presets, cities, layouts, places)

src/api/                       new "api" layer (Node; may use domain, data-layer, storage, node)
  snapshot.ts                  load published listings + reference, build the ProximityIndex once, hot-swap on change
  service.ts                   transport-agnostic handlers: describe, findPlaces, recommend, explain, compare
  http/server.ts               node:http router, problem+json errors, limits, auth hook
  http/openapi.ts              OpenAPI 3.1 generated from criteriaSchema
  mcp/server.ts                MCP tools over the same service (stdio now, streamable HTTP later)

scripts/serve-api.ts           npm run api   → http://127.0.0.1:8787/v1
scripts/mcp.ts                 npm run mcp   → stdio MCP server
```

`tools/architecture/layers.ts` gets an `api` layer:
`api: ["api", "domain", "data-layer", "storage", "node"]`, with packages limited to the
MCP SDK. Nothing imports `api` except the CLI entry points.

### One schema, three outputs

`criteriaSchema.ts` describes each criterion once: key, group, EN/JA labels, unit,
direction (lower or higher is better), type and range, default weight, anchors
(the values that score 100 and 0), and where its allowed values come from (static
or data-derived: cities, layouts, areas, agencies, place ids). From that one
descriptor we get:

- the request **decoder** (with errors that list valid values and "did you mean")
- the **`GET /v1/criteria`** catalogue, filled with live values from the data snapshot
- the **JSON Schema** used by both OpenAPI and the MCP tool input schemas

Exhaustiveness tests fail when a `ScoreParameterKey`, `ListingFeatureKey` or
`ListingFilters` field is missing from the schema. A criterion added to the UI then
cannot silently go missing from the API.

### Data snapshot

- Reads the **published** files (`public/data/listings.json`, `reference.json`, the
  same deduplicated set the UI loads) through `unpackListings` and
  `buildReferenceModel`. The source is a file path today, or a URL when deployed
  (for example the static host's `data/`).
- Builds the `ProximityIndex` once per snapshot: 5,384 listings × the scored
  categories. It is built at startup, not per request.
- **Non-blocking reloads:** when the files change, it builds the new snapshot in the
  background and keeps serving the old one until it is ready, then swaps.
- Every response carries `dataRevision` (reference revision + listings hash) and
  `generatedAt`.

## The request

All fields are optional. Anything omitted falls back to the preset, then to
`DEFAULT_CONFIG` / `EMPTY_FILTERS` / `defaultSelection()`.

```jsonc
POST /v1/recommendations
{
  "preset": "school-run",                       // from GET /v1/presets
  "weights":  { "station": 12, "rentPerM2": 8 }, // partial ParameterWeights
  "features": { "cityGas": { "weight": 3 }, "fixedTermLease": { "weight": 5, "prefer": "avoid" } },
  "anchors":  { "rentZeroScoreAbove": 150000, "walkZeroMinutes": { "station": 15 } },
  "travel":   { "mode": "bicycle", "includeParking": true, "includeHoikuen": false },
  "places":   { "poi2": ["place:mosque:yashio-masjid"], "station": null },   // ids from GET /v1/places
  "filters":  { "cities": ["草加市"], "layouts": ["3"], "rentMax": 130000, "sizeMin": 55,
                "parking": "required", "status": "active", "newOnly": false },
  "state": {                                     // caller-supplied, never stored
    "excludeKeys": ["…"],                        // already seen or rejected
    "marks": { "<listingKey>": "shortlist" },    // enables filters.markFilter
    "duplicateDecisions": [ … ],                 // same shape as the UI's answers
    "availabilityMarks": { "<adKey>": … }
  },
  "ranking": {
    "sortBy": "score",                           // "score" (weighted total) or any criterion key, e.g. "station", "rentPerM2"
    "order": "desc",
    "minScore": 60,                              // cut on the weighted total
    "minPartScores": { "station": 50, "poi1": 40 } // cut on one criterion's 0–100 score
  },
  "page":   { "limit": 10, "cursor": null },     // limit ≤ 100
  "view":   "summary"                            // "summary" | "full"
}
```

`view: "summary"` is the default and keeps results small, which matters to an agent
paying per token. `"full"` adds every attribute, the cost breakdown, photos and source
references.

### Ranked listing by query string

For simple callers (a browser, `curl`, a spreadsheet), `GET /v1/rankings` takes the
same criteria as dotted query parameters and returns the same response:

```
GET /v1/rankings?preset=commuter&weights.station=14&filters.rentMax=120000
               &ranking.sortBy=score&ranking.minScore=55&page.limit=20
```

Both forms go through one decoder, so they accept exactly the same keys and give
exactly the same errors.

## The response

```jsonc
{
  "apiVersion": "1", "dataRevision": "…", "generatedAt": "2026-10-12T…",
  "scoring": {                                    // what was used for every criterion — see below
    "parameters": [ {
      "key": "station", "label": "Nearest station", "labelJa": "最寄駅", "unit": "min",
      "weight": 14, "share": 0.18,                // weight ÷ total of active weights
      "source": "request",                        // "request" | "preset:commuter" | "default"
      "set": "weights.station",                   // the request path that changes it
      "range": { "min": 0, "max": 20, "step": 1 },
      "direction": "lower-is-better",
      "anchors": { "fullScoreAt": 0, "zeroScoreAt": 20, "set": "anchors.walkZeroMinutes.station" },
      "places": { "selection": "nearest of all", "set": "places.station" }
    }, … ],
    "features": [ { "key": "cityGas", "weight": 3, "prefer": "prefer", "source": "request",
                    "set": "features.cityGas" }, … ],   // every feature, weight 0 included
    "travel": { "mode": "bicycle", "speedMPerMin": 250, "detourFactor": 1.3,
                "includeParking": true, "includeHoikuen": false }
  },
  "filters": { … },                               // the resolved filters, defaults included
  "ranking": { "sortBy": "score", "order": "desc", "minScore": 55, "minPartScores": {} },
  "request": { … },                               // canonical request that reproduces this response exactly
  "counts": { "listings": 5384, "afterFilters": 212, "scored": 209, "returned": 10 },
  "results": [{
    "rank": 1, "key": "…", "score": 87.4,
    "home": { "name": "…", "city": "草加市", "area": "金明町", "layout": "3LDK", "sizeM2": 66.2,
              "builtYear": 2009, "rent": 98000, "monthlyTotal": 104000, "status": "active", "isNew": true,
              "urls": ["https://…"], "photo": "https://…" },
    "reasons": [                                  // strongest contributions first
      "6 min walk to Al Sanad School Japan (weight 15)",
      "¥1,571/㎡ — better value than 78% of matches"
    ],
    "concerns": ["Station is a 17 min walk (scores 15/100)"],
    "breakdown": [ { "key": "poi1", "label": "Nearest private school", "value": 6.1, "unit": "min",
                     "score": 49, "weight": 15, "contribution": 12.2, "detail": "Al Sanad School Japan" } ],
    "gaps": ["moveInCost"]                        // criteria skipped for missing data (weight redistributed)
  }],
  "nextCursor": "…",
  "relaxationHints": [],                          // when results is empty: "relaxing max rent would give 14"
  "warnings": []
}
```

### Returning the scoring so the caller can tweak it

Every ranking response says exactly which scoring produced it, so an agent can adjust
one knob and ask again without guessing:

- **`scoring.parameters`** lists all 11 numeric criteria, weight 0 included. Each one
  gives its weight, its share of the total, **where the value came from** (the
  request, a preset, or the default), the request path that changes it (`set`), the
  allowed range, its anchors (the values scoring 100 and 0, with their own `set`
  path), and which places it measures to.
- **`scoring.features`** does the same for the 31 qualitative features: weight and
  whether Yes or No is preferred.
- **`request`** is the canonical, fully resolved request. Resending it unchanged gives
  the same ranking for the same `dataRevision`. To tweak, the agent edits one path
  (for example `weights.station: 14 → 18`) and resends.
- Each result's **`breakdown`** uses the same keys, so "this home lost on station"
  maps straight to the knob to turn.

The tweak loop: call `describe_criteria`, rank, read `scoring` and each result's
`breakdown`, change `request.<path>`, rank again, and compare the movement.

Errors are RFC 9457 `application/problem+json`, with
`errors: [{ path, message, allowed?, didYouMean? }]`, so an agent can fix its own request.

## HTTP surface (v1)

| Method & path | Purpose |
|---|---|
| `GET /v1` | Entry point: what this API is, links to everything below, data revision |
| `GET /v1/docs` | **Swagger UI**: browse and try every endpoint in the browser |
| `GET /v1/openapi.json` | OpenAPI 3.1, generated (also `openapi.yaml`) |
| `GET /v1/rankings?…` | Ranked homes from query-string criteria (same response as below) |
| `GET /v1/criteria` | The self-describing catalogue: every weight, feature, anchor, filter and travel option, with EN/JA labels, units, defaults and live allowed values |
| `GET /v1/presets` | Built-in presets with descriptions and weights |
| `GET /v1/places?category=&q=&near=lat,lon&limit=` | Look up place ids for `places` (mosques, schools, stations, …) |
| `POST /v1/recommendations` | Ranked, explained results with the scoring used (above) |
| `POST /v1/listings/{key}/explain` | One home in full under the given criteria, even if a filter would hide it |
| `POST /v1/compare` | 2–6 keys side by side, with `sharedGaps` |
| `GET /healthz` | Liveness + snapshot age |

### Swagger / OpenAPI

- `openapi.ts` generates the spec from `criteriaSchema` plus the response types, so
  it cannot drift from what the decoder accepts. Every operation has a summary, a
  description, and **worked examples**: a default ranking, a preset with one tweak,
  a bicycle + parking request, an empty result with relaxation hints, and a
  validation error.
- `/v1/docs` serves Swagger UI with "Try it out" pointed at the local server.
- Swagger UI's assets are served from the `swagger-ui-dist` npm package, not a CDN, so
  the docs work offline and the page makes no outside requests. That's one more
  dependency, allowed only in the `api` layer.
- A test checks the spec is valid OpenAPI 3.1, and that every example in it passes
  the real decoder and matches the real response shape.

### MCP tools (same service)

`describe_criteria`, `list_presets`, `find_places`, `rank_homes`, `explain_home`,
`compare_homes`. `rank_homes` returns the same `scoring` and `request` blocks, so an
agent can tweak and re-rank in a loop. Each tool description says when to use it;
`rank_homes` says to call `describe_criteria` first. A `rental://criteria` resource exposes the catalogue
too. The transport is stdio now (an example `.mcp.json` entry for Claude
Code/Desktop). Later the same tools mount at `/mcp` on the HTTP server as
streamable HTTP.

## Local now, deployable later

- Defaults: bind to `127.0.0.1:8787`, no auth, read-only.
- Config by env: `API_HOST`, `API_PORT`, `API_DATA` (path or URL), `API_TOKENS`,
  `API_CORS_ORIGINS`.
- **Refuses to start on a non-loopback host without `API_TOKENS`** (bearer auth).
- Request body cap (64 kB), `limit` ≤ 100, a per-token rate limit, and a timeout on
  each request.
- Stateless and read-only, so it scales horizontally and caches safely. A deployment
  is just "run `npm run api` with env + the published data".
- Deploying it to a hosting provider, or exposing it to other teams, may need an
  internal **External Service Review** first. Nothing in v1 calls an outside service.

## Phases

Each phase leaves `npm test`, `npm run typecheck` and `npm run build` green and can
be reverted on its own.

1. **Extract the pipeline** into `src/domain/recommend/pipeline.ts`. App.tsx calls
   the stages and keeps its memoisation; there is no behaviour change. Tests: stage
   unit tests, and a parity test on the published listings that `recommend()` gives
   exactly what the old inline App.tsx pipeline gave (presets, tight filters, bicycle,
   place selection, marks, duplicate answers, availability marks, relaxation hints).
   **Done 2026-10-12.**
2. **Schema, request, explain, describe** (pure). Tests: exhaustiveness, decoder
   errors, preset/default resolution, sorting by total or by one criterion, per-criterion
   minimums, the `scoring` block (every criterion present, `source` correct, resending
   `request` reproduces the ranking), explanation wording, and **parity** (UI pipeline
   vs `recommend()` give the same order and scores for fixture criteria).
3. **HTTP API**: snapshot loader with non-blocking reload, router, problem+json,
   `GET /v1/rankings` + `POST /v1/recommendations`, generated OpenAPI with examples,
   Swagger UI at `/v1/docs`, `npm run api`, `api` layer rules. Tests: in-process
   server tests on fixtures (no live data, no network), GET and POST give identical
   results, OpenAPI validity, and every spec example passes the decoder.
4. **MCP server**: tools over `service.ts`, `npm run mcp`, `.mcp.json` example.
   Tests: tool list and schemas, and a `rank_homes` round trip over in-memory
   transport.
5. **Docs and hardening**: README section with curl and MCP examples; auth, CORS,
   limits and rate limiting, the URL data source, and a startup guard for
   non-loopback hosts.

## Risks and open points

- **Listing key stability.** `listingKey` is `id ?? name|address|rent`. All 5,384
  published listings have an `id` today, but it is a merged-row id: a merge or
  re-post can change it, and a caller's `excludeKeys` or `marks` would go stale.
  Consider exposing the property document id (`data/properties/`), which is stable
  across portals and re-posts, as the API's primary key, with `listingKey` as an
  alias.
- **New dependencies** (libraries, not services; allowed only in the `api` layer):
  `@modelcontextprotocol/sdk` for MCP, and `swagger-ui-dist` for the docs page. The
  MCP alternative is a hand-written stdio JSON-RPC (~150 lines). Loading Swagger UI
  from a CDN would avoid the package, but the docs would need the internet and the
  page would make outside requests.
- **Explanation wording** lives in the domain layer and is English-first. JA labels
  are already in the schema; JA reasons can come later via `lang=ja`.
- **Custom listings** (added by hand in the UI) are out of scope for v1; callers rank
  published data only.
- **`CURRENT_YEAR`** in scoring is evaluated at module load. A long-running server
  needs it read per request (or per snapshot) so building ages roll over at New Year.
