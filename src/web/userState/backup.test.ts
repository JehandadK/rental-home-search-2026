import { describe, expect, it } from "vitest";
import {
  applyImport,
  BACKUP_KIND,
  describeBackup,
  exportUserState,
  parseBackup,
  planImport,
  type ImportOptions,
  type UserStateBackup,
} from "./backup";
import { createMemoryUserStateStore, USER_STATE_KEYS as K } from "./store";

const MERGE: ImportOptions = { mode: "merge", includePreferences: false };
const note = (text: string, updatedAt: string, viewingAt: string | null = null) => ({ text, viewingAt, updatedAt });
const backupOf = (values: Record<string, unknown>): UserStateBackup => ({
  kind: BACKUP_KIND, version: 1, exportedAt: "2026-11-18T00:00:00.000Z", values,
});
const avail = (state: "gone" | "listed", checkedAt: string) => ({
  state, checkedAt, source: "suumo", url: "https://x", method: "manual", evidence: "by hand",
});
const decision = (verdict: "same" | "different", decidedAt: string) => ({ verdict, a: ["a"], b: ["b"], decidedAt });
const listing = (id: string, name: string) => ({ id, name, rent: 100_000 });
const preset = (id: string, label: string) => ({ id, label, weights: { rent: 1 } });

function merged(existing: Record<string, unknown>, incoming: Record<string, unknown>, key: string, options = MERGE) {
  const store = createMemoryUserStateStore(existing);
  const plan = planImport(store, backupOf(incoming), options);
  applyImport(store, plan);
  return { value: store.read(key), plan, store };
}

describe("exportUserState", () => {
  it("exports known keys, omits absent ones and never exports lastVisit", () => {
    const store = createMemoryUserStateStore({ [K.marks]: { a: "shortlisted" }, [K.lastVisit]: "2026-01-01" });
    const backup = exportUserState(store, new Date("2026-11-18T01:02:03Z"));
    expect(backup).toEqual({
      kind: BACKUP_KIND, version: 1, exportedAt: "2026-11-18T01:02:03.000Z", values: { [K.marks]: { a: "shortlisted" } },
    });
  });
});

describe("parseBackup", () => {
  it("round-trips an export", () => {
    const store = createMemoryUserStateStore({ [K.compare]: ["a"] });
    const backup = exportUserState(store);
    expect(parseBackup(JSON.stringify(backup))).toEqual({ ok: true, backup });
  });

  it("drops unknown keys, including lastVisit", () => {
    const result = parseBackup(JSON.stringify(backupOf({ [K.marks]: {}, evil: 1, [K.lastVisit]: "x" })));
    expect(result.ok && Object.keys(result.backup.values)).toEqual([K.marks]);
  });

  it.each([
    ["not json", "{nope"],
    ["another kind", JSON.stringify({ kind: "other", version: 1, values: {} })],
    ["an array", "[]"],
    ["no values", JSON.stringify({ kind: BACKUP_KIND, version: 1 })],
    ["a bad version", JSON.stringify({ kind: BACKUP_KIND, version: "1", values: {} })],
  ])("rejects %s without throwing", (_name, text) => {
    const result = parseBackup(text);
    expect(result.ok).toBe(false);
  });

  it("rejects a newer version with a clear message", () => {
    const result = parseBackup(JSON.stringify({ kind: BACKUP_KIND, version: 2, values: {} }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("newer version") });
  });
});

