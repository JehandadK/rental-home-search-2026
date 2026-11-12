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
const renderPanel = (
  decisions: Record<string, DuplicateDecision> = {},
  all: EnrichedListing[] = [athome, nifty],
) => {
  const props = {
    onDecide: vi.fn(),
    onUndo: vi.fn(),
    onLocate: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <DuplicateReview
      pairs={findPossibleDuplicates(all)}
      listingsByKey={new Map(all.map((listing) => [listingKey(listing), listing]))}
      decisions={decisions}
      resolved={resolveDecisions(all, decisions)}
      visibleKeys={new Set()}
      {...props}
    />,
  );
  return props;
};

const same = (a: EnrichedListing, b: EnrichedListing) => ({ a: listingAdKeys(a), b: listingAdKeys(b), verdict: "same" });
const different = (a: EnrichedListing, b: EnrichedListing) => ({ a: listingAdKeys(a), b: listingAdKeys(b), verdict: "different" });

describe("DuplicateReview", () => {
  it("shows the listings side by side with the facts that differ, and records a 'same home' answer by ads", () => {
    const { onDecide } = renderPanel();
    const pair = screen.getByRole("article");
    expect(within(pair).getByText("グレース ゴンゲン")).toBeTruthy();
    expect(within(pair).getByText("グレースゴンゲン")).toBeTruthy();
    expect(within(pair).getByText("¥173,000").className).toMatch(/differs/);
    // One portal stops at the 丁目 and the other prints the lot: not a difference.
    expect(within(pair).getByText("埼玉県草加市金明町182-8").className).not.toMatch(/differs/);
    expect(within(pair).getByText(/Likely same/)).toBeTruthy();
    fireEvent.click(within(pair).getByRole("button", { name: "Same home" }));
    expect(onDecide).toHaveBeenCalledWith([same(athome, nifty)]);
  });

  it("moves answered pairs out of review, where they can be undone", () => {
    const answer: DuplicateDecision = { verdict: "different", a: listingAdKeys(athome), b: listingAdKeys(nifty), decidedAt: "2026-10-11T05:00:00Z" };
    const id = decisionKey(answer.a, answer.b);
    const { onUndo } = renderPanel({ [id]: answer });
    expect(screen.getByText("Nothing left to review here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Different/ }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledWith([id]);
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

  describe("three listings that may all be one home", () => {
    const roomspot = make({ id: "roomspot-3", source: "roomspot", rent: 177_000, url: "https://www.roomspot.net/rent/3" });
    const all = [athome, nifty, roomspot];

    it("are one case, answered in one go", () => {
      const { onDecide } = renderPanel({}, all);
      const card = screen.getByRole("article");
      expect(within(card).getAllByRole("checkbox")).toHaveLength(3);
      fireEvent.click(within(card).getByRole("button", { name: "Same home" }));
      const [answers] = onDecide.mock.calls[0];
      expect(answers).toHaveLength(2);
      expect(answers.every((answer: { verdict: string }) => answer.verdict === "same")).toBe(true);
    });

    it("leave out a listing that is unticked, as a different home from the rest", () => {
      const { onDecide } = renderPanel({}, all);
      const card = screen.getByRole("article");
      const column = within(card).getByText("¥177,000");
      const position = [...column.parentElement!.children].indexOf(column) - 1;
      fireEvent.click(within(card).getAllByRole("checkbox")[position]);
      fireEvent.click(within(card).getByRole("button", { name: "Same home (2)" }));
      const [answers] = onDecide.mock.calls[0];
      expect(answers).toEqual(expect.arrayContaining([same(athome, nifty), different(athome, roomspot), different(nifty, roomspot)]));
      expect(answers).toHaveLength(3);
    });

    it("can all be marked different", () => {
      const { onDecide } = renderPanel({}, all);
      fireEvent.click(screen.getByRole("button", { name: "All different" }));
      expect(onDecide.mock.calls[0][0]).toHaveLength(3);
    });
  });

  it("answers the case in focus from the keyboard, and moves with the arrows", () => {
    const elsewhere = make({ id: "athome-9", name: "ロイヤル越谷", address: "埼玉県草加市松原１丁目", sizeM2: 55, url: "https://www.athome.co.jp/chintai/9/" });
    const copy = make({ id: "nifty-9", name: "ロイヤル越谷", address: "埼玉県草加市松原１丁目", sizeM2: 55, rent: 178_000, source: "nifty", url: "https://myhome.nifty.com/rent/saitama/sokashi_ct/detail_9/" });
    const { onDecide } = renderPanel({}, [athome, nifty, elsewhere, copy]);
    const [first, second] = screen.getAllByRole("article");
    expect(first.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(second.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(window, { key: "d" });
    expect(onDecide.mock.calls[0][0][0].verdict).toBe("different");
    // Typing in a field elsewhere, a key pressed in another panel, or Shift+S is not an answer.
    const field = document.body.appendChild(document.createElement("input"));
    const elsewherePanel = document.body.appendChild(document.createElement("button"));
    fireEvent.keyDown(field, { key: "s" });
    fireEvent.keyDown(elsewherePanel, { key: "s" });
    fireEvent.keyDown(window, { key: "S", shiftKey: true });
    expect(onDecide).toHaveBeenCalledTimes(1);
    field.remove();
    elsewherePanel.remove();
  });

  it("still answers from the keyboard after a listing is unticked", () => {
    const roomspot = make({ id: "roomspot-3", source: "roomspot", rent: 177_000, url: "https://www.roomspot.net/rent/3" });
    const { onDecide } = renderPanel({}, [athome, nifty, roomspot]);
    const [box] = screen.getAllByRole("checkbox").slice(-3);
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: "s" });
    expect(onDecide.mock.calls[0][0]).toHaveLength(3);
    // The case is being answered by hand, so the bulk answer no longer offers it.
    expect(screen.queryByRole("button", { name: /^Mark all/ })).toBeNull();
  });

  it("keeps a case in focus when an arrow is pressed with nothing to review", () => {
    const { rerender } = render(
      <DuplicateReview pairs={null} listingsByKey={new Map()} decisions={{}} resolved={resolveDecisions([], {})}
        visibleKeys={new Set()} onDecide={vi.fn()} onUndo={vi.fn()} onLocate={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.keyDown(window, { key: "ArrowDown" });
    const all = [athome, nifty];
    rerender(
      <DuplicateReview pairs={findPossibleDuplicates(all)} listingsByKey={new Map(all.map((listing) => [listingKey(listing), listing]))}
        decisions={{}} resolved={resolveDecisions(all, {})}
        visibleKeys={new Set()} onDecide={vi.fn()} onUndo={vi.fn()} onLocate={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("article").getAttribute("aria-current")).toBe("true");
  });

  it("marks every likely case the same home at once, after asking, and can take it back", () => {
    const { onDecide, onUndo } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Mark all 1 same" }));
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, same home" }));
    expect(onDecide).toHaveBeenCalledWith([same(athome, nifty)]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledWith([decisionKey(listingAdKeys(athome), listingAdKeys(nifty))]);
  });
});
