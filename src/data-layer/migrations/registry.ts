export interface DatasetMigration {
  datasetId: string;
  fromVersion: number;
  toVersion: number;
  /** Pure transformation; never reads/writes files or external services. */
  up(value: unknown): unknown;
}

export class DatasetMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetMigrationError";
  }
}

/**
 * Applies a contiguous sequence of schema migrations in memory. Persistence is
 * deliberately separate so adapters can validate, back up, then atomically
 * replace the old dataset only through an explicit migration command.
 */
export class DatasetMigrationRegistry {
  private readonly transitions = new Map<string, DatasetMigration>();

  constructor(migrations: readonly DatasetMigration[]) {
    for (const migration of migrations) {
      if (!migration.datasetId.trim()) {
        throw new DatasetMigrationError("Migration datasetId is required");
      }
      if (!Number.isInteger(migration.fromVersion) || migration.fromVersion < 1) {
        throw new DatasetMigrationError(`Invalid fromVersion for ${migration.datasetId}`);
      }
      if (migration.toVersion !== migration.fromVersion + 1) {
        throw new DatasetMigrationError(
          `Migration ${migration.datasetId} must advance exactly one version (${migration.fromVersion} -> ${migration.toVersion})`,
        );
      }
      const key = transitionKey(migration.datasetId, migration.fromVersion);
      if (this.transitions.has(key)) {
        throw new DatasetMigrationError(`Duplicate migration registered for ${key}`);
      }
      this.transitions.set(key, migration);
    }
  }

  migrate<T>(
    datasetId: string,
    fromVersion: number,
    targetVersion: number,
    value: unknown,
    validate: (candidate: unknown) => T,
  ): T {
    if (!Number.isInteger(fromVersion) || fromVersion < 1 || !Number.isInteger(targetVersion) || targetVersion < 1) {
      throw new DatasetMigrationError("Dataset schema versions must be positive integers");
    }
    if (fromVersion > targetVersion) {
      throw new DatasetMigrationError(
        `Cannot downgrade ${datasetId} from schema v${fromVersion} to v${targetVersion}; restore a backup or provide an explicit down migration`,
      );
    }

    let current = value;
    for (let version = fromVersion; version < targetVersion; version++) {
      const migration = this.transitions.get(transitionKey(datasetId, version));
      if (!migration) {
        throw new DatasetMigrationError(`Missing migration for ${datasetId} schema v${version} -> v${version + 1}`);
      }
      try {
        current = migration.up(current);
      } catch (error) {
        throw new DatasetMigrationError(
          `Migration ${datasetId} v${migration.fromVersion} -> v${migration.toVersion} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      return validate(current);
    } catch (error) {
      throw new DatasetMigrationError(
        `Migrated ${datasetId} schema v${targetVersion} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

const transitionKey = (datasetId: string, fromVersion: number) => `${datasetId}@${fromVersion}`;
