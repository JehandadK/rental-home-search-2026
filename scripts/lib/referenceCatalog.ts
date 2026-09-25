import { createHash } from "node:crypto";
import type { ReferenceCatalogManifest } from "../../src/data-layer/contracts";

export const CURRENT_CATALOG_REVISION_ALGORITHM = 2 as const;

/** V1 is retained only to upgrade catalogs created before schema-aware roots. */
export function legacyCatalogRevision(manifest: Pick<ReferenceCatalogManifest, "datasets">): string {
  return digest(["cities", "boundaries", "places"].map((id) => manifest.datasets[id].revision).join("\n"));
}

/** Root revision changes on either dataset-content or dataset-schema updates. */
export function catalogRevision(manifest: Pick<ReferenceCatalogManifest, "datasets">): string {
  return digest(["cities", "boundaries", "places"]
    .map((id) => `${id}@v${manifest.datasets[id].schemaVersion}:${manifest.datasets[id].revision}`)
    .join("\n"));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
