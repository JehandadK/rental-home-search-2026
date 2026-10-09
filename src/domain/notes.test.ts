import { describe, expect, it } from "vitest";
import { describeNote, formatViewing, isBlankNote, isViewingTime, withNote, type NoteMap } from "./notes";

const NOW = new Date("2026-10-03T09:00:00.000Z");

describe("withNote", () => {
  it("adds, updates and stamps a note", () => {
    const added = withNote({}, "k", { text: "Damp bathroom", viewingAt: null }, NOW);
    expect(added).toEqual({ k: { text: "Damp bathroom", viewingAt: null, updatedAt: NOW.toISOString() } });
    const later = new Date("2026-10-04T00:00:00.000Z");
    const updated = withNote(added, "k", { text: "Damp bathroom", viewingAt: "2026-10-05T14:00" }, later);
    expect(updated.k).toEqual({ text: "Damp bathroom", viewingAt: "2026-10-05T14:00", updatedAt: later.toISOString() });
  });

  it("keeps the same map when nothing changed", () => {
    const notes: NoteMap = { k: { text: "x", viewingAt: null, updatedAt: NOW.toISOString() } };
    expect(withNote(notes, "k", { text: "x", viewingAt: null })).toBe(notes);
    expect(withNote({}, "k", { text: "  ", viewingAt: null })).toEqual({});
  });

  it("removes a note that is cleared", () => {
    const notes: NoteMap = {
      k: { text: "x", viewingAt: null, updatedAt: NOW.toISOString() },
      other: { text: "y", viewingAt: null, updatedAt: NOW.toISOString() },
    };
    expect(withNote(notes, "k", { text: " ", viewingAt: null })).toEqual({ other: notes.other });
  });

  it("drops a viewing time it cannot read", () => {
    expect(withNote({}, "k", { text: "call agent", viewingAt: "next tuesday" }, NOW).k.viewingAt).toBeNull();
    expect(withNote({}, "k", { text: "", viewingAt: "garbage" }, NOW)).toEqual({});
  });
});

describe("viewing times", () => {
  it("accepts datetime-local and date-only values", () => {
    expect(isViewingTime("2026-10-05T14:00")).toBe(true);
    expect(isViewingTime("2026-10-05")).toBe(true);
    expect(isViewingTime("2026-13-45")).toBe(false);
    expect(isViewingTime(42)).toBe(false);
  });

  it("formats as weekday, day and month, with the time when given", () => {
    expect(formatViewing("2026-10-05T14:00")).toBe("Mon 5 Oct 14:00");
    expect(formatViewing("2026-10-03")).toBe("Sat 3 Oct");
  });

  it("describes a note in one line", () => {
    expect(describeNote({ text: " Ask about parking ", viewingAt: "2026-10-05T14:00", updatedAt: "" }))
      .toBe("Viewing Mon 5 Oct 14:00 — Ask about parking");
    expect(describeNote({ text: "Just text", viewingAt: null, updatedAt: "" })).toBe("Just text");
  });

  it("treats a viewing alone as a real note", () => {
    expect(isBlankNote({ text: "", viewingAt: "2026-10-05" })).toBe(false);
  });
});
