/**
 * Ranked results table. Click a row to expand the per-parameter score
 * breakdown; click a column header to sort by that parameter's raw value.
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SCORE_PARAMETERS } from "../../domain/scoringConfig";
import { scoreColor, type ScorePart } from "../../domain/scoring";
import {
  computeMoveInCosts,
  parkingInfo,
  parkingMonthlyYen,
  stayCost,
  STAY_MONTHS,
  type StayCost,
} from "../../domain/moveInCost";
import { DEFAULT_CONFIG, FEATURE_PARAMETERS, type ScoringConfig } from "../../domain/scoringConfig";
import { ATTRIBUTE_CATEGORY_LABELS } from "../../domain/listingAttributes";
import { listingKey } from "../../domain/listingKey";
import { sourceListings as portalReferences } from "../../domain/listingDedup";
import { isNewListing, isSold } from "../../domain/lifecycle";
import { describeAvailability, isRentedOut } from "../../domain/availability";
import { isRuledOut, LISTING_MARKS, markRank, type ListingMark, type MarkMap } from "../../domain/marks";
import { listingPhotos } from "../../domain/listingPhotos";
import { describeNote, formatViewing, type NoteDraft, type NoteMap } from "../../domain/notes";
import { MAX_COMPARE } from "../../domain/compare";
import type { ScoredRow } from "../../domain/scoring";
import type { ScoreParameterKey, SourceListingReference } from "../../domain/types";
import { decodeHiddenColumns } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { useUserStateStore } from "../userState/UserStateContext";
import { ListingThumb, PhotoGallery } from "./ListingPhoto";
import { NoteEditor } from "./NoteEditor";
import styles from "./ListingTable.module.css";
import appStyles from "../App.module.css";

interface Props {
  items: ScoredRow[];
  onRemove: (name: string) => void;
  hovered: string | null;
  onHover: (key: string | null) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onCenterMap: (key: string, lat: number, lon: number) => void;
  /** The user's decision marks, keyed by listingKey. */
  marks: MarkMap;
  onSetMark: (key: string, mark: ListingMark | null) => void;
  /** Record by hand that one portal ad is gone or still listed. */
  onMarkAd?: (ad: SourceListingReference, state: "gone" | "listed") => void;
  /** Move-in assumptions and the parking switch behind the cost columns. */
  costBasis?: CostBasis;
  /** The user's notes, keyed by listingKey; editable in the expanded row. */
  notes?: NoteMap;
  onSetNote?: (key: string, draft: NoteDraft) => void;
  /** Listing keys pinned for side-by-side comparison. */
  compare?: readonly string[];
  onToggleCompare?: (key: string) => void;
}

export type CostBasis = Pick<ScoringConfig, "moveIn" | "includeParking">;

const NO_NOTES: NoteMap = {};
const NO_COMPARE: readonly string[] = [];

type SortKey = "score" | "mark" | "monthly" | "stay" | ScoreParameterKey;
type ColumnKey =
  | "locate" | "rank" | "photo" | "city" | "mark" | "compare" | "score" | "monthly" | "stay"
  | ScoreParameterKey | "links";

interface TableColumn {
  key: ColumnKey;
  label: string;
}

const yen = new Intl.NumberFormat("ja-JP");
const PAGE_SIZE = 100;
const TABLE_COLUMNS: readonly TableColumn[] = [
  { key: "locate", label: "Map" },
  { key: "rank", label: "Rank" },
  { key: "photo", label: "Photo" },
  { key: "city", label: "City" },
  { key: "mark", label: "Decision" },
  { key: "compare", label: "Compare" },
  { key: "score", label: "Score" },
  { key: "monthly", label: "Monthly" },
  { key: "stay", label: "2-yr cost" },
  ...SCORE_PARAMETERS.map(({ key, label }) => ({ key, label })),
  { key: "links", label: "Links" },
];
const COLUMN_KEYS = new Set<ColumnKey>(TABLE_COLUMNS.map(({ key }) => key));
const COMPACT_COLUMNS = new Set<ColumnKey>([
  "locate",
  "photo",
  "city",
  "mark",
  "compare",
  "score",
  "monthly",
  "stay",
  "rent",
  "moveInCost",
  "size",
  "station",
  "links",
]);

