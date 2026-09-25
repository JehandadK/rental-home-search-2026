import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  BoundaryGeometry,
  CityBoundaryRecord,
  CityRecord,
  DatasetChangeSet,
  DatasetWriteOptions,
  ReferenceCatalogManifest,
  ReferenceDataRepository,
  ReferenceDataSnapshot,
  ReferencePlaceRecord,
  Retirement,
  VersionedDataset,
} from "../../src/data-layer/contracts";
import { DatasetMigrationRegistry } from "../../src/data-layer/migrations/registry";
import { RevisionConflictError } from "../../src/data-layer/errors";
import { atomicWriteJson } from "./dataStore";
import { withFileLock } from "./jsonFile";

const DATASET_IDS = ["cities", "boundaries", "places"] as const;
type DatasetId = (typeof DATASET_IDS)[number];
type DatasetRecordMap = {
  cities: CityRecord;
  boundaries: CityBoundaryRecord;
  places: ReferencePlaceRecord;
};
type ManagedRecord = {
  id: string;
  status: "active" | "retired";
  updatedAt: string;
  retiredAt?: string;
  retirementReason?: string;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
};

export class ReferenceDataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceDataIntegrityError";
  }
}

/**
 * Versioned JSON catalog adapter. Dataset revisions are immutable files;
 * updates publish a new manifest last, so interrupted writes leave either the
 * previous complete catalog or harmless orphaned version files.
 */
export class JsonReferenceDataRepository implements ReferenceDataRepository {
  private readonly manifestPath: string;
  private readonly transactionLockPath: string;

  constructor(
    private readonly directory: string,
    private readonly migrations = new DatasetMigrationRegistry([]),
  ) {
    this.manifestPath = join(directory, "manifest.json");
    this.transactionLockPath = join(directory, ".catalog-transaction");
  }

  async loadSnapshot(): Promise<ReferenceDataSnapshot> {
    return (await this.readCatalog()).snapshot;
  }

  async updateCities(
    changes: DatasetChangeSet<CityRecord>,
    options: DatasetWriteOptions,
  ): Promise<VersionedDataset<CityRecord>> {
    return this.updateDataset("cities", changes, options);
  }

  async updateBoundaries(
    changes: DatasetChangeSet<CityBoundaryRecord>,
    options: DatasetWriteOptions,
  ): Promise<VersionedDataset<CityBoundaryRecord>> {
    return this.updateDataset("boundaries", changes, options);
  }

  async updatePlaces(
    changes: DatasetChangeSet<ReferencePlaceRecord>,
    options: DatasetWriteOptions,
  ): Promise<VersionedDataset<ReferencePlaceRecord>> {
    return this.updateDataset("places", changes, options);
  }

  private async updateDataset<K extends DatasetId>(
    datasetId: K,
    changes: DatasetChangeSet<DatasetRecordMap[K]>,
    options: DatasetWriteOptions,
  ): Promise<VersionedDataset<DatasetRecordMap[K]>> {
    validateWriteOptions(options);
    return withFileLock(this.transactionLockPath, async () => {
      const { manifest, snapshot } = await this.readCatalog();
      for (const id of DATASET_IDS) {
        if (manifest.datasets[id].schemaVersion !== CURRENT_SCHEMA_VERSION) {
          throw new ReferenceDataIntegrityError(
            `Catalog schema migration is pending for ${id}; persist all dataset migrations before applying updates`,
          );
        }
      }
      const current = snapshot[datasetId] as VersionedDataset<DatasetRecordMap[K]>;
      if (options.expectedRevision !== current.revision) {
        throw new RevisionConflictError(options.expectedRevision, current.revision, `${datasetId} dataset`);
      }

      const records = applyChanges(current.records, changes);
      if (
        current.schemaVersion === CURRENT_SCHEMA_VERSION &&
        JSON.stringify(records) === JSON.stringify(current.records)
      ) return current;

      const updatedAt = new Date().toISOString();
      const revision = digest(JSON.stringify(records));
      const dataset: VersionedDataset<DatasetRecordMap[K]> = {
        datasetId,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        revision,
        updatedAt,
        provenance: {
          ...current.provenance,
          lastChange: {
            changedBy: options.changedBy,
            reason: options.reason,
            updatedAt,
            upsertedIds: changes.upsert.map((record) => record.id),
            retiredIds: (changes.retire ?? []).map((record) => record.id),
          },
        },
        records,
      };
      validateRecords(datasetId, records);
      const filename = `${datasetId}.${revision}.json`;
      await writeImmutableDataset(join(this.directory, filename), dataset);

      const nextManifest: ReferenceCatalogManifest = {
        ...manifest,
        updatedAt,
        datasets: {
          ...manifest.datasets,
          [datasetId]: {
            file: filename,
            schemaVersion: dataset.schemaVersion,
            revision,
            count: records.length,
          },
        },
        counts: countsFor({ ...snapshot, [datasetId]: dataset }),
      };
      nextManifest.revision = snapshotRevision(nextManifest);
      await atomicWriteJson(this.manifestPath, nextManifest);
      return dataset;
    });
  }

