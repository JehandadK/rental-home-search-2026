/**
 * Backup & sync: export the browser-local user state to a file, and merge
 * someone else's file (a partner's shortlist, another device) into it.
 *
 * Every incoming value goes through the same decoder the app uses when it
 * loads that key, so a corrupt or hand-edited file can never write a value
 * the app would not accept. Nothing is written until `applyImport`.
 *
 * Keys fall into two groups. `lastVisit` is neither: it is per-device and is
 * never exported or imported.
 *
 *  - Decisions (always merged): marks, notes, compare list, ad availability
 *    marks, duplicate answers, custom listings, saved weight presets, watched
 *    UR rooms.
 *  - Preferences (merge mode only with `includePreferences`): weights and
 *    assumptions, filters, places, columns, map areas, name language, UR
 *    filters, inquiry profile. Decisions travel; preferences stay.
 *
 * Merge rules (mode "merge"):
 *  - marks: union; on a differing mark for one listing the incoming file wins.
 *  - notes: union; the later `updatedAt` wins (a tie keeps the existing note).
 *  - compare: union, existing order first, capped at MAX_COMPARE.
 *  - availabilityMarks: union; the later `checkedAt` wins (a tie keeps existing).
 *  - duplicateDecisions: union by pair key; the later `decidedAt` wins, and the
 *    incoming one wins a tie.
 *  - customListings: union by listing key; the existing listing wins.
 *  - weightPresets: union by `id`; the existing preset wins.
 *  - urRoomWatch: union of room ids, existing first.
 *  - preferences: the incoming value replaces the existing one.
 *
 * Replace mode: every key present in the file overwrites the stored one
 * (after decoding); keys the file lacks are left alone.
 *
 * Keys without a decoder that can run without extra context (place selection
 * needs the catalog, hidden columns need the column list, the inquiry profile
 * lives in the draft code) are preferences, copied only when the value is the
 * same basic JSON type the app writes (object or array).
 */
import { MAX_COMPARE } from "../../domain/compare";
import { listingKey } from "../../domain/listingKey";
import {
  decodeAvailabilityMarks,
  decodeCompare,
  decodeCustomListings,
  decodeDuplicateDecisions,
  decodeFilters,
  decodeMapAreas,
  decodeMarks,
  decodeNameLanguage,
  decodeNotes,
  decodeScoringConfig,
  decodeUrRoomsFilters,
  decodeUrRoomWatch,
  decodeWeightPresets,
  isPlainObject,
} from "./decoders";
import { USER_STATE_KEYS, type UserStateStore } from "./store";

export const BACKUP_KIND = "rental-home-search/user-state";
export const BACKUP_VERSION = 1;

export interface UserStateBackup {
  kind: typeof BACKUP_KIND;
  version: 1;
  /** When the file was made (ISO). */
  exportedAt: string;
  /** Raw stored values by storage key (the values of USER_STATE_KEYS). Absent keys are omitted. */
  values: Record<string, unknown>;
}

export type ImportMode = "merge" | "replace";

export interface ImportOptions {
  mode: ImportMode;
  /** Merge mode only: also take the file's preferences. Default false: decisions travel, preferences stay. */
  includePreferences: boolean;
}

/** One line per kind of state: what the import would do. */
export interface ImportChange {
  key: string;
  label: string;
  added: number;
  changed: number;
  unchanged: number;
  /** Entries held here that the import would delete. Only "replace" removes anything. */
  removed: number;
}

export interface ImportPlan {
  changes: ImportChange[];
  /** The values to write, by storage key. */
  writes: Record<string, unknown>;
}

/** How one stored key is decoded, merged and counted. */
interface KeySpec<T> {
  key: string;
  label: string;
  group: "decision" | "preference";
  decode(raw: unknown): T;
  /** Decisions only; preferences take the incoming value. */
  merge?(existing: T, incoming: T): T;
  /** Comparable entries by id: the unit "added / changed / unchanged" counts. */
  entries(value: T): Map<string, string>;
}

const json = (value: unknown) => JSON.stringify(value);

const recordEntries = <V>(record: Record<string, V>) =>
  new Map(Object.entries(record).map(([id, value]) => [id, json(value)]));

const listEntries = (items: readonly string[]) => new Map(items.map((item) => [item, item]));

const wholeEntry = (value: unknown) => new Map([["", json(value)]]);

/** Union of two records; `pick` decides which side's value survives a clash. */
function mergeRecords<V>(existing: Record<string, V>, incoming: Record<string, V>, pick: (a: V, b: V) => V): Record<string, V> {
  const merged = { ...existing };
  for (const [id, value] of Object.entries(incoming)) {
    merged[id] = id in existing ? pick(existing[id], value) : value;
  }
  return merged;
}

