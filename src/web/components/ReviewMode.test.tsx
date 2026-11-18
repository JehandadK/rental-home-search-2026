// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEAL_RATIO, formatMarketDelta, type MarketEstimate } from "../../domain/marketRent";
import type { MarkMap } from "../../domain/marks";
import type { ScoredRow } from "../../domain/scoring";
import { DEFAULT_CONFIG } from "../../domain/scoringConfig";
import type { EnrichedListing } from "../../domain/types";
import { ReviewMode, type ReviewModeProps } from "./ReviewMode";

afterEach(cleanup);

const home = (id: string, name: string, over: Partial<EnrichedListing> = {}): ScoredRow => ({
  listing: {
    id,
    name,
    address: "埼玉県草加市金明町",
    city: "Soka",
    rent: 120_000,
    layout: "3LDK",
    sizeM2: 70,
    builtYear: 2015,
    advertisedStation: "草加駅",
    stationWalkMin: 9,
    url: `https://www.athome.co.jp/chintai/${id}/`,
    source: "athome",
    geocoded: true,
    lat: 35.83,
    lon: 139.8,
    ...over,
  },
  score: {
    total: 72,
    parts: [
      { key: "rent", value: 120_000, score: 80, weight: 3 },
      { key: "size", value: 70, score: 60, weight: 2 },
      { key: "station", value: 9, score: 70, weight: 1 },
      { key: "school", value: 15, score: 20, weight: 1 },
      { key: "busStop", value: 3, score: 90, weight: 0 },
    ],
  },
});

const rows = [home("a", "Alpha House"), home("b", "Bravo Court"), home("c", "Charlie Heights")];

