// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../domain/scoringConfig";
import { scoreListing, type ScoredRow } from "../../domain/scoring";
import { listingKey } from "../../domain/listingKey";
import type { EnrichedListing } from "../../domain/types";
import { ComparePanel } from "./ComparePanel";

afterEach(cleanup);

const makeRow = (over: Partial<EnrichedListing>): ScoredRow => {
  const listing: EnrichedListing = {
    name: "Home",
    address: "埼玉県草加市",
    city: "Soka",
    rent: 100_000,
    layout: "2LDK",
    sizeM2: 55,
    builtYear: 2010,
    stationWalkMin: 8,
    url: null,
    source: "test",
    geocoded: true,
    lat: 35.83,
    lon: 139.8,
    ...over,
  };
  return { listing, score: scoreListing(listing, DEFAULT_CONFIG) };
};

const A = makeRow({ name: "Alpha", id: "a", rent: 90_000, sizeM2: 60, layout: "2LDK" });
const B = makeRow({ name: "Bravo", id: "b", rent: 110_000, sizeM2: 70, layout: "2LDK" });

const renderPanel = (rows: ScoredRow[], over: Partial<Parameters<typeof ComparePanel>[0]> = {}) =>
  render(
    <ComparePanel
      rows={rows}
      ranks={new Map([[listingKey(A.listing), 1]])}
      rankedCount={12}
      costBasis={DEFAULT_CONFIG}
      marks={{}}
      notes={{}}
      onRemove={() => {}}
      onClear={() => {}}
      onLocate={() => {}}
      {...over}
    />,
  );

/** A fact row by its English label (the Japanese one, if any, follows it directly). */
const factRow = (label: string) =>
  screen.getByRole("rowheader", { name: new RegExp(`^${label}($|[^\\x00-\\x7F])`) }).closest("tr")!;
const cells = (label: string) => [...factRow(label).querySelectorAll("td")];

describe("ComparePanel", () => {
  it("puts the homes side by side and highlights the best value in each row", () => {
    renderPanel([A, B]);
    expect(screen.getByRole("columnheader", { name: /Alpha/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Bravo/ })).toBeTruthy();

    const [rentA, rentB] = cells("Rent");
    expect(rentA.textContent).toBe("¥90,000");
    expect(rentA.className).toMatch(/best/);
    expect(rentB.className).not.toMatch(/best/);

    const [sizeA, sizeB] = cells("Size");
    expect(sizeB.className).toMatch(/best/);
    expect(sizeA.className).not.toMatch(/best/);

    // Same layout: nothing to point at.
    expect(cells("Layout").some((td) => /best/.test(td.className))).toBe(false);
  });

  it("shows the rank, or that a pinned home is filtered out", () => {
    renderPanel([A, B]);
    expect(cells("Rank").map((td) => td.textContent)).toEqual(["#1 of 12", "filtered out"]);
  });

  it("shows the 2-year cost, notes and booked viewings", () => {
    renderPanel([A, B], {
      notes: { [listingKey(B.listing)]: { text: "Agent: no pets", viewingAt: "2026-10-05T14:00", updatedAt: "" } },
    });
    expect(cells("2-year cost")[0].textContent).toMatch(/^¥[\d,]+$/);
    expect(cells("Notes")[1].textContent).toBe("Agent: no pets");
    expect(cells("Viewing")[1].textContent).toBe("📅 Mon 5 Oct 14:00");
  });

  it("can hide rows where every home is the same", () => {
    renderPanel([A, B]);
    expect(screen.getByRole("rowheader", { name: "Layout" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Only differences"));
    expect(screen.queryByRole("rowheader", { name: "Layout" })).toBeNull();
    expect(factRow("Rent")).toBeTruthy();
  });

  it("removes one home, clears all, and locates a home on the map", () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    const onLocate = vi.fn();
    renderPanel([A, B], { onRemove, onClear, onLocate });
    fireEvent.click(screen.getByLabelText("Remove Bravo from the comparison"));
    expect(onRemove).toHaveBeenCalledWith(listingKey(B.listing));
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Alpha/ })).getByRole("button", { name: "Alpha" }));
    expect(onLocate).toHaveBeenCalledWith(listingKey(A.listing), 35.83, 139.8);
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("invites a second pick when only one home is pinned", () => {
    renderPanel([A]);
    expect(screen.getByText(/to put homes side by side/)).toBeTruthy();
  });
});
