// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../domain/scoringConfig";
import { scoreListing } from "../../domain/scoring";
import { listingKey } from "../../domain/listingKey";
import type { EnrichedListing } from "../../domain/types";
import type { ScoredRow } from "../../domain/scoring";
import { ListingTable } from "./ListingTable";
import { resetUnavailablePhotos } from "./ListingPhoto";

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

afterEach(() => {
  cleanup();
  resetUnavailablePhotos();
});

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
  it("shows a portal photo thumbnail and falls back past missing pictures", () => {
    const url = "https://suumo.jp/chintai/jnc_000000000001/?bc=100000000111";
    renderTable([makeRow({ name: "Photo home", source: "suumo", url }), makeRow({ name: "No ad photos" })]);
    const exterior = screen.getByAltText("Exterior of Photo home") as HTMLImageElement;
    expect(exterior.src).toBe("https://img01.suumo.com/front/gazo/fr/bukken/111/100000000111/100000000111_gw.jpg");
    expect(exterior.getAttribute("referrerpolicy")).toBe("no-referrer");

    // A failed exterior gives way to the floor plan …
    fireEvent.error(exterior);
    const floorPlan = screen.getByAltText("Floor plan of Photo home");
    // … and SUUMO's 100×100 "no image" placeholder counts as missing too.
    fireEvent.load(floorPlan);
    expect(screen.queryByAltText("Floor plan of Photo home")).toBeNull();
    expect(screen.getAllByTitle("No photo from this listing's portals")).toHaveLength(2);
  });

  it("shows photos an AtHome, Nifty or RoomSpot collector captured", () => {
    renderTable([makeRow({ name: "Captured home", source: "athome", url: "https://www.athome.co.jp/chintai/1/",
      photos: [{ url: "https://www.athome.co.jp/image_files/path/AAA==", kind: "photo", source: "athome" }] })]);
    expect((screen.getByAltText("Photo of Captured home") as HTMLImageElement).src).toBe("https://www.athome.co.jp/image_files/path/AAA==");
  });

  it("fades a real photo in once it has loaded", () => {
    renderTable([makeRow({ name: "Loaded home", source: "suumo", url: "https://suumo.jp/chintai/jnc_000000000002/?bc=100000000222" })]);
    const image = screen.getByAltText("Exterior of Loaded home");
    Object.defineProperty(image, "naturalWidth", { value: 280 });
    Object.defineProperty(image, "naturalHeight", { value: 210 });
    fireEvent.load(image);
    expect(screen.getByAltText("Exterior of Loaded home").className).toMatch(/loaded/);
  });

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

  it("expands only the clicked row when two listings share a building name", () => {
    const rows = [
      makeRow({ name: "Leopalace Soka", id: "suumo:1", source: "suumo", rent: 70_000 }),
      makeRow({ name: "Leopalace Soka", id: "suumo:2", source: "suumo", rent: 72_000 }),
    ];
    expect(listingKey(rows[0].listing)).not.toBe(listingKey(rows[1].listing));
    renderTable(rows);
    fireEvent.click(screen.getAllByText("Leopalace Soka")[0].closest("tr")!);
    expect(screen.getAllByText("Move-in costs")).toHaveLength(1);
  });

  describe("cost columns", () => {
    const parked = { monthlyYen: 8_000, available: true, location: "onsite" as const, distanceM: null, raw: "敷地内8000円" };

    it("shows the monthly outlay and the 2-year cost, following the parking switch", () => {
      // ¥100k rent, 55㎡, defaults: ¥100k key money + ¥110k agency + ¥50k guarantor
      // + ¥20k insurance + ¥66k cleaning + ¥30k of the deposit = ¥376k sunk.
      const row = makeRow({ name: "Costed", costs: { parking: parked, monthlyExtrasYen: 1_000 } });
      const first = renderTable([row]);
      expect(screen.getByRole("columnheader", { name: /Monthly/ })).toBeTruthy();
      const cells = () => [...screen.getByText("Costed").closest("tr")!.querySelectorAll("td")].map((td) => td.textContent);
      expect(cells()).toContain("¥101,000");
      expect(cells()).toContain(`¥${(376_000 + 24 * 101_000).toLocaleString("ja-JP")}`);
      first.unmount();

      renderTable([row], { costBasis: { moveIn: DEFAULT_CONFIG.moveIn, includeParking: true } });
      expect(cells()).toContain("¥109,000");
    });

    it("flags parking that should count but has no price", () => {
      renderTable([makeRow({ name: "No parking price" })], { costBasis: { moveIn: DEFAULT_CONFIG.moveIn, includeParking: true } });
      expect(screen.getByText("¥100,000*")).toBeTruthy();
    });

    it("sorts by the 2-year cost", () => {
      const rows = [
        makeRow({ name: "Pricey", id: "a", rent: 120_000 }),
        makeRow({ name: "Cheap", id: "b", rent: 60_000 }),
      ];
      renderTable(rows);
      const names = () => [...document.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td[title]")?.textContent);
      // Like the other cost columns, the first click puts the cheapest first.
      fireEvent.click(screen.getByRole("columnheader", { name: /2-yr cost/ }));
      expect(names()[0]).toMatch(/^Cheap/);
      fireEvent.click(screen.getByRole("columnheader", { name: /2-yr cost/ }));
      expect(names()[0]).toMatch(/^Pricey/);
    });
  });

  describe("notes", () => {
    afterEach(() => vi.useRealTimers());

    it("badges a row with a note, or with its booked viewing", () => {
      const rows = [makeRow({ name: "Noted", id: "n1" }), makeRow({ name: "Viewing", id: "n2" })];
      renderTable(rows, {
        notes: {
          [listingKey(rows[0].listing)]: { text: "Agent wants a guarantor", viewingAt: null, updatedAt: "" },
          [listingKey(rows[1].listing)]: { text: "", viewingAt: "2026-10-05T14:00", updatedAt: "" },
        },
      });
      expect(screen.getByTitle("Agent wants a guarantor").textContent).toBe("📝");
      expect(screen.getByText("📅 Mon 5 Oct 14:00")).toBeTruthy();
    });

    it("saves a typed note after a pause, and a viewing time at once", () => {
      vi.useFakeTimers();
      const rows = [makeRow({ name: "Editable" })];
      const onSetNote = vi.fn();
      renderTable(rows, { onSetNote });
      fireEvent.click(screen.getByText("Editable").closest("tr")!);

      fireEvent.change(screen.getByLabelText(/My notes/), { target: { value: "Damp bathroom" } });
      expect(onSetNote).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(600));
      expect(onSetNote).toHaveBeenLastCalledWith(listingKey(rows[0].listing), { text: "Damp bathroom", viewingAt: null });

      fireEvent.change(screen.getByLabelText(/Viewing/), { target: { value: "2026-10-05T14:00" } });
      expect(onSetNote).toHaveBeenLastCalledWith(listingKey(rows[0].listing), { text: "Damp bathroom", viewingAt: "2026-10-05T14:00" });
      expect(onSetNote).toHaveBeenCalledTimes(2);
    });

    it("keeps the open editor and its draft through a re-sort", () => {
      const rows = [makeRow({ name: "Pricier", id: "p", rent: 120_000 }), makeRow({ name: "Cheaper", id: "c", rent: 60_000 })];
      const onSetNote = vi.fn();
      renderTable(rows, { onSetNote });
      fireEvent.click(screen.getByText("Pricier").closest("tr")!);
      const editor = screen.getByLabelText(/My notes/);
      fireEvent.change(editor, { target: { value: "Half a thought" } });

      // Score order puts the cheaper home first; rent descending moves the open row to the top.
      const order = () => [...document.querySelectorAll("tbody tr td[title]")].map((td) => td.textContent);
      expect(order()[0]).toMatch(/^Cheaper/);
      fireEvent.click(screen.getByRole("columnheader", { name: /^Rent/ }));
      fireEvent.click(screen.getByRole("columnheader", { name: /^Rent/ }));
      expect(order()[0]).toMatch(/^Pricier/);
      expect(screen.getByLabelText(/My notes/)).toBe(editor);
      expect((editor as HTMLTextAreaElement).value).toBe("Half a thought");
    });

    it("keeps a half-typed note when the row is collapsed", () => {
      const rows = [makeRow({ name: "Collapsing" })];
      const onSetNote = vi.fn();
      renderTable(rows, { onSetNote });
      const row = screen.getByText("Collapsing").closest("tr")!;
      fireEvent.click(row);
      fireEvent.change(screen.getByLabelText(/My notes/), { target: { value: "Call back Tue" } });
      fireEvent.click(row);
      expect(screen.queryByLabelText(/My notes/)).toBeNull();
      expect(onSetNote).toHaveBeenCalledWith(listingKey(rows[0].listing), { text: "Call back Tue", viewingAt: null });
    });
  });

  describe("compare", () => {
    it("pins a row without expanding it, and stops at four", () => {
      const rows = ["a", "b", "c", "d", "e"].map((id, i) => makeRow({ name: `Home ${id}`, id, rent: 80_000 + i }));
      const onToggleCompare = vi.fn();
      const onSelect = vi.fn();
      renderTable(rows, {
        onToggleCompare,
        onSelect,
        compare: rows.slice(0, 4).map(({ listing }) => listingKey(listing)),
      });
      fireEvent.click(screen.getByLabelText("Compare Home a"));
      expect(onToggleCompare).toHaveBeenCalledWith(listingKey(rows[0].listing));
      expect(onSelect).not.toHaveBeenCalled();
      expect((screen.getByLabelText("Compare Home a") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByLabelText("Compare Home e") as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByRole("link", { name: /Compare 4/ }).getAttribute("href")).toBe("#compare");
    });

    it("offers no compare column when comparing is not wired", () => {
      renderTable([makeRow({ name: "Plain" })]);
      expect(screen.queryByLabelText("Compare Plain")).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "Compare" })).toBeNull();
    });
  });

  describe("availability", () => {
    const SUUMO = "https://suumo.jp/chintai/jnc_000000000001/";
    const ATHOME = "https://www.athome.co.jp/chintai/1143327034/";
    const gone = { state: "gone" as const, checkedAt: "2026-09-30T00:00:00.000Z", evidence: "HTTP 404", method: "probe" as const };

    it("badges a property whose every ad is gone, and strikes through the gone links", () => {
      const rented = makeRow({ name: "Rented Place", sourceListings: [
        { source: "suumo", url: SUUMO, availability: gone }, { source: "athome", url: ATHOME, availability: gone },
      ] });
      const partly = makeRow({ name: "Partly Place", rent: 90_000, sourceListings: [
        { source: "suumo", url: SUUMO, availability: gone }, { source: "athome", url: ATHOME },
      ] });
      renderTable([rented, partly]);
      const badges = screen.getAllByText("RENTED OUT");
      expect(badges).toHaveLength(1);
      expect(badges[0].closest("tr")!.textContent).toContain("Rented Place");
      const partlyRow = screen.getByText("Partly Place").closest("tr")!;
      expect(partlyRow.textContent).not.toContain("RENTED OUT");
      expect(partlyRow.querySelector('a[href="' + SUUMO + '"]')!.className).toMatch(/linkGone/);
      expect(partlyRow.querySelector('a[href="' + ATHOME + '"]')!.className).not.toMatch(/linkGone/);
    });

    it("marks one ad gone or still listed by hand without opening the row", () => {
      const onMarkAd = vi.fn();
      const onSelect = vi.fn();
      const row = makeRow({ name: "Toggle Place", sourceListings: [
        { source: "suumo", url: SUUMO, availability: gone }, { source: "athome", url: ATHOME },
      ] });
      renderTable([row], { onMarkAd, onSelect });
      fireEvent.click(screen.getByLabelText("Mark athome ad as gone"));
      expect(onMarkAd).toHaveBeenLastCalledWith(expect.objectContaining({ source: "athome", url: ATHOME }), "gone");
      fireEvent.click(screen.getByLabelText("Mark suumo ad as still listed"));
      expect(onMarkAd).toHaveBeenLastCalledWith(expect.objectContaining({ source: "suumo", url: SUUMO }), "listed");
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("shows no toggles when marking is not wired", () => {
      renderTable([makeRow({ name: "Plain", sourceListings: [{ source: "suumo", url: SUUMO }] })]);
      expect(screen.queryByLabelText("Mark suumo ad as gone")).toBeNull();
    });
  });
});

