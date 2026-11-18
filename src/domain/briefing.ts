/**
 * The briefing: what needs a look today, worked out from what is already
 * held. A refresh adds a few hundred homes; the ranking alone does not say
 * which of them are new since the last look, which are priced under their
 * neighbours, or that a shortlisted home has gone.
 *
 * "New" is measured against the data, not the clock. The dashboard remembers
 * the newest first-seen time the user has acknowledged (`seenDataAt`); a home
 * first seen after it is unseen. A refresh that lands an hour after a visit
 * is then still new, which a "since your last visit" clock would miss. Until
 * anything has been acknowledged, the usual "new" window stands in.
 *
 * One gap remains: acknowledging in the middle of a refresh, after one portal's
 * homes are shown and before another's with earlier capture times arrive,
 * leaves those later arrivals counted as seen. They still carry the NEW badge.
 */
import { isLikelyRented, isRentedOut } from "./availability";
import { isNewListing, isSold } from "./lifecycle";
import { listingKey } from "./listingKey";
import { marketVerdict, type MarketEstimate } from "./marketRent";
import { isRuledOut, type MarkMap } from "./marks";
import { isViewingTime, type NoteMap } from "./notes";
import type { ScoredRow } from "./scoring";
import type { EnrichedListing } from "./types";

/** Why a home the user was pursuing may no longer be on offer. */
export type GoneReason = "sold" | "rented-out" | "likely-rented";

export interface GoneCandidate {
  key: string;
  listing: EnrichedListing;
  reason: GoneReason;
}

export interface UpcomingViewing {
  key: string;
  listing: EnrichedListing;
  viewingAt: string;
}

export interface Briefing {
  /** The newest first-seen time in the data: what "mark as seen" acknowledges. */
  dataAt: string | null;
  /** Matching homes first seen since the acknowledged data, undecided, best first. */
  unseen: ScoredRow[];
  /** Matching, undecided homes priced clearly under similar homes, biggest gap first. */
  deals: ScoredRow[];
  /** Every matching home with no decision yet, best first. */
  undecided: ScoredRow[];
  /** Shortlisted or applied-for homes that look taken. */
  gone: GoneCandidate[];
  /** Booked viewings from today onwards, soonest first. */
  viewings: UpcomingViewing[];
}

export interface BriefingInput {
  /** The homes the filters show, scored. */
  rows: readonly ScoredRow[];
  /** Every home held, whatever the filters: a shortlisted home can be hidden by them. */
  all: readonly EnrichedListing[];
  marks: MarkMap;
  notes: NoteMap;
  market: ReadonlyMap<string, MarketEstimate>;
  /** The data time the user last acknowledged, or null when never. */
  seenDataAt: string | null;
  /** Days a home counts as new while nothing has been acknowledged. */
  newWithinDays: number;
  now?: Date;
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const byScore = (a: ScoredRow, b: ScoredRow) => (b.score.total ?? -1) - (a.score.total ?? -1);

/** The newest first-seen time among the listings, or null when none is dated. */
export function newestFirstSeen(listings: readonly EnrichedListing[]): string | null {
  let newest: string | null = null;
  let newestAt = -Infinity;
  for (const { firstSeenAt } of listings) {
    const at = time(firstSeenAt);
    if (at > newestAt) {
      newestAt = at;
      newest = firstSeenAt!;
    }
  }
  return newest;
}

/** Still on offer as far as anyone knows. */
const onOffer = (listing: EnrichedListing) => !isSold(listing) && !isRentedOut(listing) && !isLikelyRented(listing);

/** A viewing's local date, `YYYY-MM-DD`, comparable as text. */
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function buildBriefing({
  rows, all, marks, notes, market, seenDataAt, newWithinDays, now = new Date(),
}: BriefingInput): Briefing {
  const seenAt = time(seenDataAt);
  const isUnseen = (listing: EnrichedListing) =>
    Number.isFinite(seenAt) ? time(listing.firstSeenAt) > seenAt : isNewListing(listing, now, newWithinDays);

  const undecided = rows
    .filter(({ listing }) => marks[listingKey(listing)] == null && onOffer(listing))
    .sort(byScore);
  const unseen = undecided.filter(({ listing }) => isUnseen(listing));
  const ratio = ({ listing }: ScoredRow) => market.get(listingKey(listing))!.deltaRatio;
  const deals = undecided
    .filter(({ listing }) => marketVerdict(market.get(listingKey(listing))) === "deal")
    .sort((a, b) => ratio(a) - ratio(b));

  const gone: GoneCandidate[] = [];
  const viewings: UpcomingViewing[] = [];
  const today = localDay(now);
  for (const listing of all) {
    const key = listingKey(listing);
    const mark = marks[key];
    if (mark != null && !isRuledOut(mark)) {
      const reason: GoneReason | null = isSold(listing) ? "sold" : isRentedOut(listing) ? "rented-out" : isLikelyRented(listing) ? "likely-rented" : null;
      if (reason) gone.push({ key, listing, reason });
    }
    const viewingAt = notes[key]?.viewingAt;
    if (isViewingTime(viewingAt) && viewingAt.slice(0, 10) >= today && !isRuledOut(mark)) {
      viewings.push({ key, listing, viewingAt });
    }
  }
  viewings.sort((a, b) => a.viewingAt.localeCompare(b.viewingAt));

  return { dataAt: newestFirstSeen(all), unseen, deals, undecided, gone, viewings };
}

/** True when the briefing has nothing to say. */
export function isQuietBriefing(briefing: Briefing): boolean {
  return briefing.unseen.length === 0 && briefing.deals.length === 0 && briefing.gone.length === 0 && briefing.viewings.length === 0;
}

const GONE_LABELS: Record<GoneReason, string> = {
  sold: "no longer advertised",
  "rented-out": "rented out",
  "likely-rented": "likely rented",
};

export const goneLabel = (reason: GoneReason): string => GONE_LABELS[reason];

/** The acknowledged data time as stored: an ISO string, or null for anything else. */
export function decodeSeenDataAt(raw: unknown): string | null {
  return typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? raw : null;
}
