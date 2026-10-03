// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReferenceDataSnapshot } from "../data-layer/contracts";
import type { EnrichedListing } from "../domain/types";
import { App } from "./App";
import { createStaticWebDataClient } from "./data/staticClient";
import { WebDataBoundary } from "./data/WebDataBoundary";
import { createMemoryUserStateStore, USER_STATE_KEYS, type UserStateStore } from "./userState/store";
import { UserStateProvider } from "./userState/UserStateContext";
import {
  city,
  FIXTURE_LISTINGS,
  FIXTURE_REFERENCE,
  multipolygon,
  place,
  snapshot,
} from "./testing/referenceFixture.contract";

// jsdom has no canvas or scrolling; the map simply skips drawing.
window.HTMLCanvasElement.prototype.getContext = (() => null) as never;
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollTo = () => {};

afterEach(cleanup);

async function renderApp(
  reference: ReferenceDataSnapshot,
  listings: EnrichedListing[] = FIXTURE_LISTINGS,
  store: UserStateStore = createMemoryUserStateStore(),
) {
  render(
    <UserStateProvider store={store}>
      <WebDataBoundary client={createStaticWebDataClient({ listings, reference })}>
        {(data) => <App data={data} />}
      </WebDataBoundary>
    </UserStateProvider>,
  );
  return screen.findByRole("heading", { name: "Soka Rental Scorer" });
}

const placesPanel = () => screen.getByRole("heading", { name: /Places/ }).closest("section") as HTMLElement;
const placeNames = () => within(placesPanel()).queryAllByRole("radio").concat(within(placesPanel()).queryAllByRole("checkbox"))
  .map((input) => input.closest("label")?.textContent);

