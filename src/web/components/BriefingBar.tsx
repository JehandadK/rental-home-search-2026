/**
 * The briefing strip above the map: what is new since the data last
 * acknowledged, which homes are priced under their neighbours, shortlisted
 * homes that look taken, and the viewings ahead. Each count opens the review
 * of exactly those homes, so a refresh is one click from being dealt with.
 */
import { memo } from "react";
import { goneLabel, isQuietBriefing, type Briefing } from "../../domain/briefing";
import { formatMarketDelta, type MarketEstimate } from "../../domain/marketRent";
import { listingKey } from "../../domain/listingKey";
import type { ListingMark } from "../../domain/marks";
import { formatViewing } from "../../domain/notes";
import type { ScoredRow } from "../../domain/scoring";
import type { EnrichedListing } from "../../domain/types";
import appStyles from "../App.module.css";
import styles from "./BriefingBar.module.css";

interface Props {
  briefing: Briefing;
  /** The data time last acknowledged; null when never. */
  seenDataAt: string | null;
  /** Days a home counts as new while nothing has been acknowledged. */
  newWithinDays: number;
  market: ReadonlyMap<string, MarketEstimate>;
  /** Open the one-at-a-time review of these homes. */
  onReview: (title: string, rows: ScoredRow[]) => void;
  /** Acknowledge the data held now: nothing in it counts as new afterwards. */
  onMarkSeen: () => void;
  /** Show one home: select it and, where it has coordinates, centre the map on it. */
  onShow: (listing: EnrichedListing) => void;
  onSetMark: (key: string, mark: ListingMark | null) => void;
}

const yen = new Intl.NumberFormat("ja-JP");
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const plural = (count: number, word: string) => `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`;

/** How many of the best unseen homes are named in the strip. */
const PICKS = 3;

export const BriefingBar = memo(function BriefingBar({
  briefing, seenDataAt, newWithinDays, market, onReview, onMarkSeen, onShow, onSetMark,
}: Props) {
  const { unseen, deals, undecided, gone, viewings } = briefing;
  const since = seenDataAt ? `since ${day.format(new Date(seenDataAt))}` : `in the last ${plural(newWithinDays, "day")}`;
  const quiet = isQuietBriefing(briefing);

  return (
    <section className={`${appStyles.card} ${styles.briefing}`} aria-label="Briefing">
      <h2 className={appStyles.cardTitle}>Today</h2>
      <div className={styles.tiles}>
        <div className={`${styles.tile} ${unseen.length ? styles.tileNew : ""}`}>
          <strong>{unseen.length ? plural(unseen.length, "new home") : "Nothing new"}</strong>
          <span>{unseen.length ? `match your filters ${since}` : `${since} · you are up to date`}</span>
          {unseen.length > 0 && (
            <div className={styles.actions}>
              <button type="button" onClick={() => onReview(`New ${since}`, unseen)}>Review them</button>
              <button type="button" className="secondary" onClick={onMarkSeen} title="Stop counting these as new. Your decisions are kept.">
                Mark all seen
              </button>
            </div>
          )}
        </div>

        <div className={`${styles.tile} ${deals.length ? styles.tileDeal : ""}`}>
          <strong>{market.size === 0 ? "Pricing homes…" : deals.length ? plural(deals.length, "deal") : "No deals"}</strong>
          <span>undecided homes asking 15%+ less than similar homes nearby</span>
          {deals.length > 0 && (
            <div className={styles.actions}>
              <button type="button" onClick={() => onReview("Deals: priced under similar homes", deals)}>Review deals</button>
            </div>
          )}
        </div>

        <div className={styles.tile}>
          <strong>{plural(undecided.length, "undecided home")}</strong>
          <span>match your filters with no decision yet, best first</span>
          {undecided.length > 0 && (
            <div className={styles.actions}>
              <button type="button" className="secondary" onClick={() => onReview("Undecided homes, best first", undecided)}>
                Review one by one
              </button>
            </div>
          )}
        </div>
      </div>

      {unseen.length > 0 && (
        <p className={styles.line}>
          <span className={styles.lineLabel}>Best of the new</span>
          {unseen.slice(0, PICKS).map(({ listing, score }) => {
            const estimate = market.get(listingKey(listing));
            return (
              <button key={listingKey(listing)} type="button" className={styles.pick} onClick={() => onShow(listing)} title={listing.address}>
                <b>{score.total != null ? score.total.toFixed(0) : "—"}</b> {listing.name} · ¥{yen.format(listing.rent)}
                {listing.layout ? ` · ${listing.layout}` : ""}
                {estimate && estimate.confidence !== "low" ? ` · ${formatMarketDelta(estimate.deltaRatio)} vs market` : ""}
              </button>
            );
          })}
        </p>
      )}

      {gone.length > 0 && (
        <p className={`${styles.line} ${styles.warning}`}>
          <span className={styles.lineLabel}>⚠ {plural(gone.length, "home")} you were pursuing may be taken</span>
          {gone.map(({ key, listing, reason }) => (
            <span key={key} className={styles.goneItem}>
              <button type="button" className={styles.pick} onClick={() => onShow(listing)} title={listing.address}>
                {listing.name} · {goneLabel(reason)}
              </button>
              <button type="button" className={styles.inlineAction} onClick={() => onSetMark(key, "taken")} title="Record it as already taken, so it leaves your shortlist">
                mark taken
              </button>
            </span>
          ))}
        </p>
      )}

      {viewings.length > 0 && (
        <p className={styles.line}>
          <span className={styles.lineLabel}>📅 Viewings</span>
          {viewings.map(({ key, listing, viewingAt }) => (
            <button key={key} type="button" className={styles.pick} onClick={() => onShow(listing)} title={listing.address}>
              <b>{formatViewing(viewingAt)}</b> {listing.name}
            </button>
          ))}
        </p>
      )}

      {quiet && undecided.length === 0 && (
        <p className={styles.line}>Every matching home has a decision. Widen the filters to see more.</p>
      )}
    </section>
  );
});
