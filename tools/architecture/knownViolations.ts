/**
 * Imports that break the layer rules. The architecture test fails on any
 * violation not listed here and on any entry that no longer occurs, so this
 * list can only shrink. M5 emptied it.
 */
export interface KnownViolation {
  from: string;
  to: string;
  until: string;
  fix: string;
}

export const KNOWN_VIOLATIONS: KnownViolation[] = [];
