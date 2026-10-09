/**
 * Listing photos, derived from the portal ads we already store.
 *
 * SUUMO serves every ad's pictures from a path built from the ad's `bc=`
 * property code: `{code}_gw.jpg` is the building exterior (外観) and
 * `{code}_co.jpg` the floor plan (間取り). The code is printed with leading
 * zeros in ad URLs but without them in image paths, and the directory is its
 * last three digits. Verified against every room in the cached search pages.
 *
 * Deriving the URLs keeps SUUMO photos out of the source files and the web
 * payload, and needs no extra portal requests: the browser loads them only
 * when shown. A photo SUUMO does not have comes back as a small placeholder
 * image, which the web app detects and skips.
 *
 * AtHome, Nifty and RoomSpot ad URLs carry no image path. Their collectors
 * store the picture URLs their result pages showed in `listing.photos`.
 */
import { sourceListings } from "./listingDedup";
import type { ListingPhoto, ListingPhotoKind, RawListing } from "./types";

export type { ListingPhoto, ListingPhotoKind } from "./types";

export const PHOTO_KIND_LABELS: Record<ListingPhotoKind, { en: string; ja: string }> = {
  exterior: { en: "Exterior", ja: "外観" },
  photo: { en: "Photo", ja: "写真" },
  floorPlan: { en: "Floor plan", ja: "間取り" },
};

/** Thumbnail preference: the building first, then unlabelled pictures, then floor plans. */
const KIND_ORDER: readonly ListingPhotoKind[] = ["exterior", "photo", "floorPlan"];

const SUUMO_IMAGE_ROOT = "https://img01.suumo.com/front/gazo/fr/bukken";

/** The exterior and floor-plan pictures of one SUUMO ad, or none when its URL has no property code. */
export function suumoPhotos(adUrl: string | null | undefined): ListingPhoto[] {
  const code = /[?&]bc=0*(\d{3,})/.exec(adUrl ?? "")?.[1];
  if (!code) return [];
  const base = `${SUUMO_IMAGE_ROOT}/${code.slice(-3)}/${code}/${code}`;
  return [
    { url: `${base}_gw.jpg`, kind: "exterior", source: "suumo" },
    { url: `${base}_co.jpg`, kind: "floorPlan", source: "suumo" },
  ];
}

/**
 * Every known picture of a listing, best thumbnail first: exteriors, then
 * unlabelled photos, then floor plans. Within a kind, pictures a collector
 * captured come before derived SUUMO ones (they were seen on the page), then
 * by preferred portal ad. Later entries are fallbacks for missing pictures.
 */
export function listingPhotos(listing: RawListing): ListingPhoto[] {
  const derived = sourceListings(listing).flatMap((ad) => (ad.source === "suumo" ? suumoPhotos(ad.url) : []));
  const unique = [...new Map([...(listing.photos ?? []), ...derived].map((photo) => [photo.url, photo])).values()];
  return KIND_ORDER.flatMap((kind) => unique.filter((photo) => photo.kind === kind));
}
