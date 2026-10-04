/**
 * Browser-local user state (M6): preferences, filters, place selection,
 * decision marks, notes, the compare list, saved weight presets, custom
 * listings, and hidden columns.
 *
 * `UserStateStore` is the only way the app reads or writes that state. The
 * browser adapter below is the only code that touches `localStorage` (the
 * architecture test enforces it); tests use the in-memory adapter.
 *
 * Values are stored exactly as before M6 — plain JSON under the same keys —
 * so earlier builds can still read them. A key's version is part of its
 * name (`…-v1`); a future shape change adds a new key and migrates from the
 * old one, rather than rewriting an existing key in place.
 *
 * The store is synchronous and browser-local on purpose. Shared,
 * revision-checked user data (the data layer's `UserDataRepository`) is M7
 * work and would sit behind an API; these preferences stay in the browser.
 */

export interface UserStateStore {
  /** The stored JSON value, or undefined when absent, unreadable, or unparsable. */
  read(key: string): unknown;
  /** Store a JSON value. Failures (quota, disabled storage) are not fatal. */
  write(key: string, value: unknown): void;
}

/** Every key the app persists. Keys from before M6 are unchanged. */
export const USER_STATE_KEYS = {
  scoringConfig: "soka-scorer-config-v1",
  filters: "soka-scorer-filters-v1",
  placeSelection: "soka-scorer-places-v1",
  marks: "soka-scorer-marks-v1",
  availabilityMarks: "soka-scorer-availability-v1",
  customListings: "soka-scorer-custom-listings-v1",
  hiddenColumns: "rental-search-hidden-columns-v1",
  notes: "soka-scorer-notes-v1",
  compare: "soka-scorer-compare-v1",
  weightPresets: "soka-scorer-weight-presets-v1",
  mapAreas: "rental-search-map-areas-v1",
  nameLanguage: "rental-search-name-language-v1",
} as const;

/** localStorage adapter. Missing or blocked storage behaves like an empty store. */
export function createBrowserUserStateStore(storage: () => Storage | undefined = defaultStorage): UserStateStore {
  return {
    read(key) {
      try {
        const saved = storage()?.getItem(key);
        return saved == null ? undefined : (JSON.parse(saved) as unknown);
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      try {
        storage()?.setItem(key, JSON.stringify(value));
      } catch {
        // The app keeps working; the value just won't survive a reload.
      }
    },
  };
}

function defaultStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** In-memory adapter for tests: values round-trip through JSON like real storage. */
export function createMemoryUserStateStore(initial: Record<string, unknown> = {}): UserStateStore & {
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    values,
    read: (key) => {
      const saved = values.get(key);
      return saved === undefined ? undefined : (JSON.parse(saved) as unknown);
    },
    write: (key, value) => {
      values.set(key, JSON.stringify(value));
    },
  };
}
