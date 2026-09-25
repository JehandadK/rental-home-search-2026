/**
 * Client-side geocoding via Japan's GSI address search — free, no API key.
 * https://github.com/gsi-cyberjapan/msearch
 */
import type { GeoPoint } from "../types";

interface GsiResult {
  geometry: { coordinates: [number, number] };
  properties: { title: string };
}

export interface GeocodeOutcome extends GeoPoint {
  /** The address the geocoder actually matched, for spot-checking. */
  matched: string;
}

/**
 * Resolve a Japanese address to coordinates.
 * Falls back to a coarser area-level match when the exact street number
 * is unknown to the geocoder. Returns null when nothing matches.
 */
export async function geocodeAddress(address: string): Promise<GeocodeOutcome | null> {
  const candidates = [...new Set([address, stripStreetNumber(address)])];
  for (const query of candidates) {
    const result = await queryGsi(query);
    if (result) return result;
  }
  return null;
}

/** Remove the trailing 番/号 block numbers to get an area-level query. */
function stripStreetNumber(address: string): string {
  return address.replace(/[0-9０-９-―−]+(番地?|号|丁目).*$/, "");
}

async function queryGsi(query: string): Promise<GeocodeOutcome | null> {
  const url =
    "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(query);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GSI HTTP ${response.status}`);
  const results = (await response.json()) as GsiResult[];
  const first = results[0];
  if (!first) return null;
  const [lon, lat] = first.geometry.coordinates;
  return { lat, lon, matched: first.properties.title };
}
