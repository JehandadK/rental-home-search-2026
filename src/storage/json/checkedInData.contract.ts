/**
 * Test harness: the per-test timeout for checks that read, copy or compare a whole
 * checked-in dataset (`data/sources/*.json`, `data/listings*.json`, the reference catalog).
 *
 * Their runtime grows with every refresh, and the parallel suite slows them several
 * times over. On 2026-10-13 (suumo.json 26 MB, ~5,500 properties; +41% in four days) the
 * SUUMO parity check took 1.0 s alone and up to 6.1 s in `npm test`, past vitest's default
 * 5 s timeout. 60 s gives that about ten times its headroom and still fails a hang within a
 * minute. It is twice the 30 s file-lock and child-process timeouts, so a stuck lock or CLI
 * fails with its own error first.
 */
export const CHECKED_IN_DATA_TIMEOUT_MS = 60_000;