describe("App over a fake data client", () => {
  it("renders the listings, city chips, and places from the loaded data", async () => {
    await renderApp(FIXTURE_REFERENCE);
    expect(screen.getByText(/2 \/ 2 listings/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Soka · 草加" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Koshigaya · 越谷" })).toBeTruthy();
    expect(placeNames()).toEqual(expect.arrayContaining(["Test School", "Test Masjid", "草加", "草加小学校"]));
    // The default target is the first POI.
    expect((within(placesPanel()).getByRole("radio", { name: "Test School" }) as HTMLInputElement).checked).toBe(true);
  });

  it("picks up added and removed cities and POIs without code changes", async () => {
    const changed = snapshot({
      cities: [...FIXTURE_REFERENCE.cities.records, city("city:yashio", "Yashio", "八潮市")],
      boundaries: [...FIXTURE_REFERENCE.boundaries.records, multipolygon("b:yashio", "city:yashio", 139.84, 35.82)],
      places: [
        ...FIXTURE_REFERENCE.places.records.filter((record) => record.name !== "Test Masjid"),
        place("p:library", "poi", "New Library", 35.81, 139.79),
        place("p:park", "park", "New Park", 35.81, 139.79),
      ],
    });
    await renderApp(changed, [
      ...FIXTURE_LISTINGS,
      { ...FIXTURE_LISTINGS[0], name: "Yashio House", city: "Yashio", address: "埼玉県八潮市1-1" },
    ]);
    expect(screen.getByText(/3 \/ 3 listings/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yashio · 八潮" })).toBeTruthy();
    const names = placeNames();
    expect(names).toEqual(expect.arrayContaining(["Test School", "New Library"]));
    expect(names).not.toContain("Test Masjid");

    // A new POI can become the target.
    fireEvent.click(within(placesPanel()).getByRole("radio", { name: "New Library" }));
    expect((within(placesPanel()).getByRole("radio", { name: "New Library" }) as HTMLInputElement).checked).toBe(true);
  });

  it("stays usable with no listings and an empty reference catalog", async () => {
    await renderApp(snapshot({}), []);
    expect(screen.getByText(/0 \/ 0 listings/)).toBeTruthy();
    expect(screen.getByText(/No listings have been published yet/)).toBeTruthy();
    expect(within(placesPanel()).queryAllByRole("radio")).toEqual([]);
  });
});

describe("user state across reloads", () => {
  it("restores filters, place choices, and marks from the store, under the pre-M6 keys", async () => {
    // A mark saved by an earlier session, in the pre-M6 format.
    const houseA = FIXTURE_LISTINGS[0];
    const store = createMemoryUserStateStore({
      [USER_STATE_KEYS.marks]: { [`${houseA.name}|${houseA.address}|${houseA.rent}`]: "shortlisted" },
    });
    await renderApp(FIXTURE_REFERENCE, FIXTURE_LISTINGS, store);
    fireEvent.click(screen.getByRole("button", { name: "Koshigaya · 越谷" }));
    expect(screen.getByText(/1 \/ 2 listings/)).toBeTruthy();
    fireEvent.click(within(placesPanel()).getByRole("radio", { name: "Test School" }));
    const stationBox = within(placesPanel()).getByRole("checkbox", { name: "草加" });
    fireEvent.click(stationBox);

    expect(store.read(USER_STATE_KEYS.filters)).toMatchObject({ cities: ["Koshigaya"] });
    // Toggling one station while "all" count narrows the choice to that station.
    expect(store.read(USER_STATE_KEYS.placeSelection)).toMatchObject({ byParameter: { poi1: ["poi:Test School"], station: ["station:草加"] } });

    // A reload: a fresh app over the same store.
    cleanup();
    await renderApp(FIXTURE_REFERENCE, FIXTURE_LISTINGS, store);
    expect(screen.getByText(/1 \/ 2 listings/)).toBeTruthy();
    expect(within(placesPanel()).getByText("only 草加")).toBeTruthy();
    expect(screen.getByText(/★1 shortlisted/)).toBeTruthy();
  });

  it("keeps the comparison and notes, and compares homes the filters hide", async () => {
    const store = createMemoryUserStateStore();
    await renderApp(FIXTURE_REFERENCE, FIXTURE_LISTINGS, store);
    const [houseA, houseB] = FIXTURE_LISTINGS;
    expect(screen.queryByRole("region", { name: "Compare homes" })).toBeNull();

    fireEvent.click(screen.getByLabelText(`Compare ${houseA.name}`));
    fireEvent.click(screen.getByLabelText(`Compare ${houseB.name}`));
    const panel = screen.getByRole("region", { name: "Compare homes" });
    expect(within(panel).getByRole("columnheader", { name: new RegExp(houseA.name) })).toBeTruthy();
    expect(within(panel).getByRole("columnheader", { name: new RegExp(houseB.name) })).toBeTruthy();
    expect(store.read(USER_STATE_KEYS.compare)).toHaveLength(2);

    // Open a row and leave a note; collapsing the row saves it.
    const row = screen.getAllByText(houseA.name).find((el) => el.closest("tbody tr td"))!.closest("tr")!;
    fireEvent.click(row);
    fireEvent.change(screen.getByLabelText(/My notes/), { target: { value: "Ask about parking" } });
    fireEvent.click(row);
    expect(Object.values(store.read(USER_STATE_KEYS.notes) as object)).toEqual([
      expect.objectContaining({ text: "Ask about parking", viewingAt: null }),
    ]);
    expect(within(panel).getByText("Ask about parking")).toBeTruthy();

    // A reload, with a city filter that hides one of the pinned homes.
    cleanup();
    await renderApp(FIXTURE_REFERENCE, FIXTURE_LISTINGS, store);
    fireEvent.click(screen.getByRole("button", { name: "Koshigaya · 越谷" }));
    const reloaded = screen.getByRole("region", { name: "Compare homes" });
    expect(within(reloaded).getAllByRole("columnheader", { name: /Fixture House/ })).toHaveLength(2);
    expect(within(reloaded).getByText("filtered out")).toBeTruthy();
    expect(within(reloaded).getByText("Ask about parking")).toBeTruthy();
  });

  it("falls back to defaults when stored state is corrupt", async () => {
    const store = createMemoryUserStateStore({
      [USER_STATE_KEYS.filters]: "not an object",
      [USER_STATE_KEYS.placeSelection]: [1, 2, 3],
      [USER_STATE_KEYS.marks]: { "Fixture House A": "maybe" },
      [USER_STATE_KEYS.scoringConfig]: 17,
      [USER_STATE_KEYS.customListings]: { name: "not a list" },
    });
    await renderApp(FIXTURE_REFERENCE, FIXTURE_LISTINGS, store);
    expect(screen.getByText(/2 \/ 2 listings/)).toBeTruthy();
    expect((within(placesPanel()).getByRole("radio", { name: "Test School" }) as HTMLInputElement).checked).toBe(true);
  });
});
