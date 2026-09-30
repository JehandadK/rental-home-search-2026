// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReferenceDataSnapshot } from "../data-layer/contracts";
import type { EnrichedListing } from "../domain/types";
import { App } from "./App";
import { createStaticWebDataClient } from "./data/staticClient";
import { WebDataBoundary } from "./data/WebDataBoundary";
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

async function renderApp(reference: ReferenceDataSnapshot, listings: EnrichedListing[] = FIXTURE_LISTINGS) {
  render(
    <WebDataBoundary client={createStaticWebDataClient({ listings, reference })}>
      {(data) => <App data={data} />}
    </WebDataBoundary>,
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
