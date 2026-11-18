// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBriefing } from "../../domain/briefing";
import type { MarketEstimate } from "../../domain/marketRent";
import type { MarkMap } from "../../domain/marks";
import type { NoteMap } from "../../domain/notes";
import type { ScoredRow } from "../../domain/scoring";
import type { EnrichedListing } from "../../domain/types";
import { BriefingBar } from "./BriefingBar";

afterEach(cleanup);

const NOW = new Date(2026, 10, 18, 9, 0);

const listing = (id: string, over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  id,
  name: `Home ${id}`,
  address: "埼玉県草加市",
  rent: 100_000,
  layout: "2LDK",
  sizeM2: 50,
  builtYear: 2010,
  stationWalkMin: 8,
  url: null,
  source: "suumo",
  geocoded: true,
  lat: 35.83,
  lon: 139.8,
  status: "active",
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const estimate = (deltaRatio: number): MarketEstimate => ({
  expectedRent: 100_000, deltaYen: Math.round(deltaRatio * 100_000), deltaRatio, confidence: "high", comparables: [],
});

function renderBar(homes: [EnrichedListing, number][], over: {
  marks?: MarkMap; notes?: NoteMap; market?: Map<string, MarketEstimate>; seenDataAt?: string | null;
} = {}) {
  const rows: ScoredRow[] = homes.map(([home, total]) => ({ listing: home, score: { total, parts: [] } }));
  const market = over.market ?? new Map<string, MarketEstimate>();
  const seenDataAt = over.seenDataAt ?? null;
  const briefing = buildBriefing({
    rows, all: homes.map(([home]) => home), marks: over.marks ?? {}, notes: over.notes ?? {}, market, seenDataAt, newWithinDays: 14, now: NOW,
  });
  const handlers = { onReview: vi.fn(), onMarkSeen: vi.fn(), onShow: vi.fn(), onSetMark: vi.fn() };
  render(<BriefingBar briefing={briefing} seenDataAt={seenDataAt} newWithinDays={14} market={market} {...handlers} />);
  return handlers;
}

describe("BriefingBar", () => {
  it("counts the new homes since the acknowledged data and opens their review", () => {
    const fresh = listing("fresh", { firstSeenAt: "2026-11-18T02:00:00.000Z" });
    const old = listing("old");
    const { onReview, onMarkSeen } = renderBar([[fresh, 70], [old, 90]], { seenDataAt: "2026-11-13T03:00:00.000Z" });

    expect(screen.getByText("1 new home")).toBeTruthy();
    expect(screen.getByText("match your filters since 13 Nov")).toBeTruthy();
    expect(screen.getByText("2 undecided homes")).toBeTruthy();

    fireEvent.click(screen.getByText("Review them"));
    expect(onReview).toHaveBeenCalledWith("New since 13 Nov", [expect.objectContaining({ listing: fresh })]);

    fireEvent.click(screen.getByText("Mark all seen"));
    expect(onMarkSeen).toHaveBeenCalledTimes(1);
  });

  it("says so when nothing is new, and offers no review", () => {
    renderBar([[listing("old"), 90]], { seenDataAt: "2026-11-13T03:00:00.000Z" });
    expect(screen.getByText("Nothing new")).toBeTruthy();
    expect(screen.queryByText("Review them")).toBeNull();
    expect(screen.queryByText("Best of the new")).toBeNull();
  });

  it("reviews the deals, the biggest gap first", () => {
    const a = listing("a");
    const b = listing("b");
    const { onReview } = renderBar([[a, 90], [b, 50]], { market: new Map([["a", estimate(-0.16)], ["b", estimate(-0.3)]]) });
    expect(screen.getByText("2 deals")).toBeTruthy();
    fireEvent.click(screen.getByText("Review deals"));
    expect(onReview.mock.calls[0][1].map(({ listing: home }: ScoredRow) => home.id)).toEqual(["b", "a"]);
  });

  it("waits for the market estimates before saying there are no deals", () => {
    renderBar([[listing("a"), 90]]);
    expect(screen.getByText("Pricing homes…")).toBeTruthy();
    expect(screen.queryByText("No deals")).toBeNull();
  });

  it("names the best of the new homes and shows one when clicked", () => {
    const top = listing("top", { firstSeenAt: "2026-11-18T02:00:00.000Z", rent: 98_000 });
    const { onShow } = renderBar([[top, 72]], { seenDataAt: "2026-11-13T03:00:00.000Z", market: new Map([["top", estimate(-0.12)]]) });
    fireEvent.click(screen.getByText(/Home top · ¥98,000 · 2LDK · −12% vs market/));
    expect(onShow).toHaveBeenCalledWith(top);
  });

  it("warns about a shortlisted home that is no longer advertised and can mark it taken", () => {
    const lost = listing("lost", { status: "sold" });
    const { onSetMark } = renderBar([[listing("kept"), 50]].concat([[lost, 60]]) as [EnrichedListing, number][], { marks: { lost: "shortlisted" } });
    expect(screen.getByText("⚠ 1 home you were pursuing may be taken")).toBeTruthy();
    expect(screen.getByText("Home lost · no longer advertised")).toBeTruthy();
    fireEvent.click(screen.getByText("mark taken"));
    expect(onSetMark).toHaveBeenCalledWith("lost", "taken");
  });

  it("lists the viewings ahead", () => {
    const home = listing("view");
    renderBar([[home, 50]], { notes: { view: { text: "", viewingAt: "2026-11-21T14:00", updatedAt: "2026-11-01T00:00:00.000Z" } } });
    expect(screen.getByText("📅 Viewings")).toBeTruthy();
    expect(screen.getByText("Sat 21 Nov 14:00")).toBeTruthy();
  });
});
