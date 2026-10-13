/**
 * Nifty's newest-first list crawl for one city, with its page source and
 * ingestion injected so it runs offline in tests. Each page is ingested (and
 * checkpointed) as soon as it is read.
 *
 * Nifty serves 40 rooms per page and answers a page past the last one with
 * HTTP 404 「ページが見つかりません」(checked in the headed browser on
 * 2026-10-12: Koshigaya ≥60㎡ had 266 rooms on 7 pages; page 8 was that 404).
 * Page 1 does not number the last page, so that 404 past page 1 ends the city.
 * A 404 on page 1, or any other failure, still stops the crawl as an error.
 */
import type { PageCapture } from "../shared/captureStore";
import { EndOfResultsError } from "../shared/resultPages";

export interface NiftyPageResult { parsedCount: number; novel: number; added: number }

export interface NiftyCrawlDependencies {
  /** The capture of one list page; throws EndOfResultsError for Nifty's not-found page. */
  page(page: number): Promise<PageCapture>;
  ingest(capture: PageCapture): Promise<NiftyPageResult>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface NiftyCrawlOptions { limit: number; deep: boolean; delayMs?: number }

export async function crawlNiftyCity(options: NiftyCrawlOptions, dependencies: NiftyCrawlDependencies) {
  let knownPages = 0, added = 0, pages = 0;
  let end: "overlap" | "end-of-results" | "page-limit" = "page-limit";
  for (let page = 1; page <= options.limit; page++) {
    let capture: PageCapture;
    try { capture = await dependencies.page(page); }
    catch (error) {
      if (page === 1 || !(error instanceof EndOfResultsError)) throw error;
      dependencies.log(`  page ${page}: no results; end of the city's results`);
      end = "end-of-results";
      break;
    }
    const result = await dependencies.ingest(capture);
    added += result.added; pages++;
    dependencies.log(`  page ${page}: ${result.parsedCount} rooms (${result.novel} new)`);
    knownPages = result.parsedCount > 0 && result.novel === 0 ? knownPages + 1 : 0;
    if (!options.deep && knownPages >= 2) { end = "overlap"; dependencies.log("  stopped: two all-known pages"); break; }
    if (page < options.limit) await dependencies.sleep(options.delayMs ?? 2500);
  }
  return { added, pages, end };
}

/** The message the capture expression throws for Nifty's not-found page (see niftyCapture.ts). */
export const NIFTY_NOT_FOUND = "Nifty not found (HTTP 404)";

/** Map the capture expression's not-found error to the end of results; anything else is a failure. */
export function asEndOfResults(error: unknown, page: number): unknown {
  return error instanceof Error && error.message.includes(NIFTY_NOT_FOUND)
    ? new EndOfResultsError(`Nifty has no results page ${page}`)
    : error;
}
