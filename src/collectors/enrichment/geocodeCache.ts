import type { EnrichedListing } from "../../domain/types";
import type { GeocodeOutcome } from "../../integrations/geocode";

export const addressKey = (address: string): string => address.normalize("NFKC").replace(/\s+/g, "");
export interface CachedGeocode { value: GeocodeOutcome | null; checkedAt: string }
export type GeocodeCache = Record<string, CachedGeocode>;
export function seedGeocodes(previous: readonly EnrichedListing[], cache: GeocodeCache): GeocodeCache {
  for (const l of previous) {
    if (l.geocoded && Number.isFinite(l.lat) && Number.isFinite(l.lon)) {
      cache[addressKey(l.address)] ??= { value: { lat: l.lat!, lon: l.lon!, matched: l.geocodeMatched ?? l.address }, checkedAt: l.lastSeenAt ?? "1970-01-01T00:00:00.000Z" };
    }
  }
  return cache;
}
export function cachedGeocode(cache: GeocodeCache, address: string, now = Date.now()): CachedGeocode | undefined {
  const entry = cache[addressKey(address)];
  // Valid addresses are stable; negative results expire so future matches can improve.
  return entry && (entry.value || now - Date.parse(entry.checkedAt) < 7 * 86400000) ? entry : undefined;
}
