export class InvalidScrapeBatchError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidScrapeBatchError"; }
}

export class ScrapeReplayConflictError extends Error {
  constructor() { super("Scrape batch ID was already committed with different content"); this.name = "ScrapeReplayConflictError"; }
}