const laterWins = <V>(time: (value: V) => string, tie: "existing" | "incoming") => (a: V, b: V) => {
  const [ta, tb] = [Date.parse(time(a)), Date.parse(time(b))];
  const bothKnown = Number.isFinite(ta) && Number.isFinite(tb);
  if (bothKnown && ta !== tb) return tb > ta ? b : a;
  if (!bothKnown && Number.isFinite(tb)) return b;
  return tie === "incoming" ? b : a;
};

type PlainRecord = Record<string, unknown>;

const keyedBy = <V>(items: readonly V[], id: (item: V) => string): Record<string, V> => {
  const out: Record<string, V> = {};
  for (const item of items) out[id(item)] ??= item;
  return out;
};

const SPECS: readonly KeySpec<never>[] = [
  spec({
    key: USER_STATE_KEYS.marks, label: "Decision marks", group: "decision",
    decode: decodeMarks,
    merge: (a, b) => ({ ...a, ...b }),
    entries: recordEntries,
  }),
  spec({
    key: USER_STATE_KEYS.notes, label: "Notes & viewings", group: "decision",
    decode: decodeNotes,
    merge: (a, b) => mergeRecords(a, b, laterWins((note) => note.updatedAt, "existing")),
    entries: recordEntries,
  }),
  spec({
    key: USER_STATE_KEYS.compare, label: "Compare list", group: "decision",
    decode: decodeCompare,
    merge: (a, b) => [...new Set([...a, ...b])].slice(0, MAX_COMPARE),
    entries: listEntries,
  }),
  spec({
    key: USER_STATE_KEYS.availabilityMarks, label: "Ads marked gone/listed", group: "decision",
    decode: decodeAvailabilityMarks,
    merge: (a, b) => mergeRecords(a, b, laterWins((mark) => mark.checkedAt, "existing")),
    entries: recordEntries,
  }),
  spec({
    key: USER_STATE_KEYS.duplicateDecisions, label: "Duplicate answers", group: "decision",
    decode: decodeDuplicateDecisions,
    merge: (a, b) => mergeRecords(a, b, laterWins((decision) => decision.decidedAt, "incoming")),
    entries: recordEntries,
  }),
  spec({
    key: USER_STATE_KEYS.customListings, label: "Custom listings", group: "decision",
    decode: decodeCustomListings,
    merge: (a, b) => Object.values(mergeRecords(keyedBy(a, listingKey), keyedBy(b, listingKey), (mine) => mine)),
    entries: (listings) => recordEntries(keyedBy(listings, listingKey)),
  }),
  spec({
    key: USER_STATE_KEYS.weightPresets, label: "Saved weight presets", group: "decision",
    decode: decodeWeightPresets,
    merge: (a, b) => Object.values(mergeRecords(keyedBy(a, (p) => p.id), keyedBy(b, (p) => p.id), (mine) => mine)),
    entries: (presets) => recordEntries(keyedBy(presets, (p) => p.id)),
  }),
  spec({
    key: USER_STATE_KEYS.urRoomWatch, label: "Watched UR rooms", group: "decision",
    decode: decodeUrRoomWatch,
    merge: (a, b) => [...new Set([...a, ...b])],
    entries: listEntries,
  }),
  spec({ key: USER_STATE_KEYS.scoringConfig, label: "Weights & assumptions", group: "preference", decode: decodeScoringConfig, entries: wholeEntry }),
  spec({ key: USER_STATE_KEYS.filters, label: "Filters", group: "preference", decode: decodeFilters, entries: wholeEntry }),
  spec({ key: USER_STATE_KEYS.placeSelection, label: "Places that count", group: "preference", decode: objectOnly, entries: wholeEntry }),
  spec({ key: USER_STATE_KEYS.hiddenColumns, label: "Hidden columns", group: "preference", decode: stringListOnly, entries: wholeEntry }),
  spec({ key: USER_STATE_KEYS.mapAreas, label: "Map areas", group: "preference", decode: decodeMapAreas, entries: wholeEntry }),
  spec({ key: USER_STATE_KEYS.nameLanguage, label: "Place-name language", group: "preference", decode: decodeNameLanguage, entries: wholeEntry }),
  spec({ key: USER_STATE_KEYS.urRoomsFilters, label: "UR rooms filters", group: "preference", decode: decodeUrRoomsFilters, entries: wholeEntry }),
  spec({ key: USER_STATE_KEYS.inquiryProfile, label: "Inquiry profile", group: "preference", decode: objectOnly, entries: wholeEntry }),
];

/** Keeps the type parameter honest while letting one list hold every key. */
function spec<T>(s: KeySpec<T>): KeySpec<never> {
  return s as unknown as KeySpec<never>;
}

/** No exported decoder fits: only a plain JSON object passes (else undefined, so the key is skipped). */
function objectOnly(raw: unknown): PlainRecord | undefined {
  return isPlainObject(raw) ? raw : undefined;
}

