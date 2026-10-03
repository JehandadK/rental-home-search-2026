/**
 * Picture URLs scraped from portal result pages, cleaned the same way for
 * every collector: absolute https URLs only, lazy-load spinners and "no image"
 * stand-ins dropped, duplicates removed, and a few per listing at most.
 */
import type { ListingPhoto, ListingPhotoKind } from "../../domain/types";

/** Enough for a thumbnail plus a small gallery; keeps the web payload small. */
export const MAX_PHOTOS = 4;

/** Spinners, transparent pixels and "no image" artwork the portals show in place of a photo. */
const PLACEHOLDER = /loading[^/]*\.gif|lazy-load[^/]*\.gif|transparent\.gif|noimage|no_image|now_?printing|\.svg(?:[?#]|$)/i;

/**
 * athome.jp thumbnails come sized by query (often 100×75, which the web app
 * would mistake for a missing-photo placeholder); ask for a gallery size.
 * Verified in the browser: both hosts honour these queries.
 */
function resize(url: URL): URL {
  if (/(^|\.)athome\.jp$/.test(url.hostname) && url.searchParams.has("width")) {
    url.searchParams.set("width", "480");
    url.searchParams.set("height", "360");
  }
  // athome.co.jp serves its 640×480 original when the size query is left off.
  if (url.hostname === "www.athome.co.jp" && url.pathname.startsWith("/image_files/")) url.search = "";
  return url;
}

/** Infer the kind from the portal's alt text: 外観 = exterior, 間取 = floor plan. */
export function photoKind(alt: string | null | undefined, fallback: ListingPhotoKind = "photo"): ListingPhotoKind {
  if (/間取/.test(alt ?? "")) return "floorPlan";
  if (/外観|建物/.test(alt ?? "")) return "exterior";
  return fallback;
}

/** Clean candidate pictures into a listing's `photos`; undefined when none survive. */
export function collectPhotos(
  candidates: readonly { url: string | null | undefined; kind: ListingPhotoKind }[],
  source: string,
  base: string,
): ListingPhoto[] | undefined {
  const photos = new Map<string, ListingPhoto>();
  for (const { url, kind } of candidates) {
    const raw = url?.trim();
    if (!raw || raw.startsWith("data:") || PLACEHOLDER.test(raw)) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw, base);
    } catch {
      continue;
    }
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    if (parsed.protocol !== "https:") continue;
    const href = resize(parsed).href;
    if (!photos.has(href)) photos.set(href, { url: href, kind, source });
    if (photos.size >= MAX_PHOTOS) break;
  }
  return photos.size ? [...photos.values()] : undefined;
}