/** Format a parameter's raw value for compact table display. */
function formatValue(part: ScorePart | undefined): string {
  if (!part || part.value == null) return "—";
  switch (part.key) {
    case "rent":
      return `¥${yen.format(part.value)}`;
    case "rentPerM2":
      return `¥${yen.format(part.value)}`;
    case "moveInCost":
      return `${part.value}mo`;
    case "size":
      return `${part.value}`;
    case "yearBuilt":
      return `${part.value}y`;
    default:
      return part.value === 1 ? "Yes" : part.value === 0 ? "No" : `${part.value}`;
  }
}

/** Monthly outlay, flagged when parking should count but has no price. */
function formatMonthly(cost: StayCost): string {
  return `¥${yen.format(cost.monthly)}${cost.parkingUnknown ? "*" : ""}`;
}

function monthlyTitle(listing: ScoredRow["listing"], cost: StayCost): string {
  const parts = [`rent ¥${yen.format(listing.rent)} (incl. 管理費)`];
  const extras = listing.costs?.monthlyExtrasYen;
  if (extras) parts.push(`extras ¥${yen.format(extras)}`);
  const parking = cost.monthly - listing.rent - (extras ?? 0);
  if (parking > 0) parts.push(`parking ¥${yen.format(parking)}`);
  return parts.join(" + ") + (cost.parkingUnknown ? "\n* parking price not stated, so not included" : "");
}

function stayTitle(cost: StayCost): string {
  return `¥${yen.format(cost.sunk)} sunk move-in + ${cost.months} × ¥${yen.format(cost.monthly)}`
    + (cost.parkingUnknown ? "\n* parking price not stated, so not included" : "");
}

