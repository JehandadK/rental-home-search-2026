export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(
    readonly expected: string | null,
    readonly actual: string | null,
    readonly resource: string,
  ) {
    super(
      `Revision conflict for ${resource}: expected ${expected ?? "<missing>"}, found ${actual ?? "<missing>"}. Re-read and reconcile before retrying.`,
    );
    this.name = "RevisionConflictError";
  }
}
