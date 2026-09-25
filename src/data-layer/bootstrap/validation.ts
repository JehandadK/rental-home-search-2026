import type { LegacyListing } from "../contracts";

export class InvalidSourceBootstrapError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidSourceBootstrapError"; }
}

export function invalidBootstrap(message: string): never { throw new InvalidSourceBootstrapError(message); }
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Portable source identifiers: no path traversal, hidden files, or case-folding aliases. */
export function validateSourceId(source: unknown): asserts source is string {
  if (typeof source !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/.test(source) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(source)) invalidBootstrap("Source IDs must be lowercase portable identifiers (1–128 characters, no reserved names)");
}

export function legacySource(listing: LegacyListing): string {
  return listing.source || "unknown";
}

/** Validate structure, not current market eligibility. Never filter or normalize legacy rows. */
export function validateLegacyListing(value: unknown): asserts value is LegacyListing {
  if (!object(value) || typeof value.name !== "string" || typeof value.address !== "string"
    || typeof value.rent !== "number" || !Number.isFinite(value.rent)) invalidBootstrap("Invalid legacy listing fields");
  if (value.source !== undefined && value.source !== null && value.source !== "") validateSourceId(value.source);
  for (const key of ["id", "url", "layout"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") invalidBootstrap(`Invalid legacy ${key}`);
  }
  for (const key of ["sizeM2", "builtYear", "stationWalkMin"] as const) {
    if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) invalidBootstrap(`Invalid legacy ${key}`);
  }
}

/** No silent loss through JSON coercion (NaN, undefined properties, Dates, functions, cycles). */
export function validateJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) invalidBootstrap("Bootstrap input must be lossless JSON data");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalidBootstrap("Bootstrap input must contain plain JSON objects");
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) ? keys.length !== value.length + 1 || Object.keys(value).length !== value.length : keys.length !== Object.keys(value).length) invalidBootstrap("Bootstrap input has non-JSON properties");
  if (keys.some((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key)!; return descriptor.get || descriptor.set; })) invalidBootstrap("Bootstrap input cannot contain accessors");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) validateJsonValue(value[index], ancestors);
  } else {
    for (const item of Object.values(value)) validateJsonValue(item, ancestors);
  }
  ancestors.delete(value);
}