  private async readCatalog(): Promise<{ manifest: ReferenceCatalogManifest; snapshot: ReferenceDataSnapshot }> {
    const manifest = await readJson<ReferenceCatalogManifest>(this.manifestPath);
    validateManifest(manifest);
    const [citiesResult, boundariesResult, placesResult] = await Promise.all([
      this.readDataset("cities", manifest),
      this.readDataset("boundaries", manifest),
      this.readDataset("places", manifest),
    ]);
    if (!sameCounts(manifest.counts, countsForRecords(
      citiesResult.rawRecords,
      boundariesResult.rawRecords,
      placesResult.rawRecords,
    ))) {
      throw new ReferenceDataIntegrityError("Reference catalog counts do not match its datasets");
    }
    const snapshot: ReferenceDataSnapshot = {
      revision: manifest.revision,
      cities: citiesResult.dataset as VersionedDataset<CityRecord>,
      boundaries: boundariesResult.dataset as VersionedDataset<CityBoundaryRecord>,
      places: placesResult.dataset as VersionedDataset<ReferencePlaceRecord>,
    };
    validateRelationships(snapshot);
    return { manifest, snapshot };
  }

  private async readDataset<K extends DatasetId>(
    datasetId: K,
    manifest: ReferenceCatalogManifest,
  ): Promise<{ dataset: VersionedDataset<DatasetRecordMap[K]>; rawRecords: readonly unknown[] }> {
    const entry = manifest.datasets[datasetId];
    if (!entry || !entry.file || basename(entry.file) !== entry.file) {
      throw new ReferenceDataIntegrityError(`Invalid ${datasetId} file entry in catalog manifest`);
    }
    const raw = await readJson<VersionedDataset<unknown>>(join(this.directory, entry.file));
    if (
      raw.datasetId !== datasetId ||
      raw.schemaVersion !== entry.schemaVersion ||
      raw.revision !== entry.revision ||
      !Array.isArray(raw.records) ||
      raw.records.length !== entry.count ||
      digest(JSON.stringify(raw.records)) !== raw.revision
    ) {
      throw new ReferenceDataIntegrityError(`${datasetId} dataset does not match the catalog manifest`);
    }

    const migrated = this.migrations.migrate<VersionedDataset<DatasetRecordMap[K]>>(
      datasetId,
      raw.schemaVersion,
      CURRENT_SCHEMA_VERSION,
      raw,
      (value) => validateMigratedDataset(datasetId, value),
    );
    // Revision remains the committed storage token until an explicit write
    // publishes the migrated representation at the current schema version.
    return {
      dataset: { ...migrated, revision: raw.revision },
      rawRecords: raw.records,
    };
  }
}

