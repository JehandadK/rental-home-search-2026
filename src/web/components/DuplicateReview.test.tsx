// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listingKey } from "../../domain/listingKey";
import { decisionKey, findPossibleDuplicates, listingAdKeys, resolveDecisions, type DuplicateDecision } from "../../domain/possibleDuplicates";
import type { EnrichedListing } from "../../domain/types";
import { DuplicateReview } from "./DuplicateReview";

afterEach(cleanup);

const make = (over: Partial<EnrichedListing>): EnrichedListing => ({
  name: "グレース ゴンゲン",
  address: "埼玉県草加市金明町",
  city: "Soka",
  rent: 175_000,
  layout: "2LDK",
  sizeM2: 69.5,
  builtYear: 2023,
  advertisedStation: "草加駅",
  stationWalkMin: 12,
  url: null,
  source: "athome",
  building: { floor: "3階" },
  geocoded: true,
  lat: 35.83,
  lon: 139.8,
  ...over,
});

const athome = make({ id: "athome-1", url: "https://www.athome.co.jp/chintai/1/" });
const nifty = make({
  id: "nifty-2",
  name: "グレースゴンゲン",
  address: "埼玉県草加市金明町182-8",
  rent: 173_000,
  source: "nifty",
  url: "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_2/",
});
const listingsByKey = new Map([athome, nifty].map((listing) => [listingKey(listing), listing]));
const pairs = findPossibleDuplicates([athome, nifty]);

const renderPanel = (decisions: Record<string, DuplicateDecision> = {}) => {
  const props = {
    onDecide: vi.fn(),
    onUndo: vi.fn(),
    onLocate: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <DuplicateReview
      pairs={pairs}
      listingsByKey={listingsByKey}
      decisions={decisions}
      resolved={resolveDecisions([athome, nifty], decisions)}
      visibleKeys={new Set()}
      {...props}
    />,
  );
  return props;
};

describe("DuplicateReview", () => {
  it("shows both sides with the facts that differ, and records a 'same home' answer by ads", () => {
    const { onDecide } = renderPanel();
    const pair = screen.getByRole("article");
    expect(within(pair).getByText("グレース ゴンゲン")).toBeTruthy();
    expect(within(pair).getByText("グレースゴンゲン")).toBeTruthy();
    expect(within(pair).getByText("¥173,000").closest("div")?.className).toMatch(/differs/);
    expect(within(pair).getByText(/Likely same/)).toBeTruthy();
    fireEvent.click(within(pair).getByRole("button", { name: "Same home" }));
    expect(onDecide).toHaveBeenCalledWith(listingAdKeys(athome), listingAdKeys(nifty), "same");
  });

  it("moves answered pairs out of review, where they can be undone", () => {
    const answer: DuplicateDecision = { verdict: "different", a: listingAdKeys(athome), b: listingAdKeys(nifty), decidedAt: "2026-10-11T05:00:00Z" };
    const id = decisionKey(answer.a, answer.b);
    const { onUndo } = renderPanel({ [id]: answer });
    expect(screen.getByText("Nothing left to review here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Different/ }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledWith(id);
  });

  it("hides pairs outside the user's filters when asked", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("Matching my filters"));
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("closes on Escape, but not when Escape is typed into another panel's field", () => {
    const { onClose } = renderPanel();
    const field = document.body.appendChild(document.createElement("input"));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    field.remove();
  });

  it("shows a 'same' answer a 'Different' answer blocks as not applied", () => {
    const third = make({ id: "roomspot-3", source: "roomspot", url: "https://www.roomspot.net/rent/3" });
    const decide = (verdict: DuplicateDecision["verdict"], x: EnrichedListing, y: EnrichedListing, at: string) =>
      ({ verdict, a: listingAdKeys(x), b: listingAdKeys(y), decidedAt: at });
    const decisions = {
      one: decide("same", athome, nifty, "2026-10-11T01:00:00Z"),
      two: decide("different", athome, third, "2026-10-11T02:00:00Z"),
      three: decide("same", nifty, third, "2026-10-11T03:00:00Z"),
    };
    const all = [athome, nifty, third];
    render(
      <DuplicateReview
        pairs={[]}
        listingsByKey={new Map(all.map((listing) => [listingKey(listing), listing]))}
        decisions={decisions}
        resolved={resolveDecisions(all, decisions)}
        visibleKeys={new Set()}
        onDecide={vi.fn()} onUndo={vi.fn()} onLocate={vi.fn()} onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Same home/ }));
    expect(screen.getAllByText(/not applied/)).toHaveLength(1);
  });
});
