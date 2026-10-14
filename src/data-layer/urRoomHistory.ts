/**
 * The UR room history (src/domain/urRooms.ts) from the stored data: the
 * sweeps it records, and the inputs of the published rooms page.
 */
import type { RawListing } from "../domain/types";
import { UR_PLACE_CATEGORY } from "../domain/ur";
import type { UrEstateInput, UrHeldRoom, UrSweepRecord } from "../domain/urRooms";
import type { ScrapeBatch } from "./ingestion/contracts";

interface CatalogLike {
  cities: { records: readonly { id: string; name: string }[] };
  places: { records: readonly { category: string; name: string; status?: string; attributes?: Record<string, unknown> }[] };
}

/** Every active `urDanchi` place, with its target-city label. */
export function urEstateInputs(snapshot: CatalogLike): UrEstateInput[] {
  const cityName = new Map(snapshot.cities.records.map((city) => [city.id, city.name]));
  return snapshot.places.records.flatMap((place) => {
    if (place.category !== UR_PLACE_CATEGORY || place.status === "retired") return [];
    const { urCode, url, cityId } = place.attributes ?? {};
    if (typeof urCode !== "string" || typeof url !== "string") return [];
    return [{ code: urCode, name: place.name, url, city: (typeof cityId === "string" && cityName.get(cityId)) || null }];
  });
}

/** The rooms the `ur` source holds, current and archived, at their last sighting. */
export function heldUrRooms(source: { listings: readonly RawListing[]; archivedListings?: readonly unknown[]; provenance?: Record<string, unknown> } | null): UrHeldRoom[] {
  if (!source) return [];
  const observedAt = (source.provenance?.observedAtByKey ?? {}) as Record<string, string>;
  const archived = (source.archivedListings ?? []).flatMap((entry) => {
    const listing = (entry as { listing?: RawListing }).listing;
    return listing ? [listing] : [];
  });
  return [...source.listings, ...archived].flatMap((listing) => {
    if (!listing.id) return [];
    return [{
      id: listing.id,
      // The collector writes 棟・号室 first in the notes: "1号棟701号室 · 7階 /14階 · …".
      label: listing.notes?.split(" · ")[0]?.trim() || null,
      layout: listing.layout ?? null,
      sizeM2: listing.sizeM2 ?? null,
      floor: listing.building?.floor ?? null,
      rentWithFee: listing.rent,
      commonFee: listing.costs?.adminFeeYen ?? null,
      observedAt: observedAt[listing.id] ?? null,
      url: listing.url ?? null,
    }];
  });
}

const ROOM_URL = /\/(\d{2}_\d{3}[0-9a-z])_room\.html\?JKSS=(\d{9})/;
const roomIdOf = (url: string): string | null => {
  const match = ROOM_URL.exec(url);
  return match ? `ur-${match[1]}-${match[2]}` : null;
};

/** The sweep as the room history keeps it: which family rooms UR advertised, for which cities. */
export function urSweepRecord(batch: ScrapeBatch): UrSweepRecord {
  const minRooms = batch.scope.filters?.minRooms;
  return {
    capturedAt: batch.capturedAt, cities: [...(batch.scope.cities ?? [])], minRooms: typeof minRooms === "number" ? minRooms : 2,
    roomIds: batch.observations.map((observation) => observation.sourceListingId),
  };
}

/** The sweeps the `ur` source's ingestion journal still describes, for the room history. */
export function journalSweeps(source: { provenance?: Record<string, unknown> }): UrSweepRecord[] {
  const journal = source.provenance?.ingestionJournal as { batches?: { metadata?: { capturedAt?: string; scope?: { cities?: string[]; urls?: string[]; filters?: { minRooms?: number } } } }[] } | undefined;
  return (journal?.batches ?? []).flatMap(({ metadata }) => {
    const scope = metadata?.scope;
    if (!metadata?.capturedAt || !scope?.cities?.length || !Array.isArray(scope.urls)) return [];
    return [{
      capturedAt: metadata.capturedAt, cities: [...scope.cities], minRooms: scope.filters?.minRooms ?? 2,
      roomIds: scope.urls.map(roomIdOf).filter((id): id is string => !!id),
    }];
  });
}