const renderReview = (over: Partial<ReviewModeProps> = {}) => {
  const props: ReviewModeProps = {
    title: "New homes",
    rows,
    marks: {},
    onSetMark: vi.fn(),
    notes: {},
    onSetNote: vi.fn(),
    costBasis: DEFAULT_CONFIG,
    market: new Map(),
    newWithinDays: 14,
    onLocate: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const { rerender } = render(<ReviewMode {...props} />);
  return { ...props, props, rerender };
};

const press = (key: string, target: Element | Window = window) => fireEvent.keyDown(target, { key });
const shown = () => screen.getByRole("heading", { level: 3 }).textContent;

describe("ReviewMode", () => {
  it("shows the first home, the progress and the breakdown, as a modal", () => {
    renderReview();
    const dialog = screen.getByRole("dialog", { name: "New homes" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.overflow).toBe("hidden");
    expect(shown()).toBe("Alpha House");
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getAllByText("¥120,000").length).toBeGreaterThan(0);
    // Unweighted criteria are left out; the rest go by contribution.
    expect(screen.queryByText("Bus stop")).toBeNull();
    expect(screen.getByText(/strong on Rent and Size/)).toBeTruthy();
    expect(screen.getByText(/held back by School|held back by Elem\. school/)).toBeTruthy();
  });

  it("marks with S, X and F and moves on each time", () => {
    const { onSetMark } = renderReview();
    press("s");
    expect(onSetMark).toHaveBeenLastCalledWith("a", "shortlisted");
    expect(shown()).toBe("Bravo Court");
    press("x");
    expect(onSetMark).toHaveBeenLastCalledWith("b", "not-interested");
    press("F");
    expect(onSetMark).toHaveBeenLastCalledWith("c", "no-foreigners");
    expect(screen.getByText("Reviewed 3 · 1 shortlisted · 2 ruled out · 0 skipped")).toBeTruthy();
  });

  it("clears a mark the home already has, without moving on", () => {
    const marks: MarkMap = { a: "shortlisted" };
    const { onSetMark } = renderReview({ marks });
    press("s");
    expect(onSetMark).toHaveBeenCalledWith("a", null);
    expect(shown()).toBe("Alpha House");
  });

  it("skips with → or J or Space and goes back with ← or K", () => {
    const { onSetMark } = renderReview();
    press("ArrowRight");
    expect(shown()).toBe("Bravo Court");
    press("j");
    expect(shown()).toBe("Charlie Heights");
    press("ArrowLeft");
    expect(shown()).toBe("Bravo Court");
    press("k");
    expect(shown()).toBe("Alpha House");
    press(" ");
    expect(shown()).toBe("Bravo Court");
    expect(onSetMark).not.toHaveBeenCalled();
  });

  it("undoes the last decision back to the home and its earlier mark", () => {
    const { onSetMark } = renderReview({ marks: { a: "no-foreigners" } });
    press("s");
    press("ArrowRight");
    expect(shown()).toBe("Charlie Heights");
    press("u");
    expect(onSetMark).toHaveBeenLastCalledWith("a", "no-foreigners");
    expect(shown()).toBe("Alpha House");
  });

  it("closes on Escape", () => {
    const { onClose } = renderReview();
    press("Escape");
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores keys typed into the note, and with Ctrl or Meta held", () => {
    const { onSetMark, onClose } = renderReview();
    const note = screen.getByRole("textbox");
    press("s", note);
    press("j", note);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.keyDown(window, { key: "x", metaKey: true });
    expect(onSetMark).not.toHaveBeenCalled();
    expect(shown()).toBe("Alpha House");
    // Escape in the note leaves the note rather than the review.
    note.focus();
    press("Escape", note);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps its queue when the parent drops a marked home from the rows", () => {
    const { props, rerender } = renderReview();
    press("s");
    rerender(<ReviewMode {...props} rows={rows.slice(1).reverse()} marks={{ a: "shortlisted" }} />);
    expect(shown()).toBe("Bravo Court");
    expect(screen.getByText("2 / 3")).toBeTruthy();
    // The dropped home can still be gone back to.
    press("k");
    expect(shown()).toBe("Alpha House");
  });

  it("sums up at the end and offers the skipped homes again", () => {
    const { onClose } = renderReview();
    press("s");
    press("j");
    press("x");
    expect(screen.getByText("Reviewed 3 · 1 shortlisted · 1 ruled out · 1 skipped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review the skipped ones" }));
    expect(shown()).toBe("Bravo Court");
    expect(screen.getByText("1 / 1")).toBeTruthy();
    press("j");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says so when there is nothing to review", () => {
    const { onClose } = renderReview({ rows: [] });
    expect(screen.getByText("Nothing to review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the market verdict only when there is one", () => {
    const estimate = (deltaRatio: number, confidence: MarketEstimate["confidence"]): MarketEstimate => ({
      expectedRent: 140_000, deltaYen: -20_000, deltaRatio, confidence, comparables: [],
    });
        const deal = DEAL_RATIO - 0.02;
    renderReview({ market: new Map([["a", estimate(deal, "high")], ["b", estimate(-0.5, "low")]]) });
    expect(screen.getByText(`DEAL ${formatMarketDelta(deal)} · similar homes ask ~¥140,000`)).toBeTruthy();
    press("j");
    expect(screen.queryByText(/similar homes ask/)).toBeNull();
    press("j");
    expect(screen.queryByText(/similar homes ask/)).toBeNull();
  });

  it("works from the buttons, links each ad, and shows the home on the map", () => {
    const { onSetMark, onLocate, onClose } = renderReview();
    expect(screen.getByRole("link", { name: /athome/ }).getAttribute("rel")).toBe("noreferrer");
    fireEvent.click(screen.getByRole("button", { name: /Not interested/ }));
    expect(onSetMark).toHaveBeenCalledWith("a", "not-interested");
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    expect(onLocate).toHaveBeenCalledWith("b", 35.83, 139.8);
    expect(onClose).toHaveBeenCalled();
  });

  it("turns the page on a sideways swipe, not a vertical one", () => {
    renderReview();
    const swipe = (from: [number, number], to: [number, number]) => {
      const card = screen.getByRole("article");
      fireEvent.touchStart(card, { touches: [{ clientX: from[0], clientY: from[1] }] });
      fireEvent.touchEnd(card, { changedTouches: [{ clientX: to[0], clientY: to[1] }] });
    };
    swipe([300, 100], [200, 110]);
    expect(shown()).toBe("Bravo Court");
    swipe([300, 100], [280, 400]);
    expect(shown()).toBe("Bravo Court");
    swipe([100, 100], [220, 100]);
    expect(shown()).toBe("Alpha House");
  });
});
