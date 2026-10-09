import { describe, expect, it } from "vitest";
import { createBrowserUserStateStore, createMemoryUserStateStore } from "./store";

function fakeStorage(overrides: Partial<Storage> = {}): Storage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    ...overrides,
  };
}

describe("browser user-state store", () => {
  it("stores plain JSON under the given key, as before M6", () => {
    const storage = fakeStorage();
    const store = createBrowserUserStateStore(() => storage);
    store.write("soka-scorer-marks-v1", { a: "shortlisted" });
    expect(storage.values.get("soka-scorer-marks-v1")).toBe('{"a":"shortlisted"}');
    expect(store.read("soka-scorer-marks-v1")).toEqual({ a: "shortlisted" });
  });

  it("reads missing, unparsable, and blocked storage as undefined", () => {
    const storage = fakeStorage();
    storage.values.set("bad", "{not json");
    expect(createBrowserUserStateStore(() => storage).read("missing")).toBeUndefined();
    expect(createBrowserUserStateStore(() => storage).read("bad")).toBeUndefined();
    const blocked = fakeStorage({ getItem: () => { throw new DOMException("blocked", "SecurityError"); } });
    expect(createBrowserUserStateStore(() => blocked).read("any")).toBeUndefined();
    expect(createBrowserUserStateStore(() => undefined).read("any")).toBeUndefined();
  });

  it("does not throw when storage is full or unavailable", () => {
    const full = fakeStorage({ setItem: () => { throw new DOMException("full", "QuotaExceededError"); } });
    expect(() => createBrowserUserStateStore(() => full).write("k", [1])).not.toThrow();
    expect(() => createBrowserUserStateStore(() => undefined).write("k", [1])).not.toThrow();
  });
});

describe("memory user-state store", () => {
  it("round-trips values through JSON like real storage", () => {
    const store = createMemoryUserStateStore({ seeded: { a: 1 } });
    expect(store.read("seeded")).toEqual({ a: 1 });
    const value = { list: [1, 2] };
    store.write("k", value);
    value.list.push(3);
    expect(store.read("k")).toEqual({ list: [1, 2] });
    expect(store.read("missing")).toBeUndefined();
  });
});
