import type { RawListing } from "../types";

const norm = (value: string | null | undefined): string =>
  (value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

function trackingAddress(value: string): string {
  return norm(value)
    .replace(/[‐‑‒–—―ー−]/g, "-")
    .replace(/(\d+)丁目\d+(?:-\d+)*$/, "$1")
    .replace(/([^\d])\d+(?:-\d+)+$/, "$1")
    .replace(/([^\d])\d{2,}$/, "$1")
    .replace(/(\d+)丁目$/, "$1");
}

/** Historical lifecycle identity; excludes rent so price changes are updates. */
export function trackingKey(listing: RawListing): string {
  return [norm(listing.name), trackingAddress(listing.address), listing.sizeM2 ?? ""].join("|");
}