describe("merge: decisions", () => {
  it("marks: union, incoming wins a difference", () => {
    const { value, plan } = merged(
      { [K.marks]: { a: "shortlisted", b: "not-interested" } },
      { [K.marks]: { a: "shortlisted", b: "shortlisted", c: "not-interested" } },
      K.marks,
    );
    expect(value).toEqual({ a: "shortlisted", b: "shortlisted", c: "not-interested" });
    expect(plan.changes).toEqual([expect.objectContaining({ label: "Decision marks", added: 1, changed: 1, unchanged: 1 })]);
  });

  it("marks: invalid marks in the file are never written", () => {
    const { value } = merged({}, { [K.marks]: { a: "bogus", b: "shortlisted" } }, K.marks);
    expect(value).toEqual({ b: "shortlisted" });
  });

  it("notes: the later updatedAt wins, equal is unchanged", () => {
    const { value, plan } = merged(
      { [K.notes]: { a: note("mine", "2026-02-01T00:00:00Z"), b: note("mine", "2026-01-01T00:00:00Z"), c: note("same", "2026-01-01T00:00:00Z") } },
      { [K.notes]: { a: note("theirs", "2026-01-01T00:00:00Z"), b: note("theirs", "2026-02-01T00:00:00Z"), c: note("same", "2026-01-01T00:00:00Z"), d: note("new", "2026-01-01T00:00:00Z") } },
      K.notes,
    );
    const notes = value as Record<string, { text: string }>;
    expect([notes.a.text, notes.b.text, notes.c.text, notes.d.text]).toEqual(["mine", "theirs", "same", "new"]);
    expect(plan.changes[0]).toMatchObject({ added: 1, changed: 1, unchanged: 2 });
  });

  it("compare: union with existing first, capped at four", () => {
    const { value } = merged({ [K.compare]: ["a", "b", "c"] }, { [K.compare]: ["c", "d", "e"] }, K.compare);
    expect(value).toEqual(["a", "b", "c", "d"]);
  });

  it("availability: the later checkedAt wins", () => {
    const { value } = merged(
      { [K.availabilityMarks]: { a: avail("gone", "2026-02-01T00:00:00Z"), b: avail("gone", "2026-01-01T00:00:00Z") } },
      { [K.availabilityMarks]: { a: avail("listed", "2026-01-01T00:00:00Z"), b: avail("listed", "2026-02-01T00:00:00Z") } },
      K.availabilityMarks,
    );
    const marks = value as Record<string, { state: string }>;
    expect([marks.a.state, marks.b.state]).toEqual(["gone", "listed"]);
  });

  it("duplicate answers: the later decidedAt wins, incoming wins a tie", () => {
    const { value } = merged(
      { [K.duplicateDecisions]: { p: decision("same", "2026-02-01T00:00:00Z"), q: decision("same", "2026-01-01T00:00:00Z"), r: decision("same", "2026-01-01T00:00:00Z") } },
      { [K.duplicateDecisions]: { p: decision("different", "2026-01-01T00:00:00Z"), q: decision("different", "2026-02-01T00:00:00Z"), r: decision("different", "2026-01-01T00:00:00Z") } },
      K.duplicateDecisions,
    );
    const decisions = value as Record<string, { verdict: string }>;
    expect([decisions.p.verdict, decisions.q.verdict, decisions.r.verdict]).toEqual(["same", "different", "different"]);
  });

  it("custom listings: union by listing key, existing wins", () => {
    const { value } = merged(
      { [K.customListings]: [listing("x", "Mine")] },
      { [K.customListings]: [listing("x", "Theirs"), listing("y", "New"), { name: "no rent" }] },
      K.customListings,
    );
    expect(value).toEqual([listing("x", "Mine"), listing("y", "New")]);
  });

  it("weight presets: union by id, existing wins", () => {
    const { value } = merged(
      { [K.weightPresets]: [preset("p1", "Mine")] },
      { [K.weightPresets]: [preset("p1", "Theirs"), preset("p2", "Other")] },
      K.weightPresets,
    );
    expect((value as { id: string; label: string }[]).map((p) => [p.id, p.label])).toEqual([["p1", "Mine"], ["p2", "Other"]]);
  });

  it("watched UR rooms: union, existing first", () => {
    const { value } = merged({ [K.urRoomWatch]: ["r1", "r2"] }, { [K.urRoomWatch]: ["r2", "r3"] }, K.urRoomWatch);
    expect(value).toEqual(["r1", "r2", "r3"]);
  });

  it("writes nothing for a key the file would not change", () => {
    const { plan } = merged({ [K.marks]: { a: "shortlisted" } }, { [K.marks]: { a: "shortlisted" } }, K.marks);
    expect(plan.writes).toEqual({});
    expect(plan.changes[0]).toMatchObject({ added: 0, changed: 0, unchanged: 1 });
  });
});

describe("preferences", () => {
  const incoming = { [K.nameLanguage]: "en", [K.mapAreas]: ["soka"], [K.inquiryProfile]: { name: "A" }, [K.hiddenColumns]: ["rent"], [K.placeSelection]: { byParameter: {} } };

  it("stay put in merge mode by default", () => {
    const { plan, store } = merged({ [K.nameLanguage]: "ja" }, incoming, K.nameLanguage);
    expect(plan.changes).toEqual([]);
    expect(store.read(K.nameLanguage)).toBe("ja");
  });

  it("travel with includePreferences", () => {
    const { store, plan } = merged({ [K.nameLanguage]: "ja" }, incoming, K.nameLanguage, { mode: "merge", includePreferences: true });
    expect(store.read(K.nameLanguage)).toBe("en");
    expect(store.read(K.mapAreas)).toEqual(["soka"]);
    expect(plan.changes.find((c) => c.key === K.nameLanguage)).toMatchObject({ label: "Place-name language", changed: 1 });
  });

  it("skip values of the wrong basic type", () => {
    const { store } = merged({}, { [K.inquiryProfile]: "text", [K.hiddenColumns]: { a: 1 }, [K.placeSelection]: [] }, K.inquiryProfile, { mode: "replace", includePreferences: false });
    expect(store.read(K.inquiryProfile)).toBeUndefined();
    expect(store.read(K.hiddenColumns)).toBeUndefined();
    expect(store.read(K.placeSelection)).toBeUndefined();
  });
});

