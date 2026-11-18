// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnrichedListing } from "../../domain/types";
import { createMemoryUserStateStore, USER_STATE_KEYS } from "../userState/store";
import { UserStateProvider } from "../userState/UserStateContext";
import { InquiryDraft } from "./InquiryDraft";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const listing = (over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  name: "サンハイツ草加",
  address: "埼玉県草加市松原1-1-1",
  city: "Soka",
  rent: 98_500,
  layout: "3LDK",
  sizeM2: 71.12,
  builtYear: 2010,
  stationWalkMin: 8,
  url: "https://example.test/ad/1",
  source: "athome",
  geocoded: true,
  lat: 35.83,
  lon: 139.8,
  ...over,
});

const setup = (l: EnrichedListing = listing(), viewingAt: string | null = null) => {
  const store = createMemoryUserStateStore();
  render(
    <UserStateProvider store={store}>
      <InquiryDraft listing={l} viewingAt={viewingAt} />
    </UserStateProvider>,
  );
  return store;
};

const open = () => fireEvent.click(screen.getByText(/Inquiry draft/));
const jaText = () => document.querySelector('[lang="ja"]')!.textContent ?? "";

describe("InquiryDraft", () => {
  it("builds nothing while closed, then shows the Japanese text with the listing name", () => {
    setup();
    expect(document.querySelector('[lang="ja"]')).toBeNull();
    open();
    expect(jaText()).toContain("サンハイツ草加");
    expect(jaText()).toContain("1. 現在も募集中でしょうか。");
    expect(screen.getByText(/Is it still available\?/)).toBeTruthy();
  });

  it("removes a question's line and renumbers when it is switched off", () => {
    setup();
    open();
    expect(jaText()).toContain("2. 私は外国籍");
    fireEvent.click(screen.getByLabelText("Still available?"));
    expect(jaText()).not.toContain("現在も募集中");
    expect(jaText()).toContain("1. 私は外国籍");
  });

  it("saves the name to the store and writes it into the text", () => {
    const store = setup();
    open();
    fireEvent.click(screen.getByText("About you"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jehandad Kamal" } });
    expect(jaText()).toContain("Jehandad Kamalと申します。");
    expect((store.read(USER_STATE_KEYS.inquiryProfile) as { name: string }).name).toBe("Jehandad Kamal");
  });

  it("copies subject and body, or the body only", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    setup();
    open();
    fireEvent.click(screen.getByText("Copy Japanese"));
    await waitFor(() => expect(screen.getByText("Copied ✓")).toBeTruthy());
    const sent = writeText.mock.calls[0][0] as string;
    expect(sent.startsWith("【お問い合わせ・内見希望】サンハイツ草加（3LDK／98,500円）\n\nご担当者様")).toBe(true);
    fireEvent.click(screen.getByText("Copy body only"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect((writeText.mock.calls[1][0] as string).startsWith("ご担当者様")).toBe(true);
  });

  it("says so when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    setup();
    open();
    fireEvent.click(screen.getByText("Copy Japanese"));
    await waitFor(() => expect(screen.getByText(/Copy is not available/)).toBeTruthy());
  });

  it("links to the ad and uses the booked viewing", () => {
    setup(listing(), "2026-12-05T10:30");
    open();
    const link = screen.getByText("Open the ad ↗") as HTMLAnchorElement;
    expect(link.href).toBe("https://example.test/ad/1");
    expect(link.target).toBe("_blank");
    expect(jaText()).toContain("12月5日（土）10時30分頃");
  });

  it("hides the foreign-tenant question for a UR room", () => {
    setup(listing({ name: "URコンフォール松原", source: "ur" }));
    open();
    expect(screen.queryByLabelText("Accepts a foreign tenant?")).toBeNull();
    expect(jaText()).not.toContain("外国籍");
  });
});
