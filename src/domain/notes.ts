/**
 * The user's own notes on a listing: why it was shortlisted or ruled out,
 * what the agent said, and when a viewing is booked. Marks record *what* was
 * decided; notes keep the reasons, which the portals never will.
 *
 * Like marks, notes are user state keyed by listingKey, so they survive
 * scrapes and data rebuilds.
 */

export interface ListingNote {
  /** Free text, as typed. */
  text: string;
  /**
   * Booked viewing, as a local `YYYY-MM-DDTHH:mm` (what a datetime-local
   * input produces), or a date-only `YYYY-MM-DD`. null when none is booked.
   */
  viewingAt: string | null;
  /** When the note last changed (ISO). */
  updatedAt: string;
}

/** Notes keyed by listingKey. An absent key means no note. */
export type NoteMap = Record<string, ListingNote>;

/** The editable part of a note. */
export type NoteDraft = Pick<ListingNote, "text" | "viewingAt">;

const VIEWING_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

/** True for a viewing time this module can store and display. */
export function isViewingTime(value: unknown): value is string {
  return typeof value === "string" && VIEWING_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

/** A note with nothing in it is the same as no note. */
export function isBlankNote(note: NoteDraft): boolean {
  return note.text.trim() === "" && note.viewingAt == null;
}

/**
 * Notes after saving `draft` for `key`: a blank draft removes the note, an
 * unchanged one leaves the map (and its updatedAt) as it was.
 */
export function withNote(notes: NoteMap, key: string, draft: NoteDraft, now: Date = new Date()): NoteMap {
  const current = notes[key];
  const viewingAt = isViewingTime(draft.viewingAt) ? draft.viewingAt : null;
  if (isBlankNote({ text: draft.text, viewingAt })) {
    if (!current) return notes;
    const { [key]: _removed, ...rest } = notes;
    return rest;
  }
  if (current && current.text === draft.text && current.viewingAt === viewingAt) return notes;
  return { ...notes, [key]: { text: draft.text, viewingAt, updatedAt: now.toISOString() } };
}

const viewingFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** "Sat 5 Oct 14:00", or "Sat 5 Oct" for a date-only viewing. */
export function formatViewing(viewingAt: string): string {
  const [date, time] = viewingAt.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const label = viewingFormat.format(new Date(year, month - 1, day)).replace(",", "");
  return time ? `${label} ${time}` : label;
}

/** One line for a tooltip or a CSV cell. */
export function describeNote(note: ListingNote): string {
  const viewing = note.viewingAt ? `Viewing ${formatViewing(note.viewingAt)}` : "";
  return [viewing, note.text.trim()].filter(Boolean).join(" — ");
}
