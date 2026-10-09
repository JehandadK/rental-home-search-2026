/** The agency store a detail page names: its runtime shape check and additive merge. */
import type { ListingAgency, RawListing } from "../../domain/types";

const DETAIL_FIELDS = ["brand", "company", "branch", "address", "prefecture", "city", "phone", "licence"] as const;

/** A named store whose other fields are text or null; nothing else may ride along. */
export function isListingAgency(value: unknown): value is ListingAgency {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && record.name.trim() !== "" && Object.entries(record).every(([key, item]) =>
    key === "name" || ((DETAIL_FIELDS as readonly string[]).includes(key) && (item === undefined || item === null || typeof item === "string")));
}

type AgencyFields = Pick<RawListing, "agency" | "agencyInfo">;

/** Read straight off the page: once stored, only ever filled in. */
const PRINTED_FIELDS = ["address", "phone", "licence"] as const;

/**
 * Adds a page's store to a row without overwriting or dropping what the row holds.
 * `agency` and `agencyInfo` always describe one store, so:
 * - a page without the store block changes nothing (it never clears a stored store);
 * - a row naming no store takes the page's name and details together;
 * - a row naming this store gains the printed details it lacks (address, phone,
 *   licence), and never loses one;
 * - a row naming another store keeps its own, and the two are never mixed.
 * The split of the printed name (brand, company, branch) and of the printed
 * address (prefecture, city) is derived, not observed: for the same printed
 * name and address it follows the current parser, so a parser fix re-derives it.
 * Returns null when the row is unchanged.
 */
export function addAgency(listing: RawListing, page: AgencyFields): AgencyFields | null {
  const info = page.agencyInfo;
  if (!info) return null;
  const name = listing.agency ?? listing.agencyInfo?.name ?? null;
  if (name == null) return { agency: info.name, agencyInfo: info };
  const stored = listing.agencyInfo;
  if (name !== info.name || (stored && stored.name !== name)) return null;
  const filled: ListingAgency = { ...info, ...stored };
  for (const field of PRINTED_FIELDS) filled[field] = stored?.[field] ?? info[field] ?? null;
  for (const field of ["brand", "company", "branch"] as const) filled[field] = info[field] ?? null;
  const sameAddress = (stored?.address ?? null) === null || stored?.address === info.address;
  for (const field of ["prefecture", "city"] as const) filled[field] = sameAddress ? info[field] ?? null : stored?.[field] ?? info[field] ?? null;
  const changed = !stored || DETAIL_FIELDS.some((field) => (stored[field] ?? null) !== filled[field]);
  return changed ? { agency: name, agencyInfo: filled } : null;
}