export const ListingTable = memo(function ListingTable({
  items,
  onRemove,
  hovered,
  onHover,
  selected,
  onSelect,
  onCenterMap,
  marks,
  onSetMark,
  onMarkAd,
  costBasis = DEFAULT_CONFIG,
  notes = NO_NOTES,
  onSetNote,
  compare = NO_COMPARE,
  onToggleCompare,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [ascending, setAscending] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const userState = useUserStateStore();
  const [hiddenColumns, setHiddenColumns] = useState<Set<ColumnKey>>(
    () => decodeHiddenColumns(userState.read(USER_STATE_KEYS.hiddenColumns), COLUMN_KEYS),
  );
  // Rendering 1,500+ table rows and ~15,000 cells at once dominates browser
  // startup. Render the first useful slice, then opt into more as needed.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLTableRowElement>(null);
  const { moveIn, includeParking } = costBasis;

  /** Monthly outlay and 2-year cost per listing, for the cost columns and their sort. */
  const stayCosts = useMemo(
    () => new Map(items.map(({ listing }) => [listing, stayCost(listing, moveIn, includeParking)] as const)),
    [items, moveIn, includeParking],
  );

  const sorted = useMemo(() => {
    const valueOf = ({ listing, score }: ScoredRow): number => {
      if (sortKey === "score") return score.total ?? -1;
      if (sortKey === "mark") return markRank(marks[listingKey(listing)]);
      if (sortKey === "monthly") return stayCosts.get(listing)!.monthly;
      if (sortKey === "stay") return stayCosts.get(listing)!.total;
      if (sortKey === "rent") return listing.rent;
      if (sortKey === "rentPerM2") return listing.sizeM2 ? listing.rent / listing.sizeM2 : Number.MAX_SAFE_INTEGER;
      if (sortKey === "size") return listing.sizeM2 ?? -1;
      if (sortKey === "yearBuilt") return listing.builtYear ?? -1;
      return score.parts.find((p) => p.key === sortKey)?.value ?? Number.MAX_SAFE_INTEGER;
    };
    return [...items].sort((a, b) => {
      const diff = valueOf(a) - valueOf(b);
      // Grouping by decision keeps the best score on top within each group.
      if (sortKey === "mark" && diff === 0) {
        return (b.score.total ?? -1) - (a.score.total ?? -1);
      }
      return (sortKey === "score" ? -diff : diff) * (ascending ? -1 : 1);
    });
  }, [items, sortKey, ascending, marks, stayCosts]);

  // Only a *selection* (a click on the map) scrolls the table — and only the
  // table's own container, never the page. Hover never scrolls anything.
  useEffect(() => {
    if (!selected) return;
    // A map selection may rank below the first 100 rendered rows. Expand just
    // far enough to mount it before attempting the scroll.
    const selectedIndex = sorted.findIndex(({ listing }) => listingKey(listing) === selected);
    if (selectedIndex >= visibleCount) {
      setVisibleCount(Math.ceil((selectedIndex + 1) / PAGE_SIZE) * PAGE_SIZE);
      return;
    }
    const row = selectedRowRef.current;
    const container = scrollRef.current;
    if (!row || !container) return;
    const rowTop = row.offsetTop - container.offsetTop;
    const target = rowTop - container.clientHeight / 2 + row.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [selected, sorted, visibleCount]);

  useEffect(() => setVisibleCount(PAGE_SIZE), [items, sortKey, ascending]);

  // Without storage the table stays customizable; the choice just won't
  // carry into the next browser session.
  useEffect(() => userState.write(USER_STATE_KEYS.hiddenColumns, [...hiddenColumns]), [userState, hiddenColumns]);

  // Hovering a map marker updates this component frequently. Cache the slice
  // so those transient renders reuse the same row array.
  const visible = useMemo(() => sorted.slice(0, visibleCount), [sorted, visibleCount]);
  const shows = (key: ColumnKey) => !hiddenColumns.has(key);
  // Portal ads ordered by preference (athome → suumo → nifty), all retained.
  const referencesFor = portalReferences;
  const toggleColumn = (key: ColumnKey) => {
    setHiddenColumns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const offered = (key: ColumnKey) => key !== "compare" || onToggleCompare != null;
  // Name is always shown.
  const visibleColumnCount = TABLE_COLUMNS.filter(({ key }) => offered(key) && shows(key)).length + 1;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setAscending((a) => !a);
    else {
      setSortKey(key);
      setAscending(false);
    }
  };

  const sortMark = (key: SortKey) => (key === sortKey ? (ascending ? " ▲" : " ▼") : "");
  const compareFull = compare.length >= MAX_COMPARE;

  return (
    <section className={appStyles.card}>
      <div className={styles.tableHeading}>
        <h2 className={appStyles.cardTitle}>
          Ranked listings <span className={styles.count}>{items.length} total</span>
        </h2>
        {compare.length > 0 && onToggleCompare && (
          <a className={styles.compareLink} href="#compare" title="Jump to the side-by-side comparison">
            ⇄ Compare {compare.length}
          </a>
        )}
        <details className={styles.columnPicker}>
          <summary>
            Columns <span>{visibleColumnCount}/{TABLE_COLUMNS.filter(({ key }) => offered(key)).length + 1}</span>
          </summary>
          <div className={styles.columnMenu}>
            <div className={styles.columnActions}>
              <button type="button" onClick={() => setHiddenColumns(new Set())}>Show all</button>
              <button
                type="button"
                onClick={() => setHiddenColumns(new Set(TABLE_COLUMNS.filter(({ key }) => !COMPACT_COLUMNS.has(key)).map(({ key }) => key)))}
              >
                Compact
              </button>
            </div>
            <label className={styles.lockedColumn} title="Names are always shown so rows remain identifiable">
              <input type="checkbox" checked disabled />
              Name
            </label>
            {TABLE_COLUMNS.filter(({ key }) => offered(key)).map((column) => (
              <label key={column.key}>
                <input
                  type="checkbox"
                  checked={shows(column.key)}
                  onChange={() => toggleColumn(column.key)}
                />
                {column.label}
              </label>
            ))}
          </div>
        </details>
      </div>
      <div className={styles.scroll} ref={scrollRef}>
        <table className={styles.table}>
          <thead>
            <tr>
              {shows("locate") && <th className={styles.locateHeader} aria-label="Center on map" />}
              {shows("rank") && <th>#</th>}
              {shows("photo") && <th className={styles.photoCell} aria-label="Photo" />}
              <th className={styles.left}>Name</th>
              {shows("city") && <th>City</th>}
              {shows("mark") && (
                <th
                  onClick={() => toggleSort("mark")}
                  title="Your decision (shortlist, taken, …) — click to group by it"
                >
                  Decision{sortMark("mark")}
                </th>
              )}
              {shows("compare") && onToggleCompare && (
                <th title={`Pin up to ${MAX_COMPARE} homes to compare side by side`}>Compare</th>
              )}
              {shows("score") && <th onClick={() => toggleSort("score")}>Score{sortMark("score")}</th>}
              {shows("monthly") && (
                <th
                  onClick={() => toggleSort("monthly")}
                  title={`What leaves your account each month: rent incl. 管理費, listed monthly extras${includeParking ? ", and parking" : ""}`}
                >
                  Monthly{sortMark("monthly")}
                </th>
              )}
              {shows("stay") && (
                <th
                  onClick={() => toggleSort("stay")}
                  title={`Cost of a ${STAY_MONTHS}-month stay: sunk move-in money + ${STAY_MONTHS} × monthly. Refundable deposit and 更新料 excluded.`}
                >
                  2-yr cost{sortMark("stay")}
                </th>
              )}
              {SCORE_PARAMETERS.map((meta) => shows(meta.key) && (
                <th key={meta.key} title={meta.description} onClick={() => toggleSort(meta.key)}>
                  {meta.label}
                  {sortMark(meta.key)}
                </th>
              ))}
              {shows("links") && <th>Links</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ listing, score }, index) => {
              const key = listingKey(listing);
              const isHover = key === hovered;
              const isSelected = key === selected;
              const sold = isSold(listing);
              const rentedOut = isRentedOut(listing);
              const fresh = isNewListing(listing);
              const mark = marks[key];
              const ruledOut = isRuledOut(mark);
              const portals = referencesFor(listing);
              const note = notes[key];
              const comparing = compare.includes(key);
              const cost = stayCosts.get(listing)!;
              return (
              <Fragment key={key + index}>
                <tr
                  ref={isSelected ? selectedRowRef : undefined}
                  className={`${styles.listing} ${isHover ? styles.hovered : ""} ${
                    isSelected ? styles.selected : ""
                  } ${sold || rentedOut ? styles.sold : ""} ${ruledOut ? styles.ruledOut : ""}`}
                  onMouseEnter={() => onHover(key)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => {
                    onSelect(key);
                    setExpanded((cur) => (cur === key ? null : key));
                  }}
                >
                  {shows("locate") && (
                    <td className={styles.locateCell}>
                      {listing.lat != null && listing.lon != null ? (
                        <button
                          type="button"
                          className={styles.locateButton}
                          title="Center local map on this property"
                          aria-label={`Center local map on ${listing.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onCenterMap(key, listing.lat!, listing.lon!);
                          }}
                        >
                          ◎
                        </button>
                      ) : (
                        <span className={styles.noLocation} title="This property has no map coordinates">—</span>
                      )}
                    </td>
                  )}
                  {shows("rank") && <td>{index + 1}</td>}
                  {shows("photo") && (
                    <td className={styles.photoCell}>
                      <ListingThumb photos={listingPhotos(listing)} name={listing.name} />
                    </td>
                  )}
                  <td className={`${styles.left} ${styles.name}`} title={listing.address}>
                    {listing.name}
                    {fresh && (
                      <span className={styles.badgeNew} title="First seen in the last 14 days">
                        NEW
                      </span>
                    )}
                    {sold && (
                      <span
                        className={styles.badgeSold}
                        title={`No longer advertised${listing.soldAt ? ` since ${listing.soldAt.slice(0, 10)}` : ""}`}
                      >
                        SOLD
                      </span>
                    )}
                    {rentedOut && (
                      <span
                        className={styles.badgeRentedOut}
                        title={`Every portal ad is gone:\n${portals.map((ad) => `${ad.source}: ${describeAvailability(ad.availability)}`).join("\n")}`}
                      >
                        RENTED OUT
                      </span>
                    )}
                    {note && (
                      <span className={styles.badgeNote} title={describeNote(note)}>
                        {note.viewingAt ? `📅 ${formatViewing(note.viewingAt)}` : "📝"}
                      </span>
                    )}
                    {portals.length > 1 && (
                      <span
                        className={styles.badgeMulti}
                        title={`Same room advertised on ${portals.length} portals: ${portals.map(({ source }) => source).join(", ")}`}
                      >
                        ×{portals.length}
                      </span>
                    )}
                    {listing.source === "manual" && (
                      <button
                        className={styles.remove}
                        title="Remove this custom listing"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(listing.name);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </td>
                  {shows("city") && (
                    <td className={styles.city}>
                      {listing.city ?? "—"}
                      <small className={styles.source}>
                        {portals.map(({ source }) => source).join(" + ")}
                      </small>
                    </td>
                  )}
                  {shows("mark") && <td className={styles.markCell} onClick={(e) => e.stopPropagation()}>
                    <select
                      className={`${styles.markSelect} ${
                        mark ? (ruledOut ? styles.markNegative : styles.markPositive) : ""
                      }`}
                      value={mark ?? ""}
                      onChange={(e) =>
                        onSetMark(key, (e.target.value || null) as ListingMark | null)
                      }
                      title="Your decision about this property"
                    >
                      <option value="">—</option>
                      {LISTING_MARKS.map((meta) => (
                        <option key={meta.key} value={meta.key}>
                          {meta.icon} {meta.label}
                        </option>
                      ))}
                    </select>
                  </td>}
                  {shows("compare") && onToggleCompare && (
                    <td className={styles.compareCell} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={comparing}
                        disabled={!comparing && compareFull}
                        aria-label={`Compare ${listing.name}`}
                        title={comparing
                          ? "Remove from the comparison"
                          : compareFull
                            ? `The comparison holds ${MAX_COMPARE} homes — remove one first`
                            : "Add to the side-by-side comparison"}
                        onChange={() => onToggleCompare(key)}
                      />
                    </td>
                  )}
                  {shows("score") && (
                    <td>
                      <span
                        className={styles.pill}
                        style={{ background: scoreColor(score.total) }}
                      >
                        {score.total != null ? score.total.toFixed(0) : "—"}
                      </span>
                    </td>
                  )}
                  {shows("monthly") && <td title={monthlyTitle(listing, cost)}>{formatMonthly(cost)}</td>}
                  {shows("stay") && (
                    <td title={stayTitle(cost)}>¥{yen.format(cost.total)}</td>
                  )}
                  {SCORE_PARAMETERS.map((meta) => shows(meta.key) && (
                    <td key={meta.key}>
                      {formatValue(score.parts.find((p) => p.key === meta.key))}
                    </td>
                  ))}
                  {shows("links") && <td className={styles.links}>
                    {portals.filter(({ url }) => Boolean(url)).map((reference, linkIndex) => {
                      const gone = reference.availability?.state === "gone";
                      const status = describeAvailability(reference.availability);
                      return (
                        <span key={`${reference.source}-${reference.url}`} className={styles.adLink}>
                          <a
                            className={[linkIndex === 0 && portals.length > 1 ? styles.primaryLink : "", gone ? styles.linkGone : ""].join(" ").trim() || undefined}
                            href={reference.url!}
                            target="_blank"
                            rel="noreferrer"
                            title={`${linkIndex === 0 && portals.length > 1 ? "Preferred portal · " : ""}${reference.source}: ${status}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {reference.source}
                          </a>
                          {onMarkAd && (
                            <button
                              type="button"
                              className={styles.adToggle}
                              title={gone
                                ? `Marked gone (${status}). Click if it is actually still listed.`
                                : `Opened it and the room is gone? Click to mark ${reference.source} as rented out.`}
                              aria-label={gone ? `Mark ${reference.source} ad as still listed` : `Mark ${reference.source} ad as gone`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onMarkAd(reference, gone ? "listed" : "gone");
                              }}
                            >
                              {gone ? "↺" : "✕"}
                            </button>
                          )}
                        </span>
                      );
                    })}
                    {listing.lat != null && listing.lon != null && (
                      <a
                        href={`https://www.google.com/maps?q=${listing.lat},${listing.lon}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        map
                      </a>
                    )}
                  </td>}
                </tr>
                {expanded === key && (
                  <tr className={styles.detail}>
                    <td colSpan={visibleColumnCount}>
                      <Breakdown
                        row={{ listing, score }}
                        moveIn={moveIn}
                        notes={onSetNote && (
                          <NoteEditor key={key} note={note} onSave={(draft) => onSetNote(key, draft)} />
                        )}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {visible.length < sorted.length && (
        <button
          type="button"
          className={styles.loadMore}
          onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
        >
          Show next {Math.min(PAGE_SIZE, sorted.length - visible.length)} · {sorted.length - visible.length} remaining
        </button>
      )}
      <p className={styles.sources}>
        Sources: listings SUUMO · geography OpenStreetMap (ODbL) · geocoding GSI Japan.
        Walk minutes are straight-line × detour factor ÷ walk speed, except the station
        time which prefers the agent-listed 徒歩分. Kindergarten column is the nearest
        幼稚園/こども園 unless daycare inclusion is enabled.
      </p>
    </section>
  );
});

/** Monthly parking charge — a recurring cost that sits outside rent. */
function ParkingLine({ listing }: { listing: ScoredRow["listing"] }) {
  const parking = parkingInfo(listing);
  const monthly = parkingMonthlyYen(listing);

  if (monthly == null) {
    return (
      <p className={styles.parking}>
        駐車場 parking: <em>{parking?.available ? "available · price not stated" : "not stated"}</em>
      </p>
    );
  }
  if (!parking?.available) {
    return <p className={styles.parking}>駐車場 parking: <strong>none available</strong></p>;
  }

  const where =
    parking.location === "nearby"
      ? `nearby${parking.distanceM ? ` (${parking.distanceM} m away)` : ""}`
      : parking.location === "onsite"
        ? "on site"
        : "";

  return (
    <p className={styles.parking}>
      駐車場 parking:{" "}
      <strong>{monthly === 0 ? "free" : `¥${yen.format(monthly)}/month`}</strong>
      {where && ` · ${where}`}
      {monthly > 0 && (
        <em>
          {" "}— ¥{yen.format(monthly * 12)}/year on top of rent
        </em>
      )}
    </p>
  );
}

/** Per-parameter bars showing exactly why a listing scored what it did. */
function Breakdown({ row, moveIn, notes }: { row: ScoredRow; moveIn: CostBasis["moveIn"]; notes?: ReactNode }) {
  return (
    <>
      <div className={styles.detailTop}>
        <PhotoGallery photos={listingPhotos(row.listing)} name={row.listing.name} className={styles.detailGallery} />
        <MoveInBreakdown row={row} moveIn={moveIn} />
      </div>
      {notes}
      <div className={styles.bars}>
      {row.score.parts.map((part) => {
        const meta = [...SCORE_PARAMETERS, ...FEATURE_PARAMETERS].find((m) => m.key === part.key)!;
        return (
          <div key={part.key} className={styles.bar}>
            <div className={styles.barLabel}>
              <span>
                {meta.label}
                {part.detail ? <em> · {part.detail}</em> : null}
              </span>
              <span>
                {formatValue(part)}
                {part.value != null && ["poi1", "poi2", "station", "busStop", "kindergarten", "school"].includes(part.key)
                  ? " min"
                  : ""}
                {part.key === "moveInCost" ? " sunk" : ""}
                {" → "}
                {part.score != null ? part.score.toFixed(0) : "—"} ×w{part.weight}
              </span>
            </div>
            <div className={styles.track}>
              <div
                className={styles.fill}
                style={{
                  width: `${part.score ?? 0}%`,
                  background: scoreColor(part.score),
                }}
              />
            </div>
          </div>
        );
      })}
      </div>
    </>
  );
}

/**
 * Where the move-in money actually goes, and how much of it you ever see
 * again. 敷金 is largely refundable; 礼金, fees and cleaning are not.
 */
function AttributeSummary({ listing }: { listing: ScoredRow["listing"] }) {
  const attributes = listing.attributes ?? [];
  if (!attributes.length) return null;
  const categories = [...new Set(attributes.map((attribute) => attribute.category))];
  return (
    <details className={styles.attributes}>
      <summary>Property details &amp; features ({attributes.length})</summary>
      {categories.map((category) => (
        <div className={styles.attributeGroup} key={category}>
          <strong>
            {ATTRIBUTE_CATEGORY_LABELS[category].en}
            <small>{ATTRIBUTE_CATEGORY_LABELS[category].ja}</small>
          </strong>
          <div>
            {attributes.filter((attribute) => attribute.category === category).map((attribute) => (
              <span
                key={attribute.key}
                className={attribute.state === false ? styles.attributeNo : undefined}
                title={attribute.raw}
              >
                {attribute.state === false ? "✕ " : attribute.state === true ? "✓ " : ""}
                {attribute.labelEn}
                <small>{attribute.labelJa}</small>
              </span>
            ))}
          </div>
        </div>
      ))}
    </details>
  );
}

function MoveInBreakdown({ row, moveIn }: { row: ScoredRow; moveIn: CostBasis["moveIn"] }) {
  const costs = computeMoveInCosts(row.listing, moveIn);
  const money = (n: number) => `¥${yen.format(n)}`;
  const items: { label: string; value: number; refundable?: boolean; estimated?: boolean }[] = [
    { label: "敷金 deposit", value: costs.deposit, refundable: true, estimated: costs.estimated.deposit },
    { label: "礼金 key money", value: costs.keyMoney, estimated: costs.estimated.keyMoney },
    { label: "仲介手数料 agency", value: costs.agencyFee, estimated: true },
    { label: "保証会社 guarantor", value: costs.guarantorFee, estimated: true },
    { label: "火災保険 insurance", value: costs.fireInsurance, estimated: true },
    { label: "清掃費 cleaning", value: costs.cleaningFee, estimated: costs.estimated.cleaningFee },
    { label: "First month rent", value: costs.firstMonthRent },
  ];

  return (
    <div className={styles.moveIn}>
      <div className={styles.moveInHead}>
        <strong>Move-in costs</strong>
        <span>
          {money(costs.totalUpfront)} upfront ·{" "}
          <span className={styles.sunk}>{money(costs.sunkCost)} never returned</span> ·{" "}
          <span className={styles.back}>{money(costs.refundable)} expected back</span>
        </span>
      </div>
      <ParkingLine listing={row.listing} />
      <AttributeSummary listing={row.listing} />
      <ul className={styles.moveInList}>
        {items.map((item) => (
          <li key={item.label} className={item.refundable ? styles.refundableItem : undefined}>
            <span>
              {item.label}
              {item.estimated && <em className={styles.est}> est.</em>}
            </span>
            <span>{money(item.value)}</span>
          </li>
        ))}
      </ul>
      <p className={styles.moveInNote}>
        敷金 is refundable minus 原状回復 (
        {Math.round(moveIn.depositLossRate * 100)}% assumed lost).
        礼金, fees and cleaning are never returned. First month’s rent is excluded
        from the sunk total — it buys a month of housing.
      </p>
    </div>
  );
}
