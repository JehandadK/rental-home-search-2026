/**
 * Decoders for each persisted key. For state saved by the app they return
 * exactly what the pre-M6 loaders returned; anything else (another shape,
 * a hand-edited or corrupt value) falls back to the defaults, field by field
 * where that is safe.
 */
import { EMPTY_FILTERS, type ListingFilters } from "../../domain/filters";
import { LISTING_MARKS, type MarkMap } from "../../domain/marks";
import { isViewingTime, type ListingNote, type NoteMap } from "../../domain/notes";
import { MAX_COMPARE } from "../../domain/compare";
import type { PlaceSelection } from "../../domain/placeSelection";
import type { DistanceParameterKey } from "../../domain/places";
import {
  DEFAULT_CONFIG,
  DEFAULT_FEATURE_PREFERENCES,
  DEFAULT_FEATURE_WEIGHTS,
  type ScoringConfig,
} from "../../domain/scoringConfig";
import type { AvailabilityMap } from "../../domain/availability";
import type { EnrichedListing } from "../../domain/types";

type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const objectOrEmpty = (value: unknown): PlainObject => (isPlainObject(value) ? value : {});

export function decodeScoringConfig(raw: unknown): ScoringConfig {
  if (!isPlainObject(raw)) return DEFAULT_CONFIG;
  const parsed = raw as Partial<ScoringConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    weights: { ...DEFAULT_CONFIG.weights, ...objectOrEmpty(parsed.weights) },
    featureWeights: { ...DEFAULT_FEATURE_WEIGHTS, ...objectOrEmpty(parsed.featureWeights) },
    featurePreferences: { ...DEFAULT_FEATURE_PREFERENCES, ...objectOrEmpty(parsed.featurePreferences) },
    walkZeroMinutes: { ...DEFAULT_CONFIG.walkZeroMinutes, ...objectOrEmpty(parsed.walkZeroMinutes) },
    moveIn: { ...DEFAULT_CONFIG.moveIn, ...objectOrEmpty(parsed.moveIn) },
  };
}

export function decodeFilters(raw: unknown): ListingFilters {
  return isPlainObject(raw) ? { ...EMPTY_FILTERS, ...raw } : EMPTY_FILTERS;
}

const MARK_KEYS = new Set<string>(LISTING_MARKS.map((mark) => mark.key));

export function decodeMarks(raw: unknown): MarkMap {
  if (!isPlainObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, mark]) => typeof mark === "string" && MARK_KEYS.has(mark)),
  ) as MarkMap;
}

/** Notes need text or a viewing time; a malformed viewing time is dropped, not the note. */
export function decodeNotes(raw: unknown): NoteMap {
  if (!isPlainObject(raw)) return {};
  const notes: NoteMap = {};
  for (const [key, note] of Object.entries(raw)) {
    if (!isPlainObject(note) || typeof note.text !== "string") continue;
    const viewingAt = isViewingTime(note.viewingAt) ? note.viewingAt : null;
    if (note.text.trim() === "" && viewingAt == null) continue;
    const updatedAt = typeof note.updatedAt === "string" ? note.updatedAt : "";
    notes[key] = { text: note.text, viewingAt, updatedAt } satisfies ListingNote;
  }
  return notes;
}

/** The compare list: distinct listing keys, at most MAX_COMPARE of them. */
export function decodeCompare(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((key): key is string => typeof key === "string"))].slice(0, MAX_COMPARE);
}

/** Hand-made "this ad is gone / still listed" marks; malformed entries are dropped. */
export function decodeAvailabilityMarks(raw: unknown): AvailabilityMap {
  if (!isPlainObject(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, mark]) =>
    isPlainObject(mark)
    && (mark.state === "gone" || mark.state === "listed")
    && typeof mark.source === "string"
    && typeof mark.url === "string"
    && typeof mark.checkedAt === "string" && Number.isFinite(Date.parse(mark.checkedAt))
    && mark.method === "manual"
    && typeof mark.evidence === "string",
  )) as AvailabilityMap;
}

/** Custom listings must at least have a name and a rent to be scored. */
export function decodeCustomListings(raw: unknown): EnrichedListing[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((listing): listing is EnrichedListing =>
    isPlainObject(listing) && typeof listing.name === "string" && typeof listing.rent === "number" && Number.isFinite(listing.rent));
}

/**
 * Saved place selections keep only well-formed entries over the defaults.
 * Ids of places no longer in the catalog (retired since they were saved) are
 * dropped; a choice left with none of its places reverts to the default,
 * while a deliberately empty choice (`[]`, "clear") stays empty.
 *
 * Migration (still v1): v1 once stored Baitul Aman as the single mosque
 * target. Mosque scoring now defaults to the nearest of all mosques, so that
 * legacy default becomes `null`, while curated multi-mosque choices are kept.
 */
export function decodePlaceSelection(
  raw: unknown,
  defaults: PlaceSelection,
  knownIds?: { has(id: string): boolean },
): PlaceSelection {
  if (!isPlainObject(raw) || !isPlainObject(raw.byParameter)) return defaults;
  const merged = { ...defaults.byParameter };
  for (const [key, ids] of Object.entries(raw.byParameter)) {
    if (ids === null) {
      merged[key as DistanceParameterKey] = null;
    } else if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
      const kept = knownIds ? ids.filter((id) => knownIds.has(id)) : ids;
      if (ids.length === 0 || kept.length > 0) merged[key as DistanceParameterKey] = kept;
    }
  }
  const oldBaitulOnly = merged.poi2?.length === 1 && merged.poi2[0].includes("Baitul Aman");
  if (oldBaitulOnly) merged.poi2 = null;
  return { byParameter: merged };
}

export function decodeHiddenColumns<K extends string>(raw: unknown, known: ReadonlySet<K>): Set<K> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((key): key is K => known.has(key as K)));
}
