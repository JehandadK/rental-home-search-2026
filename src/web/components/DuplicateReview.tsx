/**
 * A side panel of listings that may be the same home on two portals (or twice
 * on one). The automatic matcher keeps these apart because some fact
 * disagrees a little; here a person compares them and answers "same home" or
 * "different". A "same" answer shows the listings as one from then on.
 *
 * Listings are reviewed as cases: every listing in a case may be the same
 * home as every other, so three ads of one room are one question, not three.
 * Facts sit in rows across the listings with the differing rows marked. The
 * surest cases can be answered together, and S / D / ↑ / ↓ work from the
 * keyboard.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  decisionKey,
  groupIntoCases,
  isPendingPair,
  listingAdKeys,
  pairId,
  type DuplicateDecision,
  type DuplicateVerdict,
  type PossibleDuplicate,
  type ResolvedDecisions,
} from "../../domain/possibleDuplicates";
import { comparableArea, sourceListings } from "../../domain/listingDedup";
import { listingKey } from "../../domain/listingKey";
import { listingPhotos } from "../../domain/listingPhotos";
import { sourceLabel } from "../../domain/ur";
import type { EnrichedListing } from "../../domain/types";
import type { DuplicateAnswer } from "../hooks/useDuplicateDecisions";
import { ListingThumb } from "./ListingPhoto";
import styles from "./DuplicateReview.module.css";

/** Cases at or above this score are labelled "likely same". */
export const LIKELY_SAME_SCORE = 0.85;
const PAGE = 25;

type Tab = "review" | DuplicateVerdict;

interface Props {
  /** Candidate pairs, best first; null while they are still being found. */
  pairs: readonly PossibleDuplicate[] | null;
  /** Every listing by key, before "same" decisions merge any of them. */
  listingsByKey: ReadonlyMap<string, EnrichedListing>;
  decisions: Readonly<Record<string, DuplicateDecision>>;
  /** Each answer's listings today, the confirmed groups, and answers a "Different" blocks. */
  resolved: ResolvedDecisions;
  /** Keys of the listings the current filters show. */
  visibleKeys: ReadonlySet<string>;
  /** Record answers, each about two listings given by their ad keys. */
  onDecide: (answers: DuplicateAnswer[]) => void;
  /** Forget answers by decision key. */
  onUndo: (keys: string[]) => void;
  onLocate: (key: string, lat: number, lon: number) => void;
  onClose: () => void;
}

interface Row {
  id: string;
  /** The listings compared; undefined where an answered side is no longer listed. */
  listings: (EnrichedListing | undefined)[];
  score?: number;
  reasons: string[];
  decision?: DuplicateDecision;
  /** A "same" answer not applied: a "Different" answer separates the two homes. */
  conflict?: boolean;
  city: string | null;
}

const yen = new Intl.NumberFormat("ja-JP");
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const text = (value: string | null | undefined) => (value ?? "").normalize("NFKC").replace(/\s/g, "").toLowerCase();
const seen = (listing: EnrichedListing) => {
  const [first, last] = [listing.firstSeenAt, listing.lastSeenAt].map((at) => (at ? day.format(new Date(at)) : null));
  return first && last && first !== last ? `${first} – ${last}` : first ?? last ?? "—";
};

/** The facts compared, each with what is shown and what must match for the row to agree. */
const FACTS: { label: string; show: (listing: EnrichedListing) => string; same: (listing: EnrichedListing) => unknown }[] = [
  { label: "Rent", show: (l) => `¥${yen.format(l.rent)}`, same: (l) => l.rent },
  { label: "Area", show: (l) => (l.sizeM2 != null ? `${l.sizeM2}㎡` : "—"), same: (l) => l.sizeM2 },
  { label: "Layout", show: (l) => l.layout || "—", same: (l) => text(l.layout) },
  { label: "Floor", show: (l) => l.building?.floor || "—", same: (l) => text(l.building?.floor) },
  { label: "Built", show: (l) => (l.builtYear != null ? String(l.builtYear) : "—"), same: (l) => l.builtYear },
  {
    label: "Station",
    show: (l) => [l.advertisedStation, l.stationWalkMin != null ? `${l.stationWalkMin} min` : null].filter(Boolean).join(" · ") || "—",
    // RoomSpot prints the line before the station (武蔵野線東川口駅); the station is what is compared.
    same: (l) => (l.advertisedStation ? `${text(l.advertisedStation).replace(/^.*(?:線|ライン|各停|快速)/, "")}|${l.stationWalkMin ?? ""}` : ""),
  },
  // Portals stop at the 丁目 or print the lot; only a different 丁目 is a difference.
  { label: "Address", show: (l) => l.address || "—", same: (l) => comparableArea(l.address) },
  { label: "Seen", show: seen, same: () => "" },
];

