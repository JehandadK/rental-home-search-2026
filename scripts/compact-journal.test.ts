import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSourceStore } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { compactJournal } from "../src/data-layer/ingestion/journalCompaction";
import { runJournalCompaction } from "./compact-journal";
import type { IngestionJournal } from "../src/data-layer/ingestion/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const at = "2026-09-25T00:00:00.000Z";
const journal = (batches: number): IngestionJournal => ({ schemaVersion: 1, batches: Array.from({ length: batches }, (_, index) => ({
  runId: "run", batchId: `batch-${index}`, fingerprint: String(index).padStart(64, "a"), effect: { added: 1, updated: 0, novel: 1, observedCount: 1 },
  metadata: {} as never, evidence: [{ sourceListingId: `id-${index}`, observedAt: at, url: "https://example.test/", captureId: `c${index}` }] })) });

async function setup(batches: number) {
  const root = await mkdtemp(join(tmpdir(), "journal-compact-")); roots.push(root);
  await mkdir(join(root, "sources")); await mkdir(join(root, "backups"));
  const store = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
  await store.writeSource({ source: "suumo", scrapedAt: at, completeSnapshot: false, listings: [], provenance: { ingestionJournal: journal(batches), capturedBy: "fixture" } }, { expectedRevision: null });
  return { store, repository: new JsonListingRepository(store), root };
}

describe("ingestion journal compaction", () => {
  it("drops evidence only from batches older than the newest N", () => {
    const result = compactJournal(journal(5), 2);
    expect(result).toMatchObject({ batchesCompacted: 3, evidenceEntriesDropped: 3 });
    expect(result.journal.batches.map((entry) => entry.evidence.length)).toEqual([0, 0, 0, 1, 1]);
    expect(result.journal.batches.map((entry) => entry.batchId)).toEqual(journal(5).batches.map((entry) => entry.batchId));
  });

  it("keeps replay identity, backs up, records a receipt, and is a no-op the second time", async () => {
    const { store, repository } = await setup(5);
    const before = (await store.readSource("suumo"))!;
    const logs: string[] = [];
    await runJournalCompaction(["--keep", "2"], repository, (line) => logs.push(line));
    const after = (await store.readSource("suumo"))!;
    const kept = after.provenance!.ingestionJournal as IngestionJournal;
    expect(kept.batches.map((entry) => [entry.batchId, entry.fingerprint, entry.evidence.length])).toEqual(
      (before.provenance!.ingestionJournal as IngestionJournal).batches.map((entry, index) => [entry.batchId, entry.fingerprint, index >= 3 ? 1 : 0]));
    expect(after.provenance).toMatchObject({ capturedBy: "fixture", journalCompactions: [{ keepEvidenceBatches: 2, batchesCompacted: 3, evidenceEntriesDropped: 3 }] });
    expect(after.listings).toEqual(before.listings);
    expect((await readdir(store.backupDir)).length).toBeGreaterThan(0);
    const bytesRevision = after.revision;
    await runJournalCompaction(["--keep", "2"], repository, (line) => logs.push(line));
    expect((await store.readSource("suumo"))!.revision).toBe(bytesRevision);
    expect(logs.at(-1)).toBe("suumo: nothing-to-compact");
  });

  it("rejects an invalid --keep before touching any source", async () => {
    const { repository } = await setup(3);
    await expect(runJournalCompaction(["--keep", "0"], repository, () => {})).rejects.toThrow("--keep");
  });
});
