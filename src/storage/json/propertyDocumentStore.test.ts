import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newPropertyDocument, propertyIdFor } from "../../domain/propertyDocument";
import { JsonPropertyDocumentStore, readPropertyDocuments } from "./propertyDocumentStore";

describe("JSON property document store", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "properties-")); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes one file per document, rewrites only changed ones, and never deletes", async () => {
    const store = new JsonPropertyDocumentStore(dir);
    const a = propertyIdFor("ad:suumo|a");
    const b = propertyIdFor("ad:suumo|b");
    await store.transact(({ documents }) => {
      documents.set(a, newPropertyDocument(a, "2026-10-01T00:00:00.000Z"));
      documents.set(b, newPropertyDocument(b, "2026-10-01T00:00:00.000Z"));
    });
    const before = (await stat(join(dir, `${b}.json`))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.transact(({ documents }) => {
      documents.get(a)!.aliases.push("ad:suumo|a");
      documents.delete(b);
    });
    expect((await stat(join(dir, `${b}.json`))).mtimeMs).toBe(before);
    const reread = await readPropertyDocuments(dir);
    expect([...reread.keys()].sort()).toEqual([a, b].sort());
    expect(reread.get(a)!.aliases).toEqual(["ad:suumo|a"]);
    expect(JSON.parse(await readFile(join(dir, `${a}.json`), "utf8")).propertyId).toBe(a);
  });

  it("refuses a document whose id does not match its file", async () => {
    const id = propertyIdFor("x");
    await writeFile(join(dir, `${id}.json`), JSON.stringify({ ...newPropertyDocument(propertyIdFor("y"), "2026-10-01T00:00:00.000Z") }));
    await expect(readPropertyDocuments(dir)).rejects.toThrow("Unsupported property document");
  });
});
