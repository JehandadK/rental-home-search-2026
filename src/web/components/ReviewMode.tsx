/**
 * Review mode: a full-screen pass over a list of homes, one at a time, big
 * enough to judge on a phone. Each home gets a decision from one key or one
 * tap (shortlist, not interested, no foreigners) or a skip, and the next home
 * follows, so a few hundred new listings can be triaged without the wide
 * table.
 *
 * The queue is the list of keys when the overlay opens (see
 * domain/reviewQueue): marking a home usually drops it from the parent's
 * filtered rows, and the queue must not jump when it does. Each home is still
 * drawn from the live row when there is one, so a rescore shows at once.
 *
 * Only the home on screen is rendered; the next home's first photo is
 * fetched ahead so moving on feels instant.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX, type TouchEvent } from "react";
import { listingKey } from "../../domain/listingKey";
import { sourceListings } from "../../domain/listingDedup";
import { listingPhotos } from "../../domain/listingPhotos";
import { isNewListing } from "../../domain/lifecycle";
import { formatMarketDelta, marketVerdict, type MarketEstimate, type MarketVerdict } from "../../domain/marketRent";
import { markMeta, type ListingMark, type MarkMap } from "../../domain/marks";
import { stayCost, STAY_MONTHS } from "../../domain/moveInCost";
import type { NoteDraft, NoteMap } from "../../domain/notes";
import {
  currentKey,
  decideHome,
  isReviewDone,
  previousHome,
  rankedParts,
  rankReasons,
  reviewSkipped,
  reviewTally,
  skipHome,
  startReview,
  undoDecision,
  type ReviewSession,
} from "../../domain/reviewQueue";
import { scoreColor, type ScorePart, type ScoredRow } from "../../domain/scoring";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS } from "../../domain/scoringConfig";
import { isUrListing, sourceLabel } from "../../domain/ur";
import type { CostBasis } from "./ListingTable";
import { PhotoGallery } from "./ListingPhoto";
import { NoteEditor } from "./NoteEditor";
import styles from "./ReviewMode.module.css";

export interface ReviewModeProps {
  /** What is being reviewed, e.g. "New homes" — shown in the header. */
  title: string;
  /** The homes to review, best first. Snapshot the list of keys when the overlay opens: marking a home must not make the queue jump, even if the parent's rows change afterwards. Look up the live row by key for display. */
  rows: readonly ScoredRow[];
  marks: MarkMap;
  onSetMark: (key: string, mark: ListingMark | null) => void;
  notes: NoteMap;
  onSetNote: (key: string, draft: NoteDraft) => void;
  costBasis: CostBasis;
  /** Market estimates by listingKey; may be empty while still being computed. */
  market: ReadonlyMap<string, MarketEstimate>;
  newWithinDays: number;
  /** Close the overlay and centre the map on this home. */
  onLocate: (key: string, lat: number, lon: number) => void;
  onClose: () => void;
}

/** The marks review mode offers, each with its key. */
const DECISIONS: readonly { mark: ListingMark; key: string; label: string }[] = [
  { mark: "shortlisted", key: "s", label: "Shortlist" },
  { mark: "not-interested", key: "x", label: "Not interested" },
  { mark: "no-foreigners", key: "f", label: "No foreigners" },
];

const VERDICT_LABELS: Record<MarketVerdict, string> = { deal: "DEAL", fair: "FAIR", pricey: "PRICEY" };

const CRITERION_LABELS = new Map<string, string>(
  [...SCORE_PARAMETERS, ...FEATURE_PARAMETERS].map(({ key, label }) => [key, label]),
);
/** Criteria measured as travel time, shown with "min" as in the table's breakdown. */
const TRAVEL_KEYS = new Set(["poi1", "poi2", "carAuction", "shop", "station", "busStop", "kindergarten", "school"]);
/** Fields that take typed text, where letters are text and not shortcuts. */
const TEXT_FIELD = "input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]";
/** A swipe must travel this far sideways, and mostly sideways, to turn the page. */
const SWIPE_MIN_PX = 50;

const yen = new Intl.NumberFormat("ja-JP");
const money = (value: number) => `¥${yen.format(value)}`;

/** A criterion's raw value as the table shows it. */
function formatValue(part: ScorePart): string {
  if (part.value == null) return "—";
  switch (part.key) {
    case "rent":
    case "rentPerM2":
      return money(part.value);
    case "moveInCost":
      return `${part.value}mo sunk`;
    case "size":
      return `${part.value}㎡`;
    case "yearBuilt":
      return `${part.value}y`;
    default:
      if (TRAVEL_KEYS.has(part.key)) return `${part.value} min`;
      return part.value === 1 ? "Yes" : part.value === 0 ? "No" : `${part.value}`;
  }
}

