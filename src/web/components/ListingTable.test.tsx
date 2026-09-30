// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config/scoring";
import { scoreListing } from "../../domain/scoring";
import { listingKey } from "../../domain/listingKey";
import type { EnrichedListing } from "../../types";
import type { ScoredRow } from "../lib/export";
import { ListingTable } from "./ListingTable";

// jsdom implements neither scrollIntoView nor Element.scrollTo; the table uses
// scrollTo on its own container when a row is selected.
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollTo = () => {};

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

afterEach(cleanup);

const makeRow = (over: Partial<EnrichedListing>): ScoredRow => {
  const listing: EnrichedListing = {
    name: "Test Bldg",
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

const renderTable = (items: ScoredRow[], over: Partial<Parameters<typeof ListingTable>[0]> = {}) =>
  render(
    <ListingTable
      items={items}
      onRemove={() => {}}
      hovered={null}
      onHover={() => {}}
      selected={null}
      onSelect={() => {}}
      onCenterMap={() => {}}
      marks={{}}
      onSetMark={() => {}}
      {...over}
    />,
  );

describe("ListingTable", () => {
  it("renders rows with the city column and reports hover", () => {
    const rows = [
      makeRow({ name: "Soka Place", city: "Soka" }),
      makeRow({ name: "Koshigaya Place", city: "Koshigaya", rent: 70_000 }),
    ];
    const onHover = vi.fn();
    renderTable(rows, { onHover });

    expect(screen.getByText("Soka Place")).toBeTruthy();
    expect(screen.getByText("Koshigaya Place")).toBeTruthy();
    expect(screen.getAllByText("Koshigaya").length).toBeGreaterThan(0);

    fireEvent.mouseEnter(screen.getByText("Soka Place").closest("tr")!);
    expect(onHover).toHaveBeenCalledWith(listingKey(rows[0].listing));
  });

  it("lets users hide columns and persists the selection", () => {
    const rows = [makeRow({ name: "Custom columns" })];
    const first = renderTable(rows);

    fireEvent.click(screen.getByText(/Columns/));
    const cityToggle = screen.getByLabelText("City") as HTMLInputElement;
    expect(cityToggle.checked).toBe(true);
    fireEvent.click(cityToggle);

    expect(screen.queryByRole("columnheader", { name: "City" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("rental-search-hidden-columns-v1")!)).toContain("city");

    first.unmount();
    renderTable(rows);
    expect(screen.queryByRole("columnheader", { name: "City" })).toBeNull();
  });

  it("offers a compact preset and can restore every column", () => {
    renderTable([makeRow({ name: "Preset row" })]);
    fireEvent.click(screen.getByText(/Columns/));
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));

    expect(screen.queryByRole("columnheader", { name: "Nearest mosque" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Rent" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("columnheader", { name: "Nearest mosque" })).toBeTruthy();
  });

  it("shows every portal link on a merged property row", () => {
    const row = makeRow({
      name: "Cross-listed home",
      source: "athome",
      url: "https://athome.example/home",
      sourceListings: [
        { source: "athome", id: "athome-1", url: "https://athome.example/home" },
        { source: "suumo", id: "suumo-1", url: "https://suumo.example/home" },
      ],
    });
    renderTable([row]);

    expect(screen.getByText("athome + suumo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "athome" }).getAttribute("href")).toBe("https://athome.example/home");
    expect(screen.getByRole("link", { name: "suumo" }).getAttribute("href")).toBe("https://suumo.example/home");
  });

  it("highlights the externally-hovered row", () => {
    const rows = [makeRow({ name: "Highlighted" })];
    renderTable(rows, { hovered: listingKey(rows[0].listing) });
    const row = screen.getByText("Highlighted").closest("tr")!;
    expect(row.className).toMatch(/hovered/);
  });

  it("marks the selected row and reports clicks", () => {
    const rows = [makeRow({ name: "Clickable" })];
    const onSelect = vi.fn();
    renderTable(rows, { selected: listingKey(rows[0].listing), onSelect });
    const row = screen.getByText("Clickable").closest("tr")!;
    expect(row.className).toMatch(/selected/);
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(listingKey(rows[0].listing));
  });

  it("centers the local map from the small row button without expanding the row", () => {
    const rows = [makeRow({ name: "Locate me", lat: 35.83, lon: 139.8 })];
    const onCenterMap = vi.fn();
    const onSelect = vi.fn();
    renderTable(rows, { onCenterMap, onSelect });

    fireEvent.click(screen.getByRole("button", { name: "Center local map on Locate me" }));

    expect(onCenterMap).toHaveBeenCalledWith(
      listingKey(rows[0].listing),
      35.83,
      139.8,
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not offer the map button when a row has no coordinates", () => {
    renderTable([makeRow({ name: "Unmapped", lat: undefined, lon: undefined })]);
    expect(screen.queryByRole("button", { name: "Center local map on Unmapped" })).toBeNull();
  });

  it("reports decision-mark changes without expanding the row", () => {
    const rows = [makeRow({ name: "Markable" })];
    const onSetMark = vi.fn();
    const onSelect = vi.fn();
    renderTable(rows, { onSetMark, onSelect });

    const select = screen.getByTitle("Your decision about this property");
    fireEvent.change(select, { target: { value: "not-interested" } });
    expect(onSetMark).toHaveBeenCalledWith(listingKey(rows[0].listing), "not-interested");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.change(select, { target: { value: "" } });
    expect(onSetMark).toHaveBeenCalledWith(listingKey(rows[0].listing), null);
  });

  it("dims ruled-out rows and shows the chosen mark", () => {
    const rows = [makeRow({ name: "Ruled Out" }), makeRow({ name: "Candidate", rent: 90_000 })];
    renderTable(rows, {
      marks: {
        [listingKey(rows[0].listing)]: "no-foreigners",
        [listingKey(rows[1].listing)]: "shortlisted",
      },
    });

    const ruledOutRow = screen.getByText("Ruled Out").closest("tr")!;
    const candidateRow = screen.getByText("Candidate").closest("tr")!;
    expect(ruledOutRow.className).toMatch(/ruledOut/);
    expect(candidateRow.className).not.toMatch(/ruledOut/);

    const selectIn = (row: HTMLElement) =>
      row.querySelector("select") as HTMLSelectElement;
    expect(selectIn(ruledOutRow).value).toBe("no-foreigners");
    expect(selectIn(candidateRow).value).toBe("shortlisted");
  });
});