const CURRENT_SCHEMA_VERSION = 1;

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new ReferenceDataIntegrityError(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeImmutableDataset(path: string, dataset: VersionedDataset<unknown>): Promise<void> {
  if (existsSync(path)) {
    const existing = await readJson<VersionedDataset<unknown>>(path);
    if (existing.revision !== dataset.revision || JSON.stringify(existing.records) !== JSON.stringify(dataset.records)) {
      throw new ReferenceDataIntegrityError(`Immutable dataset file already exists with different contents: ${path}`);
    }
    return;
  }
  await atomicWriteJson(path, dataset);
}

function applyChanges<T extends ManagedRecord>(
  existing: readonly T[],
  changes: DatasetChangeSet<T>,
): T[] {
  const records = new Map(existing.map((record) => [record.id, record]));
  if (records.size !== existing.length) throw new ReferenceDataIntegrityError("Existing dataset contains duplicate IDs");

  const upsertIds = new Set<string>();
  for (const record of changes.upsert) {
    if (!record.id.trim() || upsertIds.has(record.id)) {
      throw new ReferenceDataIntegrityError(`Invalid or duplicate upsert ID: ${record.id}`);
    }
    if (record.status !== "active") {
      throw new ReferenceDataIntegrityError(`Upserts must be active records; retire ${record.id} explicitly`);
    }
    validateTimestamp(record.updatedAt, `${record.id}.updatedAt`);
    upsertIds.add(record.id);
  }

  const retireIds = new Set<string>();
  for (const retirement of changes.retire ?? []) {
    validateRetirement(retirement);
    if (retireIds.has(retirement.id) || upsertIds.has(retirement.id)) {
      throw new ReferenceDataIntegrityError(`Conflicting changes for record ${retirement.id}`);
    }
    retireIds.add(retirement.id);
  }

  for (const record of changes.upsert) {
    const previous = records.get(record.id);
    const merged = {
      ...(previous ?? {}),
      ...record,
      ...(previous?.attributes || record.attributes
        ? { attributes: { ...previous?.attributes, ...record.attributes } }
        : {}),
    } as T;
    if (merged.status === "active") {
      delete (merged as ManagedRecord).retiredAt;
      delete (merged as ManagedRecord).retirementReason;
    }
    records.set(record.id, merged);
  }

  for (const retirement of changes.retire ?? []) {
    const previous = records.get(retirement.id);
    if (!previous) throw new ReferenceDataIntegrityError(`Cannot retire unknown record ${retirement.id}`);
    if (previous.status === "retired") continue;
    records.set(retirement.id, {
      ...previous,
      status: "retired",
      updatedAt: retirement.effectiveAt,
      retiredAt: retirement.effectiveAt,
      retirementReason: retirement.reason,
    } as T);
  }

  return [...records.values()];
}

function validateWriteOptions(options: DatasetWriteOptions): void {
  if (!options.changedBy.trim() || !options.reason.trim()) {
    throw new ReferenceDataIntegrityError("changedBy and reason are required for reference-data updates");
  }
}

function validateRetirement(retirement: Retirement): void {
  if (!retirement.id.trim() || !retirement.reason.trim()) {
    throw new ReferenceDataIntegrityError("A retirement requires an ID and reason");
  }
  validateTimestamp(retirement.effectiveAt, `${retirement.id}.effectiveAt`);
}

function validateMigratedDataset<K extends DatasetId>(datasetId: K, value: unknown): VersionedDataset<DatasetRecordMap[K]> {
  if (!isObject(value) || value.datasetId !== datasetId || value.schemaVersion !== CURRENT_SCHEMA_VERSION || !Array.isArray(value.records)) {
    throw new ReferenceDataIntegrityError(`Migration output for ${datasetId} has an invalid envelope`);
  }
  validateRecords(datasetId, value.records as ManagedRecord[]);
  return value as unknown as VersionedDataset<DatasetRecordMap[K]>;
}

function validateRecords(datasetId: DatasetId, records: readonly unknown[]): void {
  const ids = new Set<string>();
  for (const value of records) {
    if (!isObject(value) || typeof value.id !== "string" || !value.id.trim() || ids.has(value.id)) {
      throw new ReferenceDataIntegrityError(`${datasetId} contains a missing or duplicate record ID`);
    }
    if (value.status !== "active" && value.status !== "retired") {
      throw new ReferenceDataIntegrityError(`${datasetId}/${value.id} has an invalid status`);
    }
    validateTimestamp(value.updatedAt, `${datasetId}/${value.id}.updatedAt`);
    if (value.status === "retired") {
      if (typeof value.retirementReason !== "string" || !value.retirementReason.trim()) {
        throw new ReferenceDataIntegrityError(`${datasetId}/${value.id} needs a retirement reason`);
      }
      validateTimestamp(value.retiredAt, `${datasetId}/${value.id}.retiredAt`);
    }
    ids.add(value.id);

    if (datasetId === "cities") {
      if (typeof value.name !== "string" || !value.name.trim()) {
        throw new ReferenceDataIntegrityError(`City ${value.id} requires a name`);
      }
    } else if (datasetId === "boundaries") {
      if (typeof value.cityId !== "string" || !isBoundaryGeometry(value.geometry)) {
        throw new ReferenceDataIntegrityError(`Boundary ${value.id} has invalid city/geometry data`);
      }
    } else if (datasetId === "places") {
      if (
        typeof value.category !== "string" || !value.category.trim() ||
        typeof value.name !== "string" || !value.name.trim() ||
        typeof value.lat !== "number" || !Number.isFinite(value.lat) || value.lat < -90 || value.lat > 90 ||
        typeof value.lon !== "number" || !Number.isFinite(value.lon) || value.lon < -180 || value.lon > 180
      ) throw new ReferenceDataIntegrityError(`Place ${value.id} has invalid name/category/coordinates`);
    }
  }
}

function isBoundaryGeometry(value: unknown): value is BoundaryGeometry {
  if (!isObject(value)) return false;
  const polygons: unknown[] = value.type === "Polygon"
    ? [value.coordinates]
    : value.type === "MultiPolygon" && Array.isArray(value.coordinates)
      ? value.coordinates
      : [];
  if (!polygons.length) return false;
  return polygons.every((polygon) => {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    return polygon.every((ring) => {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      if (!ring.every((position) => Array.isArray(position) && position.length === 2 &&
        typeof position[0] === "number" && Number.isFinite(position[0]) && position[0] >= -180 && position[0] <= 180 &&
        typeof position[1] === "number" && Number.isFinite(position[1]) && position[1] >= -90 && position[1] <= 90)) return false;
      const first = ring[0] as number[];
      const last = ring[ring.length - 1] as number[];
      return first[0] === last[0] && first[1] === last[1];
    });
  });
}

function validateRelationships(snapshot: ReferenceDataSnapshot): void {
  const cityIds = new Set(snapshot.cities.records.map((city) => city.id));
  for (const boundary of snapshot.boundaries.records) {
    if (!cityIds.has(boundary.cityId)) {
      throw new ReferenceDataIntegrityError(`Boundary ${boundary.id} references unknown city ${boundary.cityId}`);
    }
  }
}

function validateManifest(manifest: ReferenceCatalogManifest): void {
  if (manifest.schemaVersion !== 1 || !manifest.datasets || !manifest.counts) {
    throw new ReferenceDataIntegrityError("Unsupported or malformed reference catalog manifest");
  }
  for (const id of DATASET_IDS) {
    const entry = manifest.datasets[id];
    if (!entry || !entry.file || basename(entry.file) !== entry.file || !Number.isInteger(entry.schemaVersion)) {
      throw new ReferenceDataIntegrityError(`Invalid ${id} dataset manifest entry`);
    }
  }
  if (manifest.revision !== snapshotRevision(manifest)) {
    throw new ReferenceDataIntegrityError("Reference catalog manifest revision is inconsistent");
  }
}

function countsFor(snapshot: ReferenceDataSnapshot): ReferenceCatalogManifest["counts"] {
  return countsForRecords(snapshot.cities.records, snapshot.boundaries.records, snapshot.places.records);
}

function countsForRecords(
  cities: readonly unknown[],
  boundaries: readonly unknown[],
  places: readonly unknown[],
): ReferenceCatalogManifest["counts"] {
  const placesByCategory: Record<string, number> = {};
  for (const place of places) {
    if (!isObject(place) || typeof place.category !== "string") {
      throw new ReferenceDataIntegrityError("Place dataset has invalid category metadata");
    }
    placesByCategory[place.category] = (placesByCategory[place.category] ?? 0) + 1;
  }
  return {
    cities: cities.length,
    boundaries: boundaries.length,
    places: places.length,
    placesByCategory,
  };
}

function sameCounts(
  left: ReferenceCatalogManifest["counts"],
  right: ReferenceCatalogManifest["counts"],
): boolean {
  return left.cities === right.cities &&
    left.boundaries === right.boundaries &&
    left.places === right.places &&
    JSON.stringify(Object.entries(left.placesByCategory ?? {}).sort()) ===
      JSON.stringify(Object.entries(right.placesByCategory).sort());
}

function snapshotRevision(manifest: ReferenceCatalogManifest): string {
  return digest(DATASET_IDS.map((id) => manifest.datasets[id].revision).join("\n"));
}

function validateTimestamp(value: unknown, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ReferenceDataIntegrityError(`${field} must be a valid timestamp`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
