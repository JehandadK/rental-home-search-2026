import { DatasetMigrationRegistry, type DatasetMigration } from "./registry";

/** Current persisted schema version per independently evolving dataset. */
export const CURRENT_REFERENCE_SCHEMA_VERSIONS = {
  cities: 1,
  boundaries: 1,
  places: 1,
} as const;

/**
 * Register pure, one-version-at-a-time transformations here as schemas evolve.
 * Reads apply them in memory; the explicit catalog upgrade command persists
 * the result only after validation and a reversible manifest checkpoint.
 */
export const REFERENCE_DATASET_MIGRATIONS: readonly DatasetMigration[] = [];

export const REFERENCE_MIGRATION_REGISTRY = new DatasetMigrationRegistry(REFERENCE_DATASET_MIGRATIONS);
