import { describe, expect, it } from "vitest";
import { DatasetMigrationError, DatasetMigrationRegistry, type DatasetMigration } from "./registry";

describe("DatasetMigrationRegistry", () => {
  it("applies contiguous migrations in order and validates the result", () => {
    const registry = new DatasetMigrationRegistry([
      {
        datasetId: "places",
        fromVersion: 1,
        toVersion: 2,
        up: (value) => ({ ...(value as object), nameLocal: "" }),
      },
      {
        datasetId: "places",
        fromVersion: 2,
        toVersion: 3,
        up: (value) => ({ ...(value as object), status: "active" }),
      },
    ]);
    const original = { id: "poi:school", name: "School" };

    const migrated = registry.migrate("places", 1, 3, original, (value) => {
      const row = value as { id: string; nameLocal: string; status: string };
      if (!row.id || row.status !== "active") throw new Error("invalid migrated row");
      return row;
    });

    expect(migrated).toEqual({ ...original, nameLocal: "", status: "active" });
    expect(original).toEqual({ id: "poi:school", name: "School" });
  });

  it("passes current-version values through validation without a migration", () => {
    const registry = new DatasetMigrationRegistry([]);
    expect(registry.migrate("cities", 2, 2, { id: "soka" }, (value) => value)).toEqual({ id: "soka" });
  });

  it("fails closed on missing migrations and unsupported downgrades", () => {
    const registry = new DatasetMigrationRegistry([]);
    expect(() => registry.migrate("boundaries", 1, 2, {}, (value) => value)).toThrow(
      "Missing migration for boundaries schema v1 -> v2",
    );
    expect(() => registry.migrate("boundaries", 2, 1, {}, (value) => value)).toThrow(
      "Cannot downgrade boundaries from schema v2 to v1",
    );
  });

  it("rejects duplicate or non-contiguous migration registrations", () => {
    const migration: DatasetMigration = {
      datasetId: "cities",
      fromVersion: 1,
      toVersion: 2,
      up: (value) => value,
    };
    expect(() => new DatasetMigrationRegistry([migration, migration])).toThrow(DatasetMigrationError);
    expect(() => new DatasetMigrationRegistry([{ ...migration, toVersion: 3 }])).toThrow(
      "must advance exactly one version",
    );
  });

  it("wraps migration and final validation failures with dataset/version context", () => {
    const registry = new DatasetMigrationRegistry([{
      datasetId: "cities",
      fromVersion: 1,
      toVersion: 2,
      up: () => { throw new Error("bad row"); },
    }]);
    expect(() => registry.migrate("cities", 1, 2, {}, (value) => value)).toThrow(
      "Migration cities v1 -> v2 failed: bad row",
    );
    const validMigration = new DatasetMigrationRegistry([{
      datasetId: "cities",
      fromVersion: 1,
      toVersion: 2,
      up: (value) => value,
    }]);
    expect(() => validMigration.migrate("cities", 1, 2, {}, () => { throw new Error("bad shape"); })).toThrow(
      "Migrated cities schema v2 failed validation: bad shape",
    );
  });
});