const labelOf = (part: ScorePart) => CRITERION_LABELS.get(part.key) ?? part.key;

function isTextField(target: EventTarget | null): target is HTMLElement {
  return target instanceof Element && target.closest(TEXT_FIELD) != null;
}

export function ReviewMode({
  title,
  rows,
  marks,
  onSetMark,
  notes,
  onSetNote,
  costBasis,
  market,
  newWithinDays,
  onLocate,
  onClose,
}: ReviewModeProps): JSX.Element {
  const titleId = useId();
  const [session, setSession] = useState<ReviewSession>(() => startReview(rows.map(({ listing }) => listingKey(listing))));
  // Rows as they were at the start, for a home the parent has since filtered out.
  const [snapshot] = useState(() => new Map(rows.map((row) => [listingKey(row.listing), row])));
  const live = useMemo(() => new Map(rows.map((row) => [listingKey(row.listing), row])), [rows]);
  const rowOf = (key: string | null) => (key == null ? undefined : live.get(key) ?? snapshot.get(key));

  const key = currentKey(session);
  const row = rowOf(key);
  const done = isReviewDone(session);
  const total = session.keys.length;
  const tally = reviewTally(session);

  const dialog = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // A modal: the page behind stays put, and focus comes in and goes back.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);

  // Each home starts at its top, not where the last one was scrolled to.
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [session.index, session.keys]);

  // Fetch the next home's first photo while this one is being read.
  const nextRow = rowOf(session.keys[session.index + 1] ?? null);
  const nextPhoto = nextRow ? listingPhotos(nextRow.listing)[0]?.url : undefined;
  useEffect(() => {
    if (!nextPhoto || typeof Image === "undefined") return;
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.src = nextPhoto;
  }, [nextPhoto]);

  const decide = (mark: ListingMark) => {
    if (key == null) return;
    const result = decideHome(session, marks[key] ?? null, mark);
    if (!result) return;
    setSession(result.session);
    onSetMark(key, result.mark);
  };
  const next = () => setSession(skipHome);
  const back = () => setSession(previousHome);
  const undo = () => {
    const result = undoDecision(session);
    if (!result) return;
    setSession(result.session);
    onSetMark(result.step.key, result.step.previousMark);
  };
  const locate = () => {
    const listing = row?.listing;
    if (!key || listing?.lat == null || listing.lon == null) return;
    onLocate(key, listing.lat, listing.lon);
    onClose();
  };

  // Keys act on what is on screen now, without re-subscribing on every decision.
  const keyboard = useRef({ decide, next, back, undo, onClose, done });
  keyboard.current = { decide, next, back, undo, onClose, done };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const actions = keyboard.current;
      if (event.key === "Escape") {
        // Escape in the note leaves the note, so the shortcuts work again.
        if (isTextField(event.target)) event.target.blur();
        else actions.onClose();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (isTextField(event.target)) return;
      const pressed = event.key.toLowerCase();
      // Space on a focused button or link presses it.
      if (pressed === " " && event.target instanceof Element && event.target.closest("button, a")) return;
      const decision = DECISIONS.find((option) => option.key === pressed);
      if (decision) {
        if (actions.done) return;
        actions.decide(decision.mark);
      } else if (pressed === "arrowright" || pressed === "j" || pressed === " ") actions.next();
      else if (pressed === "arrowleft" || pressed === "k") actions.back();
      else if (pressed === "u") actions.undo();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    // In the capture phase, and stopping there: the review is modal, so a key
    // it handles must not also reach a panel open behind it (one Escape would
    // otherwise close the duplicates panel too).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /** Run a button's action, then hand focus back to the dialog so Space skips rather than re-pressing it. */
  const press = (action: () => void) => () => {
    action();
    dialog.current?.focus();
  };

  // A sideways swipe on the card turns the page; anything mostly vertical is a scroll.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: TouchEvent) => {
    const point = event.touches[0];
    touch.current = event.touches.length === 1 && point && !isTextField(event.target) ? { x: point.clientX, y: point.clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    const point = event.changedTouches[0];
    touch.current = null;
    if (!start || !point) return;
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;
    if (dx < 0) next();
    else back();
  };

  const position = Math.min(session.index + 1, total);
  const share = total ? (Math.min(session.index, total) / total) * 100 : 0;

  return (
    <div className={styles.backdrop}>
      <div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className={styles.head}>
          <h2 id={titleId}>{title}</h2>
          {total > 0 && (
            <>
              <span className={styles.progress} aria-label={`Home ${position} of ${total}`}>{position} / {total}</span>
              <span className={styles.tally} aria-label="This session">
                <span title="Shortlisted">★ {tally.shortlisted}</span>
                <span title="Ruled out">✕ {tally.ruledOut}</span>
                <span title="Skipped">{tally.skipped} skipped</span>
              </span>
            </>
          )}
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close review">×</button>
          <div className={styles.track} aria-hidden="true">
            <div className={styles.fill} style={{ width: `${share}%` }} />
          </div>
        </header>

        <div ref={body} className={styles.body}>
          {total === 0 ? (
            <div className={styles.state}>
              <p className={styles.stateTitle}>Nothing to review</p>
              <p>Every home here already has a decision, or none match the filters.</p>
              <button type="button" onClick={onClose}>Close</button>
            </div>
          ) : done || !key || !row ? (
            <div className={styles.state}>
              <p className={styles.stateTitle}>All done</p>
              <p>
                Reviewed {tally.reviewed} · {tally.shortlisted} shortlisted · {tally.ruledOut} ruled out · {tally.skipped} skipped
              </p>
              <div className={styles.stateActions}>
                {tally.skipped > 0 && (
                  <button type="button" className="secondary" onClick={press(() => setSession(reviewSkipped))}>
                    Review the skipped ones
                  </button>
                )}
                <button type="button" onClick={onClose}>Done</button>
              </div>
            </div>
          ) : (
            <Home
              key={key}
              homeKey={key}
              row={row}
              mark={marks[key]}
              notes={notes}
              onSetNote={onSetNote}
              costBasis={costBasis}
              estimate={market.get(key)}
              newWithinDays={newWithinDays}
              onLocate={locate}
              onTouchStart={onTouchStart}
              onTouchEnd={onTouchEnd}
            />
          )}
        </div>

        {total > 0 && !done && row && (
          <footer className={styles.actions}>
            {DECISIONS.map((option) => {
              const meta = markMeta(option.mark)!;
              const active = marks[key!] === option.mark;
              return (
                <button
                  key={option.mark}
                  type="button"
                  className={`${styles.action} ${meta.tone === "positive" ? styles.positive : styles.negative}`}
                  aria-pressed={active}
                  title={active ? `Press again to clear ${meta.label}` : meta.labelJa}
                  onClick={press(() => decide(option.mark))}
                >
                  <span aria-hidden="true">{meta.icon}</span> {option.label} <kbd>{option.key.toUpperCase()}</kbd>
                </button>
              );
            })}
            <div className={styles.nav}>
              <button type="button" className={`secondary ${styles.action}`} onClick={press(back)} disabled={session.index === 0}>
                ← Back <kbd>K</kbd>
              </button>
              <button type="button" className={`secondary ${styles.action}`} onClick={press(undo)} disabled={!session.history.length}>
                Undo <kbd>U</kbd>
              </button>
              <button type="button" className={`secondary ${styles.action}`} onClick={press(next)}>
                Skip → <kbd>J</kbd>
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

/** One home, large: photos, the facts, the score and why, links and the note. */
function Home({
  homeKey,
  row,
  mark,
  notes,
  onSetNote,
  costBasis,
  estimate,
  newWithinDays,
  onLocate,
  onTouchStart,
  onTouchEnd,
}: {
  homeKey: string;
  row: ScoredRow;
  mark: ListingMark | undefined;
  notes: NoteMap;
  onSetNote: ReviewModeProps["onSetNote"];
  costBasis: CostBasis;
  estimate: MarketEstimate | undefined;
  newWithinDays: number;
  onLocate: () => void;
  onTouchStart: (event: TouchEvent) => void;
  onTouchEnd: (event: TouchEvent) => void;
}) {
  const { listing, score } = row;
  const photos = listingPhotos(listing);
  const cost = stayCost(listing, costBasis.moveIn, costBasis.includeParking);
  const verdict = marketVerdict(estimate);
  const parts = rankedParts(score.parts);
  const { strongest, weakest } = rankReasons(score.parts);
  const meta = markMeta(mark);
  const portals = sourceListings(listing).filter((reference) => reference.url);
  const age = listing.builtYear != null ? new Date().getFullYear() - listing.builtYear : null;
  const station = [listing.advertisedStation, listing.stationWalkMin != null ? `${listing.stationWalkMin} min walk` : null]
    .filter(Boolean).join(" · ");

  const facts: [label: string, value: string, title?: string][] = [
    ["Rent", money(listing.rent), "Incl. 管理費"],
    ["Layout", listing.layout || "—"],
    ["Size", listing.sizeM2 != null ? `${listing.sizeM2}㎡` : "—"],
    ["Built", listing.builtYear != null ? `${listing.builtYear} · ${age} yrs` : "—"],
    ["Station", station || "—"],
    ["Monthly", `${money(cost.monthly)}${cost.parkingUnknown ? "*" : ""}`,
      cost.parkingUnknown ? "Parking price not stated, so not included" : "Rent, monthly extras and any parking"],
    [`${STAY_MONTHS / 12}-yr cost`, money(cost.total), `${money(cost.sunk)} sunk move-in + ${cost.months} × ${money(cost.monthly)}`],
  ];

  return (
    <article className={styles.card} aria-label={listing.name} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className={styles.media}>
        {photos.length ? (
          <PhotoGallery photos={photos} name={listing.name} className={styles.gallery} />
        ) : (
          <div className={styles.noPhoto}>No photos for this home</div>
        )}
      </div>

      <div className={styles.info}>
        <div>
          <h3 className={styles.name}>{listing.name}</h3>
          <p className={styles.address}>{[listing.address, listing.city].filter(Boolean).join(" · ")}</p>
          <div className={styles.badges}>
            {isNewListing(listing, new Date(), newWithinDays) && (
              <span className={styles.badgeNew} title={`First seen in the last ${newWithinDays} day${newWithinDays === 1 ? "" : "s"}`}>NEW</span>
            )}
            {isUrListing(listing) && <span className={styles.badgeUr} title="UR賃貸: no key money, agency fee, guarantor or renewal fee">UR</span>}
            {verdict && estimate && (
              <span
                className={verdict === "deal" ? styles.verdictDeal : verdict === "pricey" ? styles.verdictPricey : styles.verdictFair}
                title={`Estimated from ${estimate.comparables.length ? "nearby similar homes" : "similar homes"}; ${estimate.confidence} confidence`}
              >
                {VERDICT_LABELS[verdict]} {formatMarketDelta(estimate.deltaRatio)} · similar homes ask ~{money(estimate.expectedRent)}
              </span>
            )}
            {meta && (
              <span className={meta.tone === "positive" ? styles.markPositive : styles.markNegative}>
                {meta.icon} {meta.label} <small>{meta.labelJa}</small>
              </span>
            )}
          </div>
        </div>

        <dl className={styles.facts}>
          {facts.map(([label, value, hint]) => (
            <div key={label} title={hint}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        <section className={styles.score} aria-label="Score">
          <span className={styles.total} style={{ color: scoreColor(score.total) }}>
            {score.total != null ? score.total.toFixed(0) : "—"}
          </span>
          {(strongest.length > 0 || weakest.length > 0) && (
            <p className={styles.why}>
              <strong>Why it ranks here:</strong>
              {strongest.length > 0 && <> strong on {strongest.map(labelOf).join(" and ")}</>}
              {strongest.length > 0 && weakest.length > 0 && ";"}
              {weakest.length > 0 && <> held back by {weakest.map(labelOf).join(" and ")}</>}.
            </p>
          )}
        </section>

        {parts.length > 0 && (
          <div className={styles.bars}>
            {parts.map((part) => (
              <div key={part.key} className={styles.bar}>
                <div className={styles.barLabel}>
                  <span>
                    {labelOf(part)}
                    {part.detail && <em> · {part.detail}</em>}
                  </span>
                  <span>{formatValue(part)} → {part.score.toFixed(0)} ×w{part.weight}</span>
                </div>
                <div className={styles.barTrack}>
                  <div className={styles.barFill} style={{ width: `${part.score}%`, background: scoreColor(part.score) }} />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className={styles.links}>
          {portals.map((reference) => (
            <a key={`${reference.source}-${reference.url}`} href={reference.url!} target="_blank" rel="noreferrer">
              {sourceLabel(reference.source)} ↗
            </a>
          ))}
          {listing.lat != null && listing.lon != null && (
            <button type="button" className="secondary" onClick={onLocate}>Show on map</button>
          )}
        </div>

        <NoteEditor note={notes[homeKey]} onSave={(draft) => onSetNote(homeKey, draft)} />
      </div>
    </article>
  );
}
