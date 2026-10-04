/**
 * Runtime distance index.
 *
 * Instead of baking one "nearest place" per parameter into the listing data
 * at enrichment time, we compute the full listing × place distance matrix
 * once in the browser and reduce it on demand. That way the dashboard can
 * change which places count — a single station, only 幼稚園, a hand-picked
 * shortlist of schools — and the scores update instantly, with no re-run of
 * the scrape/enrich pipeline.
 *
 * Cost for the current dataset (536 listings × 1,182 places ≈ 634k pairs):
 * ~10 ms to build, ~0.7 ms to re-reduce after a selection change.
 *
 * The index measures whatever catalog it is given, so adding places or
 * categories to the reference data needs no code change here. Pass
 * `categories` to measure only some of them: the app skips map-only
 * categories such as the ~2,000 Kanto rail stations, which would cost
 * seconds and tens of MB at this size.
 */
import type { EnrichedListing, Proximity } from "./types";
import { haversineM } from "./geo";
import type { CatalogPlace, PlaceCatalog, PlaceCategory } from "./places";

/** Distances (metres) from every listing to every place in one category. */
interface CategoryBlock {
  places: readonly CatalogPlace[];
  /** Row-major listings × places, Float32 to keep it compact. */
  distances: Float32Array;
}

export class ProximityIndex {
  private readonly blocks = new Map<PlaceCategory, CategoryBlock>();
  /** placeId → where to find its column, so lookups stay O(1). */
  private readonly locate = new Map<string, { category: PlaceCategory; column: number }>();

  constructor(
    private readonly listings: readonly EnrichedListing[],
    catalog: PlaceCatalog,
    categories: readonly PlaceCategory[] = catalog.categories,
  ) {
    for (const category of catalog.categories) {
      if (!categories.includes(category)) continue;
      const places = catalog.inCategory(category);
      const distances = new Float32Array(listings.length * places.length);
      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        if (listing.lat == null || listing.lon == null) {
          distances.fill(Number.NaN, i * places.length, (i + 1) * places.length);
          continue;
        }
        const from = { lat: listing.lat, lon: listing.lon };
        for (let j = 0; j < places.length; j++) {
          distances[i * places.length + j] = haversineM(from, places[j]);
        }
      }
      this.blocks.set(category, { places, distances });
      places.forEach((place, column) => this.locate.set(place.id, { category, column }));
    }
  }

  /** Straight-line distance from a listing to one specific place. */
  distanceTo(listingIndex: number, placeId: string): number | null {
    const at = this.locate.get(placeId);
    if (!at) return null;
    const block = this.blocks.get(at.category);
    if (!block) return null;
    const d = block.distances[listingIndex * block.places.length + at.column];
    return Number.isNaN(d) ? null : d;
  }

  /**
   * Nearest of the given places (by id) to a listing. Passing `null` for
   * `allowedIds` means "any place in the category".
   */
  nearestIn(
    listingIndex: number,
    category: PlaceCategory,
    allowedIds: ReadonlySet<string> | null,
  ): Proximity | null {
    const block = this.blocks.get(category);
    if (!block) return null;
    const { places, distances } = block;
    const offset = listingIndex * places.length;

    let bestDist = Infinity;
    let bestPlace: CatalogPlace | null = null;
    for (let j = 0; j < places.length; j++) {
      if (allowedIds && !allowedIds.has(places[j].id)) continue;
      const d = distances[offset + j];
      if (Number.isNaN(d) || d >= bestDist) continue;
      bestDist = d;
      bestPlace = places[j];
    }
    if (!bestPlace) return null;
    // walkMin is filled in by the scorer, which owns the speed/detour knobs.
    return { name: bestPlace.name, distM: Math.round(bestDist), walkMin: 0 };
  }

  /** Proximity to one specific place, shaped like the nearest-* results. */
  proximityToPlace(listingIndex: number, placeId: string): Proximity | null {
    const at = this.locate.get(placeId);
    if (!at) return null;
    const block = this.blocks.get(at.category);
    const place = block?.places[at.column];
    const d = this.distanceTo(listingIndex, placeId);
    if (!place || d == null) return null;
    return { name: place.name, distM: Math.round(d), walkMin: 0 };
  }

  get size(): number {
    return this.listings.length;
  }
}