function stringListOnly(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw : undefined;
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(SPECS.map((s) => s.key));

/** Read every known key from the store into a backup. */
export function exportUserState(store: UserStateStore, now: Date = new Date()): UserStateBackup {
  const values: Record<string, unknown> = {};
  for (const { key } of SPECS) {
    const value = store.read(key);
    if (value !== undefined) values[key] = value;
  }
  return { kind: BACKUP_KIND, version: BACKUP_VERSION, exportedAt: now.toISOString(), values };
}

/** Parse text the user picked or pasted. Never throws. */
export function parseBackup(text: string): { ok: true; backup: UserStateBackup } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { ok: false, error: "That does not look like a backup: it is not valid JSON." };
  }
  if (!isPlainObject(parsed) || parsed.kind !== BACKUP_KIND) {
    return { ok: false, error: "That is not a backup from this app." };
  }
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version) || parsed.version < 1) {
    return { ok: false, error: "This backup has no readable version." };
  }
  if (parsed.version > BACKUP_VERSION) {
    return { ok: false, error: "This backup was made by a newer version of the app. Update the app, then try again." };
  }
  if (!isPlainObject(parsed.values)) {
    return { ok: false, error: "This backup has no saved values in it." };
  }
  const values = Object.fromEntries(Object.entries(parsed.values).filter(([key, value]) => KNOWN_KEYS.has(key) && value !== undefined));
  return {
    ok: true,
    backup: {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
      values,
    },
  };
}

/** Work out what an import would write, without writing. */
export function planImport(store: UserStateStore, backup: UserStateBackup, options: ImportOptions): ImportPlan {
  const changes: ImportChange[] = [];
  const writes: Record<string, unknown> = {};
  const replace = options.mode === "replace";

  for (const s of SPECS as readonly KeySpec<unknown>[]) {
    if (s.group === "preference" && !replace && !options.includePreferences) continue;
    if (!(s.key in backup.values)) continue;
    const incoming = s.decode(backup.values[s.key]);
    // A value of the wrong basic type decodes to an empty fallback; written in
    // replace mode that would wipe what is here, so such a key is skipped.
    if (incoming === undefined || !sameShape(backup.values[s.key], incoming)) continue;

    const storedRaw = store.read(s.key);
    const existing = storedRaw === undefined ? undefined : s.decode(storedRaw);
    const result = replace || s.merge == null || existing === undefined ? incoming : s.merge(existing, incoming);

    const before = existing === undefined ? new Map<string, string>() : s.entries(existing);
    const after = s.entries(result);
    const change: ImportChange = { key: s.key, label: s.label, added: 0, changed: 0, unchanged: 0, removed: 0 };
    for (const id of s.entries(incoming).keys()) {
      const was = before.get(id);
      if (was === undefined) {
        // A full compare list takes no more: an entry that did not fit is not "added".
        if (after.has(id)) change.added += 1;
      } else if (was !== after.get(id)) change.changed += 1;
      else change.unchanged += 1;
    }
    for (const id of before.keys()) if (!after.has(id)) change.removed += 1;
    changes.push(change);
    if (change.added + change.changed + change.removed > 0) writes[s.key] = result;
  }
  return { changes, writes };
}

/** True when the raw value has the basic JSON type its decoded form has (list, object, null, or the same primitive). */
function sameShape(raw: unknown, decoded: unknown): boolean {
  if (Array.isArray(decoded)) return Array.isArray(raw);
  if (decoded === null) return raw === null;
  if (typeof decoded === "object") return isPlainObject(raw);
  return typeof raw === typeof decoded;
}

/** Write a plan to the store. */
export function applyImport(store: UserStateStore, plan: ImportPlan): void {
  for (const [key, value] of Object.entries(plan.writes)) store.write(key, value);
}

/** A one-line count of what a backup holds, e.g. "42 marks · 7 notes · 3 compared". */
export function describeBackup(backup: UserStateBackup): string {
  const count = (key: string, decode: (raw: unknown) => object | undefined) => {
    const value = key in backup.values ? decode(backup.values[key]) : undefined;
    return value == null ? 0 : Array.isArray(value) ? value.length : Object.keys(value).length;
  };
  const parts: [number, string, string][] = [
    [count(USER_STATE_KEYS.marks, decodeMarks), "mark", "marks"],
    [count(USER_STATE_KEYS.notes, decodeNotes), "note", "notes"],
    [count(USER_STATE_KEYS.compare, decodeCompare), "compared", "compared"],
    [count(USER_STATE_KEYS.availabilityMarks, decodeAvailabilityMarks), "ad check", "ad checks"],
    [count(USER_STATE_KEYS.duplicateDecisions, decodeDuplicateDecisions), "duplicate answer", "duplicate answers"],
    [count(USER_STATE_KEYS.customListings, decodeCustomListings), "custom listing", "custom listings"],
    [count(USER_STATE_KEYS.weightPresets, decodeWeightPresets), "preset", "presets"],
    [count(USER_STATE_KEYS.urRoomWatch, decodeUrRoomWatch), "watched UR room", "watched UR rooms"],
  ];
  const shown = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return shown.length > 0 ? shown.join(" · ") : "Nothing saved yet";
}
