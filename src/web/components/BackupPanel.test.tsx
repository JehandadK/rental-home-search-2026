// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_KIND } from "../userState/backup";
import { createMemoryUserStateStore, USER_STATE_KEYS as K } from "../userState/store";
import { UserStateProvider } from "../userState/UserStateContext";
import { BackupPanel } from "./BackupPanel";

afterEach(cleanup);

const backupText = (values: Record<string, unknown>) =>
  JSON.stringify({ kind: BACKUP_KIND, version: 1, exportedAt: "2026-11-18T00:00:00.000Z", values });

function setup(initial: Record<string, unknown> = {}) {
  const store = createMemoryUserStateStore(initial);
  const onImported = vi.fn();
  render(<UserStateProvider store={store}><BackupPanel onImported={onImported} /></UserStateProvider>);
  return { store, onImported };
}

const paste = (text: string) => {
  fireEvent.change(screen.getByLabelText("Or paste its text"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
};

describe("BackupPanel", () => {
  it("is a collapsed details card and counts what would be exported", () => {
    setup({ [K.marks]: { a: "shortlisted", b: "not-interested" }, [K.compare]: ["a"] });
    expect(screen.getByText("Backup & sync").closest("details")?.open).toBe(false);
    expect(screen.getByText("2 marks · 1 compared")).toBeTruthy();
  });

  it("merges a pasted backup only after Apply, then calls onImported", () => {
    const { store, onImported } = setup({ [K.marks]: { a: "shortlisted" } });
    paste(backupText({ [K.marks]: { b: "not-interested" }, [K.nameLanguage]: "en" }));
    expect(screen.getByText("Decision marks")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(store.read(K.marks)).toEqual({ a: "shortlisted" });
    expect(onImported).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(store.read(K.marks)).toEqual({ a: "shortlisted", b: "not-interested" });
    expect(store.read(K.nameLanguage)).toBeUndefined();
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("updates the plan with the controls and can replace", () => {
    const { store } = setup({ [K.marks]: { a: "shortlisted" } });
    paste(backupText({ [K.marks]: { b: "not-interested" }, [K.nameLanguage]: "en" }));
    expect(screen.queryByText("Place-name language")).toBeNull();
    fireEvent.click(screen.getByLabelText("Also take their weights, filters and places"));
    expect(screen.getByText("Place-name language")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Replace mine"));
    expect(screen.queryByLabelText("Also take their weights, filters and places")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(store.read(K.marks)).toEqual({ b: "not-interested" });
  });

  it("shows a polite error for text that is not a backup, and Cancel writes nothing", () => {
    const { store, onImported } = setup();
    paste("hello");
    expect(screen.getByRole("alert").textContent).toMatch(/not valid JSON/);
    paste(backupText({ [K.marks]: { b: "not-interested" } }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(store.read(K.marks)).toBeUndefined();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("copies the export as text and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup({ [K.marks]: { a: "shortlisted" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(JSON.parse(writeText.mock.calls[0][0]).values[K.marks]).toEqual({ a: "shortlisted" });
  });

  it("says so when the clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
    expect(await screen.findByText(/not available/)).toBeTruthy();
  });

  it("plans again on Apply, so a note saved after the preview was drawn is not overwritten", () => {
    const earlier = { text: "old", viewingAt: null, updatedAt: "2026-11-01T00:00:00.000Z" };
    const { store } = setup({ [K.notes]: { a: earlier } });
    paste(backupText({ [K.notes]: { b: { text: "theirs", viewingAt: null, updatedAt: "2026-11-02T00:00:00.000Z" } } }));
    // The app saves a note without this panel rendering again.
    const typed = { text: "typed just now", viewingAt: null, updatedAt: "2026-11-18T00:00:00.000Z" };
    store.write(K.notes, { a: typed });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(store.read(K.notes)).toEqual({ a: typed, b: { text: "theirs", viewingAt: null, updatedAt: "2026-11-02T00:00:00.000Z" } });
  });

  it("warns how many of your own entries a replace deletes", () => {
    setup({ [K.marks]: { a: "shortlisted", b: "shortlisted", c: "applied" } });
    paste(backupText({ [K.marks]: { a: "shortlisted" } }));
    expect(screen.queryByText(/Replacing deletes/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Replace mine"));
    expect(screen.getByText(/Replacing deletes 2 of your own entries/)).toBeTruthy();
    expect(screen.getByText("−2")).toBeTruthy();
  });
});