describe("replace mode", () => {
  it("overwrites keys present in the file, including preferences, and leaves absent keys alone", () => {
    const { store } = merged(
      { [K.marks]: { a: "shortlisted" }, [K.notes]: { n: note("keep", "2026-01-01T00:00:00Z") }, [K.nameLanguage]: "ja" },
      { [K.marks]: { b: "not-interested" }, [K.nameLanguage]: "en" },
      K.marks,
      { mode: "replace", includePreferences: false },
    );
    expect(store.read(K.marks)).toEqual({ b: "not-interested" });
    expect(store.read(K.nameLanguage)).toBe("en");
    expect(store.read(K.notes)).toEqual({ n: note("keep", "2026-01-01T00:00:00Z") });
  });

  it("still sanitises through the decoders", () => {
    const { store } = merged({}, { [K.compare]: ["a", "a", 3, "b", "c", "d", "e"] }, K.compare, { mode: "replace", includePreferences: false });
    expect(store.read(K.compare)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("planImport", () => {
  it("does not write", () => {
    const store = createMemoryUserStateStore();
    planImport(store, backupOf({ [K.marks]: { a: "shortlisted" } }), MERGE);
    expect(store.values.size).toBe(0);
  });
});

describe("describeBackup", () => {
  it("counts what is inside", () => {
    expect(describeBackup(backupOf({ [K.marks]: { a: "shortlisted", b: "not-interested" }, [K.compare]: ["a"] }))).toBe("2 marks · 1 compared");
    expect(describeBackup(backupOf({}))).toBe("Nothing saved yet");
  });
});

describe("planImport, what an import takes away", () => {
  const REPLACE: ImportOptions = { mode: "replace", includePreferences: false };

  it("counts the entries a replace would delete, and a merge deletes none", () => {
    const mine = { [K.notes]: { a: note("mine a", "2026-11-01T00:00:00.000Z"), b: note("mine b", "2026-11-01T00:00:00.000Z"), c: note("mine c", "2026-11-01T00:00:00.000Z") } };
    const theirs = { [K.notes]: { a: note("mine a", "2026-11-01T00:00:00.000Z") } };

    const replaced = merged(mine, theirs, K.notes, REPLACE);
    expect(replaced.plan.changes[0]).toMatchObject({ added: 0, changed: 0, unchanged: 1, removed: 2 });
    expect(Object.keys(replaced.value as object)).toEqual(["a"]);

    const kept = merged(mine, theirs, K.notes);
    expect(kept.plan.changes[0]).toMatchObject({ removed: 0 });
    expect(Object.keys(kept.value as object)).toEqual(["a", "b", "c"]);
  });

  it("skips a value of the wrong type instead of replacing what is here with nothing", () => {
    const mine = { [K.marks]: { a: "shortlisted" }, [K.compare]: ["a"] };
    const { store, plan } = merged(mine, { [K.marks]: "oops", [K.compare]: { a: true } }, K.marks, REPLACE);
    expect(plan.changes).toEqual([]);
    expect(plan.writes).toEqual({});
    expect(store.read(K.marks)).toEqual({ a: "shortlisted" });
    expect(store.read(K.compare)).toEqual(["a"]);
  });

  it("does not count a compared home that a full compare list had no room for", () => {
    const full = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const mineFull = merged({ [K.compare]: full }, { [K.compare]: ["x", "y"] }, K.compare);
    const held = mineFull.value as string[];
    const fitted = ["x", "y"].filter((id) => held.includes(id)).length;
    expect(mineFull.plan.changes[0]?.added ?? 0).toBe(fitted);
    // Whatever the cap is, nothing already compared is pushed out.
    expect(held.slice(0, Math.min(full.length, held.length))).toEqual(full.slice(0, held.length));
  });
});