/** Fields that take typed text. A checkbox does not: S and D still answer after one is ticked. */
const TEXT_FIELD = "input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]";

/** True when the key was pressed in this panel, or with nothing in particular focused. */
function isForPanel(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target === document.body || target === document.documentElement) return true;
  return target.closest("[data-duplicate-review]") != null && target.closest(TEXT_FIELD) == null;
}

export const DuplicateReview = memo(function DuplicateReview({
  pairs,
  listingsByKey,
  decisions,
  resolved,
  visibleKeys,
  onDecide,
  onUndo,
  onLocate,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("review");
  const [city, setCity] = useState<string | null>(null);
  const [likelyOnly, setLikelyOnly] = useState(false);
  const [matchingOnly, setMatchingOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  /** The case the keyboard acts on. */
  const [active, setActive] = useState(0);
  /** Listings set aside in a case of three or more, by case id. */
  const [excluded, setExcluded] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  /** The decisions the last bulk answer recorded, so it can be taken back at once. */
  const [lastBulk, setLastBulk] = useState<string[]>([]);

  useEffect(() => {
    setLimit(PAGE);
    setActive(0);
    setConfirmingBulk(false);
  }, [tab, city, likelyOnly, matchingOnly]);

  /** Cases nobody has answered yet, and that other answers have not already made one home. */
  const pending: Row[] = useMemo(() => {
    const open = (pairs ?? []).filter((pair) =>
      pair.keys.every((key) => listingsByKey.has(key)) && isPendingPair(pair, resolved));
    return groupIntoCases(open).map((item) => {
      const listings = item.keys.map((key) => listingsByKey.get(key));
      return { id: item.id, listings, score: item.score, reasons: item.reasons, city: listings[0]?.city ?? null };
    });
  }, [pairs, listingsByKey, resolved]);

  /** Answered pairs, newest first, each side as the listing that holds its ads today. */
  const answered: Row[] = useMemo(() => {
    const pairOf = new Map((pairs ?? []).map((pair) => [pairId(...pair.keys), pair]));
    return Object.entries(decisions)
      .sort(([, x], [, y]) => y.decidedAt.localeCompare(x.decidedAt))
      .map(([id, decision]) => {
        const [leftKey, rightKey] = resolved.sides.get(id) ?? [];
        const left = leftKey ? listingsByKey.get(leftKey) : undefined;
        const right = rightKey ? listingsByKey.get(rightKey) : undefined;
        const pair = leftKey && rightKey ? pairOf.get(pairId(leftKey, rightKey)) : undefined;
        return {
          id, listings: [left, right], decision, conflict: resolved.conflicts.has(id),
          score: pair?.score, reasons: pair?.reasons ?? [], city: left?.city ?? right?.city ?? null,
        };
      });
  }, [decisions, resolved, listingsByKey, pairs]);

  const counts = {
    review: pending.length,
    same: answered.filter((row) => row.decision?.verdict === "same").length,
    different: answered.filter((row) => row.decision?.verdict === "different").length,
  };
  const source = tab === "review" ? pending : answered.filter((row) => row.decision?.verdict === tab);
  const cities = [...new Set(source.map((row) => row.city).filter((c): c is string => Boolean(c)))].sort();
  const rows = source.filter((row) =>
    (city == null || !cities.includes(city) || row.city === city)
    && (!likelyOnly || (row.score ?? 0) >= LIKELY_SAME_SCORE)
    && (!matchingOnly || row.listings.some((listing) => listing && visibleKeys.has(listingKey(listing)))));
  // A case with a listing unticked is being answered by hand; the bulk answer leaves it alone.
  const likely = tab === "review"
    ? rows.filter((row) => (row.score ?? 0) >= LIKELY_SAME_SCORE && !excluded[row.id]?.length)
    : [];
  const current = Math.max(0, Math.min(active, Math.min(rows.length, limit) - 1));

  /** Answers for a case: the listings kept are one home; each one set aside is a different home. */
  const answersFor = (row: Row, verdict: DuplicateVerdict): DuplicateAnswer[] => {
    const all = row.listings.filter((listing): listing is EnrichedListing => listing != null);
    const out = new Set(excluded[row.id] ?? []);
    const kept = all.filter((listing) => !out.has(listingKey(listing)));
    const ads = (listing: EnrichedListing) => listingAdKeys(listing);
    const answers: DuplicateAnswer[] = [];
    if (verdict === "same") {
      for (const other of kept.slice(1)) answers.push({ a: ads(kept[0]), b: ads(other), verdict: "same" });
      for (const aside of all.filter((listing) => out.has(listingKey(listing)))) {
        for (const keep of kept) answers.push({ a: ads(keep), b: ads(aside), verdict: "different" });
      }
    } else {
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) answers.push({ a: ads(all[i]), b: ads(all[j]), verdict: "different" });
      }
    }
    return answers;
  };
  const keptCount = (row: Row) => row.listings.filter((listing) => listing && !(excluded[row.id] ?? []).includes(listingKey(listing))).length;

  const decide = (row: Row, verdict: DuplicateVerdict) => {
    if (verdict === "same" && keptCount(row) < 2) return;
    setLastBulk([]);
    onDecide(answersFor(row, verdict));
  };
  const decideLikely = () => {
    const answers = likely.flatMap((row) => answersFor(row, "same"));
    setLastBulk(answers.map(({ a, b }) => decisionKey(a, b)));
    setConfirmingBulk(false);
    onDecide(answers);
  };
  const toggleExcluded = (row: Row, key: string) => setExcluded((all) => {
    const now = all[row.id] ?? [];
    return { ...all, [row.id]: now.includes(key) ? now.filter((k) => k !== key) : [...now, key] };
  });

  // Keys act on what is on screen now, without re-subscribing on every answer.
  const keyboard = useRef({ rows, current, tab, decide, onClose });
  keyboard.current = { rows, current, tab, decide, onClose };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const { rows: shown, current: index, tab: onTab, decide: answer, onClose: close } = keyboard.current;
      if (event.key === "Escape") {
        // Escape inside another panel's field belongs to that field.
        const typing = (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
        if (!typing || typing.closest("[data-duplicate-review]")) close();
        return;
      }
      if (!isForPanel(event)) return;
      const key = event.key.toLowerCase();
      if (key === "arrowdown" || key === "j") setActive(Math.max(0, Math.min(index + 1, shown.length - 1)));
      else if (key === "arrowup" || key === "k") setActive(Math.max(index - 1, 0));
      else if (onTab === "review" && shown[index] && (key === "s" || key === "d")) answer(shown[index], key === "s" ? "same" : "different");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeCard = useRef<HTMLElement | null>(null);
  useEffect(() => {
    activeCard.current?.scrollIntoView?.({ block: "nearest" });
  }, [current, tab]);

  return (
    <aside className={styles.panel} role="dialog" aria-modal="false" aria-label="Possible duplicates" data-duplicate-review>
      <header className={styles.head}>
        <h2>Possible duplicates</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close possible duplicates">×</button>
      </header>
      <p className={styles.intro}>
        Listings that look like the same home but differ in some detail, so they were not merged
        automatically. Answers stay in this browser; “Same home” shows the listings as one.
        Keys: <kbd>S</kbd> same, <kbd>D</kbd> different, <kbd>↑</kbd> <kbd>↓</kbd> to move.
      </p>
      <div className={styles.tabs} role="tablist">
        {(["review", "same", "different"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? styles.tabActive : styles.tab}
            onClick={() => setTab(key)}
          >
            {key === "review" ? "To review" : key === "same" ? "Same home" : "Different"} <span>{counts[key]}</span>
          </button>
        ))}
      </div>
      <div className={styles.controls}>
        <div className={styles.chips}>
          <button type="button" className={city == null || !cities.includes(city) ? styles.chipActive : styles.chip} onClick={() => setCity(null)}>All cities</button>
          {cities.map((name) => (
            <button key={name} type="button" className={city === name ? styles.chipActive : styles.chip} onClick={() => setCity(name)}>{name}</button>
          ))}
        </div>
        <label><input type="checkbox" checked={likelyOnly} onChange={(e) => setLikelyOnly(e.target.checked)} /> Likely same only</label>
        <label><input type="checkbox" checked={matchingOnly} onChange={(e) => setMatchingOnly(e.target.checked)} /> Matching my filters</label>
        {(likely.length > 0 || lastBulk.length > 0) && (
          <div className={styles.bulk}>
            {lastBulk.length > 0 ? (
              <>
                <span>Marked {lastBulk.length} {lastBulk.length === 1 ? "pair" : "pairs"} as the same home.</span>
                <button type="button" className="secondary" onClick={() => { onUndo(lastBulk); setLastBulk([]); }}>Undo</button>
              </>
            ) : confirmingBulk ? (
              <>
                <span>Show {likely.length} likely {likely.length === 1 ? "case" : "cases"} as one home each?</span>
                <button type="button" onClick={decideLikely}>Yes, same home</button>
                <button type="button" className="secondary" onClick={() => setConfirmingBulk(false)}>Cancel</button>
              </>
            ) : (
              <>
                <span>{likely.length} of these {likely.length === 1 ? "is" : "are"} likely the same home.</span>
                <button type="button" className="secondary" onClick={() => setConfirmingBulk(true)}>Mark all {likely.length} same</button>
              </>
            )}
          </div>
        )}
      </div>

      <div className={styles.list}>
        {pairs == null && <p className={styles.empty}>Looking for possible duplicates…</p>}
        {pairs != null && rows.length === 0 && (
          <p className={styles.empty}>{tab === "review" ? "Nothing left to review here." : "No answers here yet."}</p>
        )}
        {rows.slice(0, limit).map((row, index) => {
          const isActive = index === current;
          const several = !row.decision && row.listings.length > 2;
          return (
            <article
              key={row.id}
              ref={isActive ? activeCard : undefined}
              className={isActive ? styles.pairActive : styles.pair}
              aria-current={isActive || undefined}
              onClick={() => setActive(index)}
            >
              <div className={styles.pairHead}>
                {row.score != null && (
                  <span className={row.score >= LIKELY_SAME_SCORE ? styles.likely : styles.maybe}>
                    {row.score >= LIKELY_SAME_SCORE ? "Likely same" : "Maybe"} · {Math.round(row.score * 100)}%
                  </span>
                )}
                {row.reasons.map((reason) => <span key={reason} className={styles.reason}>{reason}</span>)}
              </div>
              <Comparison
                listings={row.listings}
                excluded={several ? excluded[row.id] ?? [] : undefined}
                onToggle={(key) => toggleExcluded(row, key)}
                onLocate={onLocate}
              />
              <div className={styles.actions}>
                {row.decision ? (
                  <>
                    <span className={styles.answered}>
                      Marked {row.decision.verdict === "same" ? "same home" : "different"} · {row.decision.decidedAt.slice(0, 10)}
                      {row.conflict && (
                        <strong className={styles.conflict}> · not applied: a “Different” answer separates these homes</strong>
                      )}
                    </span>
                    <button type="button" className="secondary" onClick={() => onUndo([row.id])}>Undo</button>
                  </>
                ) : (
                  <>
                    {several && <span className={styles.answered}>Untick a listing that is a different home.</span>}
                    <button type="button" className="secondary" onClick={() => decide(row, "different")}>
                      {several ? "All different" : "Different"}
                    </button>
                    <button type="button" disabled={keptCount(row) < 2} onClick={() => decide(row, "same")}>
                      {several && keptCount(row) < row.listings.length ? `Same home (${keptCount(row)})` : "Same home"}
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
        {rows.length > limit && (
          <button type="button" className={`secondary ${styles.more}`} onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}
          </button>
        )}
      </div>
    </aside>
  );
});

/** The listings side by side: one column each, one row per fact, differing rows marked. */
function Comparison({ listings, excluded, onToggle, onLocate }: {
  listings: (EnrichedListing | undefined)[];
  /** Keys set aside, when the case lets listings be set aside. */
  excluded?: readonly string[];
  onToggle: (key: string) => void;
  onLocate: Props["onLocate"];
}) {
  const present = listings.filter((listing): listing is EnrichedListing => listing != null);
  const columns = { gridTemplateColumns: `52px repeat(${listings.length}, minmax(0, 1fr))` };
  return (
    <div className={styles.compare} style={columns}>
      <span />
      {listings.map((listing, index) => {
        if (!listing) return <p key={index} className={styles.empty}>No longer listed.</p>;
        const key = listingKey(listing);
        return (
          <div key={key} className={excluded?.includes(key) ? styles.asideColumn : styles.column}>
            <ListingThumb photos={listingPhotos(listing)} name={listing.name} className={styles.thumb} />
            {excluded && (
              <label className={styles.keep}>
                <input type="checkbox" checked={!excluded.includes(key)} onChange={() => onToggle(key)} /> Same home
              </label>
            )}
            {listing.lat != null && listing.lon != null ? (
              <button type="button" className={styles.name} title="Show on the map" onClick={() => onLocate(key, listing.lat!, listing.lon!)}>
                {listing.name}
              </button>
            ) : (
              <span className={styles.name}>{listing.name}</span>
            )}
          </div>
        );
      })}
      {FACTS.map((fact) => {
        // A fact one portal leaves out ("—") is missing, not different.
        const stated = present.map((listing) => String(fact.same(listing) ?? "")).filter((value) => value !== "" && value !== "-");
        const differs = new Set(stated).size > 1;
        return (
          <div key={fact.label} className={differs ? styles.factDiffers : styles.fact} style={{ gridColumn: "1 / -1", ...columns }}>
            <span className={styles.label}>{fact.label}</span>
            {listings.map((listing, index) => (
              <div key={index} className={differs ? styles.differs : undefined}>{listing ? fact.show(listing) : ""}</div>
            ))}
          </div>
        );
      })}
      <span />
      {listings.map((listing, index) => (
        <div key={index} className={styles.links}>
          {listing && sourceListings(listing).filter((reference) => reference.url).map((reference) => (
            <a key={`${reference.source}-${reference.url}`} href={reference.url!} target="_blank" rel="noreferrer">
              {sourceLabel(reference.source)} ↗
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}
