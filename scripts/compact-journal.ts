/**
 * Explicit, audited retention step for the ingestion journals.
 * Keeps every batch's identity/fingerprint/effect; drops per-observation evidence from older batches.
 *
 * Run with: npm run data:journal:compact -- [--keep N] [--source suumo]
 */
import { BACKUP_DIR, JsonSourceStore, SOURCES_DIR } from "../src/storage/json/dataStore";
import { JsonListingRepository } from "../src/storage/json/jsonListingRepository";
import { DEFAULT_KEEP_EVIDENCE_BATCHES, compactIngestionJournal } from "../src/data-layer/ingestion/journalCompaction";
import type { ListingRepository } from "../src/data-layer/contracts";

export async function runJournalCompaction(args: readonly string[], repository: ListingRepository, log: (message: string) => void = console.log) {
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const keepArg = option("--keep");
  const keep = keepArg === undefined ? DEFAULT_KEEP_EVIDENCE_BATCHES : Number(keepArg);
  if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a positive integer");
  const only = option("--source");
  const sources = only ? [only] : (await repository.listSources()).map((source) => source.source);
  const results = [];
  for (const source of sources) {
    const result = await compactIngestionJournal(repository, { source, keepEvidenceBatches: keep });
    results.push(result);
    log(result.status === "compacted"
      ? `${source}: dropped evidence from ${result.receipt.batchesCompacted} older batch(es) (${result.receipt.evidenceEntriesDropped} entries); newest ${keep} keep theirs. Backup taken; receipt recorded in provenance.journalCompactions.`
      : `${source}: ${result.status}`);
  }
  return results;
}

if (process.argv[1]?.endsWith("compact-journal.ts")) {
  runJournalCompaction(process.argv.slice(2), new JsonListingRepository(new JsonSourceStore(SOURCES_DIR, BACKUP_DIR)))
    .catch((error) => { console.error(error); process.exit(1); });
}
