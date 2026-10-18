/**
 * Every UR room we know of, open now or closed (let), so a closed room can be
 * watched and waited for. UR advertises only vacant rooms; a closed room here
 * is one seen open before (src/domain/urRooms.ts).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { UrRoom, UrRoomsEstate, UrRoomsPayload } from "../../domain/urRooms";
import type { UrEstateNearby, UrNearbyPlace } from "../../domain/urEstateNearby";
import { DEFAULT_UR_ROOMS_FILTERS, filterUrRooms, totalRent, type UrRoomsFilters, type UrRoomsSort } from "../../domain/urRoomsView";
import { fetchUrRooms } from "../data/urRoomsClient";
import { decodeUrRoomsFilters, decodeUrRoomWatch } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";
import styles from "./UrRoomsPage.module.css";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; payload: UrRoomsPayload };

const yen = (value: number) => `¥${value.toLocaleString("ja-JP")}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Tokyo" });
const days = (value: number) => (value < 1 ? "under a day" : `${value % 1 ? value.toFixed(1) : value} day${value === 1 ? "" : "s"}`);

const km = (distM: number) => `${(distM / 1000).toFixed(1)} km`;

/** The estate's name in English with the Japanese beside it; just the Japanese when no English is known. */
const estateTitle = (estate: Pick<UrRoomsEstate, "name" | "nameEn"> | undefined, fallback: string) => estate?.nameEn ?? estate?.name ?? fallback;

const NEARBY_ROWS: { key: keyof UrEstateNearby; label: string }[] = [
  { key: "mosque", label: "Mosque" },
  { key: "privateSchool", label: "Private school" },
  { key: "station", label: "Station" },
  { key: "school", label: "School" },
  { key: "kindergarten", label: "Kindergarten" },
  { key: "busStop", label: "Bus stop" },
];

const SORTS: { value: UrRoomsSort; label: string }[] = [
  { value: "watched", label: "Watched & open first" },
  { value: "often", label: "Most often listed" },
  { value: "recent", label: "Listed most recently" },
  { value: "rent", label: "Rent, low to high" },
  { value: "size", label: "Size, large to small" },
  { value: "mosque", label: "Nearest mosque" },
];