describe("ListingTable score evidence", () => {
  it("draws a partial score as a hollow pill with its data coverage", () => {
    const full = makeRow({ name: "Fully known" });
    const partial = makeRow({ name: "Half known", sizeM2: null, builtYear: null });
    renderTable([full, partial]);
    const partialRow = screen.getByText("Half known").closest("tr")!;
    const pill = within(partialRow).getByLabelText(/^Score \d+, from \d+ of \d+ criteria$/);
    expect(pill.className).toMatch(/pillPartial/);
    expect(pill.closest("[title]")!.getAttribute("title")).toMatch(/No data for: .*Size.*Age/);
    expect(within(partialRow).getByText(/^\d+\/\d+$/)).toBeTruthy();
  });

  it("shows how far a row just moved in the ranking", () => {
    const rows = [makeRow({ name: "Climber" }), makeRow({ name: "Faller", rent: 90_000 })];
    renderTable(rows, {
      rankMoves: new Map([[listingKey(rows[0].listing), 3], [listingKey(rows[1].listing), -1]]),
    });
    expect(within(screen.getByText("Climber").closest("tr")!).getByText("↑3").getAttribute("title"))
      .toBe("Up 3 places after the last scoring change");
    expect(within(screen.getByText("Faller").closest("tr")!).getByText("↓1")).toBeTruthy();
  });

  it("shows the empty state only when nothing matches", () => {
    const { rerender } = renderTable([makeRow({ name: "Only one" })], { emptyState: <p>Nothing here</p> });
    expect(screen.queryByText("Nothing here")).toBeNull();
    rerender(
      <ListingTable items={[]} onRemove={() => {}} hovered={null} onHover={() => {}} selected={null}
        onSelect={() => {}} onCenterMap={() => {}} marks={{}} onSetMark={() => {}} emptyState={<p>Nothing here</p>} />,
    );
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });
});
