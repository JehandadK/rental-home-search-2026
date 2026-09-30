export class InvalidScrapeBatchError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidScrapeBatchError"; }
}

export class ScrapeReplayConflictError extends Error {
  constructor(readonly identity?: { source: string; runId: string; batchId: string }) {
    super(identity
      ? `Scrape batch ${identity.batchId} (source ${identity.source}, run ${identity.runId}) was already committed with different content. `
        + "This usually means the parser or capture changed after the first import. The committed batch is unchanged and was not overwritten."
      : "Scrape batch ID was already committed with different content");
    this.name = "ScrapeReplayConflictError";
  }
}
