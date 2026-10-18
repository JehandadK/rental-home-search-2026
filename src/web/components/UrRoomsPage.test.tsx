// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UrRoom, UrRoomsPayload } from "../../domain/urRooms";
import { createMemoryUserStateStore, USER_STATE_KEYS } from "../userState/store";
import { UserStateProvider } from "../userState/UserStateContext";
import { UrRoomsPage } from "./UrRoomsPage";

const room = (id: string, over: Partial<UrRoom>): UrRoom => ({
  id, estateCode: "50_4090", jkss: "000010701", label: "1号棟701号室", layout: "2DK", sizeM2: 50, floor: "7階", rent: 108_400, commonFee: 3_500,
  status: "closed", since: "2026-10-10T04:45:06.660Z", firstSeenAt: "2026-10-08T10:45:29.770Z",
  periods: [{ from: "2026-10-08T10:45:29.770Z", until: "2026-10-10T04:45:06.660Z" }], medianDaysListed: 1.7, sources: ["ur-s"],
  url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090_room.html?JKSS=000010701", ...over,
});

const PAYLOAD: UrRoomsPayload = {
  schemaVersion: 1, generatedAt: "2026-10-14T00:00:00.000Z", historyFrom: "2026-05-29T15:08:33.704Z",
  estates: [
    { code: "50_4090", name: "コンフォール松原", nameEn: "Comfort Matsubara", city: "Soka",
      nearby: { mosque: { name: "Baitul Aman Masjid", distM: 2898, walkMin: 47.1 }, privateSchool: null, station: { name: "獨協大学前", nameEn: "Dokkyodaigakumae", distM: 98, walkMin: 1.6 },
        school: null, kindergarten: null, busStop: null }, url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_4090.html", totalUnits: 3050, roomCount: 2, openCount: 1 },
    { code: "50_1340", name: "草加旭町", city: "Soka", url: "https://www.ur-net.go.jp/chintai/kanto/saitama/50_1340.html", totalUnits: 78, roomCount: 0, openCount: 0 },
  ],
  rooms: [
    room("50_4090-000010701", {}),
    room("50_4090-000070106", { jkss: "000070106", label: "7号棟106号室", layout: "1DK", sizeM2: 43, rent: 92_900, status: "open", since: "2026-10-12T00:00:00.000Z" }),
  ],
};

afterEach(cleanup);

describe("UR rooms page", () => {
  let store: ReturnType<typeof createMemoryUserStateStore>;
  beforeEach(() => {
    store = createMemoryUserStateStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PAYLOAD))));
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderPage = () => render(<UserStateProvider store={store}><UrRoomsPage baseUrl="/data/" onBack={() => {}} /></UserStateProvider>);

  it("lists closed rooms beside open ones, and the estates with none seen", async () => {
    renderPage();
    expect(await screen.findByText(/Closed · let 10 Oct 2026/)).toBeTruthy();
    expect(screen.getByText(/Open now · since 12 Oct 2026/)).toBeTruthy();
    expect(screen.getByText(/2 rooms in 2 estates/)).toBeTruthy();
    expect(screen.getByText(/1 estates with no room seen open yet/)).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/data/ur-rooms.json", expect.objectContaining({ cache: "no-cache" }));
  });

  it("watches a closed room, saves it, and lists it first once it is open", async () => {
    renderPage();
    const closed = (await screen.findByText(/Closed · let/)).closest("li")!;
    fireEvent.click(within(closed).getByRole("button", { name: /Watch/ }));
    expect(store.read(USER_STATE_KEYS.urRoomWatch)).toEqual(["50_4090-000010701"]);
    expect(within(closed).getByRole("button", { name: /Watching/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("Watched only"));
    expect(screen.getAllByRole("listitem").filter((item) => item.textContent?.includes("号室"))).toHaveLength(1);
  });

  it("names each estate in English and shows how far its mosque, station and the rest are", async () => {
    renderPage();
    const closed = (await screen.findByText(/Closed · let/)).closest("li")!;
    expect(within(closed).getByText(/Comfort Matsubara/)).toBeTruthy();
    expect(within(closed).getByText(/コンフォール松原/)).toBeTruthy();
    const nearby = within(closed).getByLabelText("Nearby");
    expect(within(nearby).getByText("2.9 km")).toBeTruthy();
    expect(within(nearby).getByText("Baitul Aman Masjid")).toBeTruthy();
    expect(within(nearby).getByText("Dokkyodaigakumae")).toBeTruthy();
    expect(within(nearby).getAllByText("none nearby in our data")).toHaveLength(4);
  });

  it("limits the rooms to estates near a mosque", async () => {
    renderPage();
    await screen.findByText(/Closed · let/);
    fireEvent.change(screen.getByLabelText("Mosque within km"), { target: { value: "1" } });
    expect(screen.getByText("No room matches these filters.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mosque within km"), { target: { value: "3" } });
    expect(screen.getByText("2 rooms shown")).toBeTruthy();
  });

  it("filters by layout", async () => {
    renderPage();
    await screen.findByText(/Closed · let/);
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "2" } });
    expect(screen.getByText("1 room shown")).toBeTruthy();
    expect(screen.queryByText(/7号棟106号室/)).toBeNull();
  });

  it("says how to publish the data when it is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toMatch(/npm run data:web/);
  });
});