export function UrRoomsPage({ baseUrl = `${import.meta.env.BASE_URL}data/`, onBack }: { baseUrl?: string; onBack: () => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = usePersistentState<UrRoomsFilters>(USER_STATE_KEYS.urRoomsFilters, decodeUrRoomsFilters);
  const [watchList, setWatchList] = usePersistentState<string[]>(USER_STATE_KEYS.urRoomWatch, decodeUrRoomWatch);
  const watched = useMemo(() => new Set(watchList), [watchList]);

  useEffect(() => {
    const controller = new AbortController();
    // A reload keeps the rooms on screen until the new data arrives.
    setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
    fetchUrRooms(baseUrl, { signal: controller.signal }).then(
      (payload) => { if (!controller.signal.aborted) setLoad({ status: "ready", payload }); },
      (error: Error) => { if (!controller.signal.aborted) setLoad({ status: "error", message: error.message }); },
    );
    return () => controller.abort();
  }, [baseUrl, attempt]);

  const update = useCallback((patch: Partial<UrRoomsFilters>) => setFilters((current) => ({ ...current, ...patch })), [setFilters]);
  const toggleWatch = useCallback((id: string) => setWatchList((current) => (current.includes(id) ? current.filter((kept) => kept !== id) : [...current, id])), [setWatchList]);

  const payload = load.status === "ready" ? load.payload : null;
  const estateByCode = useMemo(() => new Map((payload?.estates ?? []).map((estate) => [estate.code, estate])), [payload]);
  const cities = useMemo(() => [...new Set((payload?.estates ?? []).map((estate) => estate.city).filter((city): city is string => !!city))], [payload]);
  const shown = useMemo(
    () => (payload ? filterUrRooms(payload.rooms, filters, {
      cityOf: (code) => estateByCode.get(code)?.city ?? null,
      mosqueM: (code) => estateByCode.get(code)?.nearby?.mosque?.distM ?? null,
      watched,
    }) : []),
    [payload, filters, estateByCode, watched],
  );
  const openCount = payload?.rooms.filter((room) => room.status === "open").length ?? 0;
  const watchedOpen = payload?.rooms.filter((room) => room.status === "open" && watched.has(room.id)) ?? [];
  const quietEstates = (payload?.estates ?? []).filter((estate) => estate.roomCount === 0);

  return (
    <section className={styles.page} aria-labelledby="ur-rooms-title">
      <div className={styles.head}>
        <h2 id="ur-rooms-title">UR rooms — open and closed</h2>
        <button type="button" className="secondary" onClick={onBack}>← Back to listings</button>
      </div>
      <p className={styles.intro}>
        UR advertises only the rooms that are vacant today, so every site shows open rooms only. This page lists every UR room
        in our area that has been seen open{payload?.historyFrom ? ` since ${day(payload.historyFrom)}` : ""}, including the ones
        let since. A let room comes up again when its tenant moves out: ☆ Watch the ones you want and they rise to the top when
        they open. Rooms differ in size within an estate, so they are not scored: each estate shows how far the nearest
        mosque, private school, station, school, kindergarten and bus stop are instead.
      </p>

      {load.status === "loading" && <p className={styles.status}>Loading UR rooms…</p>}
      {load.status === "error" && (
        <p className={styles.status} role="alert">
          UR rooms could not be loaded ({load.message}). Run <code>npm run data:web</code> to publish them.{" "}
          <button type="button" className="secondary" onClick={() => setAttempt((count) => count + 1)}>Retry</button>
        </p>
      )}

      {payload && (
        <>
          <p className={styles.summary}>
            {payload.rooms.length} rooms in {payload.estates.length} estates · <strong>{openCount} open now</strong> ·{" "}
            {payload.rooms.length - openCount} closed · ☆ {watched.size} watched
            {watchedOpen.length > 0 && <strong className={styles.alert}> · {watchedOpen.length} watched room{watchedOpen.length === 1 ? " is" : "s are"} open!</strong>}
          </p>

          <div className={styles.filters}>
            <label>City
              <select value={filters.city} onChange={(event) => update({ city: event.target.value, estate: "" })}>
                <option value="">All cities</option>
                {cities.map((city) => <option key={city} value={city}>{city}</option>)}
              </select>
            </label>
            <label>Estate
              <select value={filters.estate} onChange={(event) => update({ estate: event.target.value })}>
                <option value="">All estates</option>
                {payload.estates
                  .filter((estate) => estate.roomCount > 0 && (!filters.city || estate.city === filters.city))
                  .map((estate) => <option key={estate.code} value={estate.code}>{estateTitle(estate, estate.code)} ({estate.openCount}/{estate.roomCount})</option>)}
              </select>
            </label>
            <label>Status
              <select value={filters.status} onChange={(event) => update({ status: event.target.value as UrRoomsFilters["status"] })}>
                <option value="all">Open and closed</option>
                <option value="open">Open now</option>
                <option value="closed">Closed (let)</option>
              </select>
            </label>
            <label>Layout
              <select value={filters.minRooms} onChange={(event) => update({ minRooms: Number(event.target.value) })}>
                <option value={0}>Any</option>
                <option value={2}>2 rooms or more</option>
                <option value={3}>3 rooms or more</option>
                <option value={4}>4 rooms or more</option>
              </select>
            </label>
            <label>Min ㎡
              <input type="number" min={0} step={5} value={filters.minSizeM2 ?? ""} placeholder="any"
                onChange={(event) => update({ minSizeM2: Number(event.target.value) > 0 ? Number(event.target.value) : null })} />
            </label>
            <label>Max rent incl. 共益費
              <input type="number" min={0} step={5000} value={filters.maxRent ?? ""} placeholder="any"
                onChange={(event) => update({ maxRent: Number(event.target.value) > 0 ? Number(event.target.value) : null })} />
            </label>
            <label>Mosque within km
              <input type="number" min={0} step={0.5} value={filters.maxMosqueKm ?? ""} placeholder="any"
                onChange={(event) => update({ maxMosqueKm: Number(event.target.value) > 0 ? Number(event.target.value) : null })} />
            </label>
            <label>Sort
              <select value={filters.sort} onChange={(event) => update({ sort: event.target.value as UrRoomsSort })}>
                {SORTS.map((sort) => <option key={sort.value} value={sort.value}>{sort.label}</option>)}
              </select>
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={filters.watchedOnly} onChange={(event) => update({ watchedOnly: event.target.checked })} />
              Watched only
            </label>
            <button type="button" className="secondary" onClick={() => setFilters(DEFAULT_UR_ROOMS_FILTERS)}>Reset</button>
          </div>

          <p className={styles.count}>{shown.length} room{shown.length === 1 ? "" : "s"} shown</p>
          {shown.length === 0 ? (
            <p className={styles.status}>No room matches these filters.</p>
          ) : (
            <ul className={styles.grid}>
              {shown.map((room) => (
                <RoomCard key={room.id} room={room} estate={estateByCode.get(room.estateCode)}
                  watched={watched.has(room.id)} onToggleWatch={toggleWatch} />
              ))}
            </ul>
          )}

          {quietEstates.length > 0 && (
            <details className={styles.quiet}>
              <summary>{quietEstates.length} estates with no room seen open yet</summary>
              <ul>
                {quietEstates.map((estate) => (
                  <li key={estate.code}>
                    <a href={estate.url} target="_blank" rel="noreferrer">{estateTitle(estate, estate.code)}</a>
                    {estate.nameEn && <span className={styles.muted}> {estate.name}</span>}
                    {estate.city && ` · ${estate.city}`}{estate.totalUnits ? ` · ${estate.totalUnits.toLocaleString("en")} units` : ""}
                    {estate.nearby?.mosque && ` · mosque ${km(estate.nearby.mosque.distM)}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className={styles.footnote}>
            Closed means the room left UR's vacancy list: usually let, sometimes held by an application. History comes from our own
            daily reads of UR and from ラク賃不動産 (www.ur-s.jp), which has recorded UR vacancies since May 2026. Updated{" "}
            {day(payload.generatedAt)}.
          </p>
        </>
      )}
    </section>
  );
}

function Nearby({ nearby }: { nearby: UrEstateNearby }) {
  return (
    <dl className={styles.nearby} aria-label="Nearby">
      {NEARBY_ROWS.map(({ key, label }) => {
        const place: UrNearbyPlace | null = nearby[key];
        return (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {place
                ? <><strong>{km(place.distM)}</strong> · {Math.round(place.walkMin)} min walk <span className={styles.muted}>{place.nameEn ?? place.name}</span></>
                : <span className={styles.muted}>none nearby in our data</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function RoomCard({ room, estate, watched, onToggleWatch }: {
  room: UrRoom; estate: UrRoomsEstate | undefined; watched: boolean; onToggleWatch: (id: string) => void;
}) {
  const estateName = estateTitle(estate, room.estateCode);
  const city = estate?.city ?? null;
  const estateUrl = estate?.url ?? null;
  const mapQuery = estate?.lat !== undefined && estate.lon !== undefined ? `${estate.lat},${estate.lon}` : `UR ${estate?.name ?? room.estateCode}`;
  const rent = totalRent(room);
  const open = room.status === "open";
  return (
    <li className={`${styles.card} ${open ? styles.open : ""} ${watched ? styles.watched : ""}`}>
      <div className={styles.cardHead}>
        <span className={open ? styles.badgeOpen : styles.badgeClosed}>
          {open ? `Open now · since ${day(room.since)}` : `Closed · let ${day(room.since)}`}
        </span>
        <button type="button" className={styles.watch} aria-pressed={watched} onClick={() => onToggleWatch(room.id)}
          title={watched ? "Stop watching this room" : "Watch this room: it rises to the top when it opens"}>
          {watched ? "★ Watching" : "☆ Watch"}
        </button>
      </div>
      <div className={styles.layout}>
        {room.layout ?? "—"}
        <span className={styles.size}>{room.sizeM2 !== null ? `${room.sizeM2}㎡` : ""}{room.floor ? ` · ${room.floor}` : ""}</span>
      </div>
      <div className={styles.name}>{estateName} <span className={styles.room}>{room.label}</span></div>
      <div className={styles.muted}>{[estate?.nameEn ? estate.name : null, city].filter(Boolean).join(" · ")}</div>
      <div className={styles.rent}>
        {room.rent !== null ? yen(room.rent) : "Rent unknown"}
        {room.commonFee ? <span className={styles.muted}> + {yen(room.commonFee)} 共益費</span> : null}
        {!open && rent !== null && <span className={styles.muted}> (last asked)</span>}
      </div>
      <div className={styles.muted}>
        Listed {room.periods.length}× since {day(room.firstSeenAt)}
        {room.medianDaysListed !== null && ` · typically open ${days(room.medianDaysListed)}`}
      </div>
      {estate?.nearby && <Nearby nearby={estate.nearby} />}
      <div className={styles.links}>
        {open
          ? <a href={room.url} target="_blank" rel="noreferrer">View room on UR</a>
          : estateUrl && <a href={estateUrl} target="_blank" rel="noreferrer">Estate on UR</a>}
        <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`} target="_blank" rel="noreferrer">Map</a>
      </div>
    </li>
  );
}
