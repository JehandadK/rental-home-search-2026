// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReferenceDataSnapshot } from "../../data-layer/contracts";
import type { ListingQueryResult, ReadResult, WebDataClient } from "../../data-layer/read/contracts";
import { FIXTURE_LISTINGS, FIXTURE_REFERENCE, snapshot } from "../testing/referenceFixture.contract";
import { createStaticWebDataClient } from "./staticClient";
import type { WebData } from "./useWebData";
import { WebDataBoundary } from "./WebDataBoundary";

afterEach(cleanup);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A client whose every call returns the next queued deferred response. */
function scriptedClient() {
  const listings: Deferred<ReadResult<ListingQueryResult>>[] = [];
  const references: Deferred<ReadResult<ReferenceDataSnapshot>>[] = [];
  const signals: AbortSignal[] = [];
  const client: WebDataClient = {
    queryListings: (options) => {
      if (options?.signal) signals.push(options.signal);
      const next = deferred<ReadResult<ListingQueryResult>>();
      listings.push(next);
      return next.promise;
    },
    loadReferenceSnapshot: () => {
      const next = deferred<ReadResult<ReferenceDataSnapshot>>();
      references.push(next);
      return next.promise;
    },
  };
  return { client, listings, references, signals };
}

const renderBoundary = (client: WebDataClient) => {
  const seen: WebData[] = [];
  render(
    <WebDataBoundary client={client}>
      {(data) => {
        seen.push(data);
        return <p>ready: {data.listings.length} listings, {data.reference.catalog.places.length} places</p>;
      }}
    </WebDataBoundary>,
  );
  return seen;
};

describe("WebDataBoundary", () => {
  it("shows a loading state until a slow response arrives", async () => {
    const script = scriptedClient();
    renderBoundary(script.client);
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);

    await act(async () => script.listings[0].resolve({ data: { listings: FIXTURE_LISTINGS } }));
    // Listings alone are not enough: nothing renders until the reference data loads too.
    expect(screen.queryByText(/ready/)).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);

    await act(async () => script.references[0].resolve({ data: FIXTURE_REFERENCE }));
    expect(screen.getByText("ready: 2 listings, 4 places")).toBeTruthy();
  });

  it("shows an error with a retry, and renders once the retry succeeds", async () => {
    const script = scriptedClient();
    renderBoundary(script.client);
    await act(async () => {
      script.listings[0].reject(new Error("HTTP 503"));
      script.references[0].resolve({ data: FIXTURE_REFERENCE });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/HTTP 503/);
    expect(screen.queryByText(/ready/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);
    expect(script.signals[0].aborted).toBe(true);
    await act(async () => {
      script.listings[1].resolve({ data: { listings: FIXTURE_LISTINGS } });
      script.references[1].resolve({ data: FIXTURE_REFERENCE });
    });
    expect(screen.getByText("ready: 2 listings, 4 places")).toBeTruthy();
  });

  it("reports invalid reference data as an error instead of crashing", async () => {
    const duplicate = snapshot({
      places: [
        { ...FIXTURE_REFERENCE.places.records[0], id: "a", attributes: { appPlaceId: "poi:x" } },
        { ...FIXTURE_REFERENCE.places.records[0], id: "b", attributes: { appPlaceId: "poi:x" } },
      ],
    });
    renderBoundary(createStaticWebDataClient({ listings: FIXTURE_LISTINGS, reference: duplicate }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Duplicate app place id/);
  });

  it("renders stale fallback data with a notice, and keeps it while a retry fails", async () => {
    const script = scriptedClient();
    const seen = renderBoundary(script.client);
    await act(async () => {
      script.listings[0].resolve({ data: { listings: FIXTURE_LISTINGS }, stale: { reason: "network unavailable" } });
      script.references[0].resolve({ data: FIXTURE_REFERENCE });
    });
    expect(screen.getByText("ready: 2 listings, 4 places")).toBeTruthy();
    expect(screen.getByText(/older copy/).textContent).toMatch(/Listings: network unavailable/);
    expect(seen.at(-1)?.stale).toEqual(["Listings: network unavailable"]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // The stale data stays on screen during the retry.
    expect(screen.getByText("ready: 2 listings, 4 places")).toBeTruthy();
    await act(async () => {
      script.listings[1].reject(new Error("still offline"));
      script.references[1].resolve({ data: FIXTURE_REFERENCE });
    });
    expect(screen.getByText("ready: 2 listings, 4 places")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a superseded response that arrives after a retry", async () => {
    const script = scriptedClient();
    renderBoundary(script.client);
    await act(async () => script.listings[0].reject(new Error("first failure")));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      script.listings[1].resolve({ data: { listings: FIXTURE_LISTINGS } });
      script.references[1].resolve({ data: FIXTURE_REFERENCE });
    });
    // The first attempt's reference response is late and must not re-render anything.
    await act(async () => script.references[0].resolve({ data: snapshot({}) }));
    expect(screen.getByText("ready: 2 listings, 4 places")).toBeTruthy();
  });

  it("shows notices for empty listings and an empty reference catalog", async () => {
    renderBoundary(createStaticWebDataClient({ listings: [], reference: snapshot({}) }));
    expect(await screen.findByText("ready: 0 listings, 0 places")).toBeTruthy();
    expect(screen.getByText(/No listings have been published yet/)).toBeTruthy();
    expect(screen.getByText(/reference catalog is empty/)).toBeTruthy();
  });
});
