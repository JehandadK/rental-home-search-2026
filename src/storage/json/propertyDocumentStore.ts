/**
 * data/properties/<propertyId>.json: one document per property.
 *
 * The whole directory is one dataset: a transaction holds `data/properties.lock`,
 * reads every document, and rewrites only the documents whose content changed
 * (each atomically). Files are never deleted; a merged document stays on disk
 * with `mergedInto` set.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PropertyDocumentStore, PropertyStoreState } from "../../data-layer/properties/contracts";
import { PROPERTY_DOCUMENT_SCHEMA_VERSION, type PropertyDocument } from "../../domain/propertyDocument";
import { withFileLock, writeJsonAtomicallyUnlocked } from "../../node/jsonFile";
import { DATA_DIR } from "./dataStore";

export const PROPERTIES_DIR = join(DATA_DIR, "properties");

const serialize = (doc: PropertyDocument) => `${JSON.stringify(doc, null, 2)}\n`;

export async function readPropertyDocuments(dir = PROPERTIES_DIR): Promise<Map<string, PropertyDocument>> {
  const documents = new Map<string, PropertyDocument>();
  if (!existsSync(dir)) return documents;
  for (const name of (await readdir(dir)).filter((file) => /^p_[0-9a-f]+\.json$/.test(file)).sort()) {
    const doc = JSON.parse(await readFile(join(dir, name), "utf8")) as PropertyDocument;
    if (doc.schemaVersion !== PROPERTY_DOCUMENT_SCHEMA_VERSION || `${doc.propertyId}.json` !== name) {
      throw new Error(`Unsupported property document: ${join(dir, name)}`);
    }
    documents.set(doc.propertyId, doc);
  }
  return documents;
}

export class JsonPropertyDocumentStore implements PropertyDocumentStore {
  constructor(private readonly dir = PROPERTIES_DIR) {}

  async transact<T>(update: (state: PropertyStoreState) => T | Promise<T>): Promise<T> {
    return withFileLock(this.dir, async () => {
      const documents = await readPropertyDocuments(this.dir);
      const original = new Map([...documents].map(([id, doc]) => [id, serialize(doc)]));
      const result = await update({ documents });
      await mkdir(this.dir, { recursive: true });
      // Merged-away documents last: if a write fails midway, the survivor
      // already holds their content and the absorbed copy is still live.
      const ordered = [...documents].sort(([, a], [, b]) => Number(Boolean(a.mergedInto)) - Number(Boolean(b.mergedInto)));
      for (const [id, doc] of ordered) {
        if (doc.propertyId !== id || !/^p_[0-9a-f]+$/.test(id)) throw new Error(`Invalid property id: ${id}`);
        if (original.get(id) !== serialize(doc)) await writeJsonAtomicallyUnlocked(join(this.dir, `${id}.json`), doc);
      }
      return result;
    });
  }
}
