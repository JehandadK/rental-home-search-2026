/**
 * A side panel of listing pairs that may be the same home on two portals (or
 * twice on one). The automatic matcher keeps these apart because some fact
 * disagrees a little; here a person compares them and answers "same home" or
 * "different". A "same" answer shows the pair as one listing from then on.
 */
import { memo, useEffect, useMemo, useState } from "react";
import {
  isPendingPair,
  listingAdKeys,
  pairId,
  type DuplicateDecision,
  type DuplicateVerdict,
  type PossibleDuplicate,
  type ResolvedDecisions,
} from "../../domain/possibleDuplicates";
import { sourceListings } from "../../domain/listingDedup";
import { listingKey } from "../../domain/listingKey";
import { listingPhotos } from "../../domain/listingPhotos";
import { sourceLabel } from "../../domain/ur";
import type { EnrichedListing } from "../../domain/types";
import { ListingThumb } from "./ListingPhoto";
import styles from "./DuplicateReview.module.css";

/** Pairs at or above this score are labelled "likely same". */
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
  onDecide: (a: string[], b: string[], verdict: DuplicateVerdict) => void;
  onUndo: (key: string) => void;
  onLocate: (key: string, lat: number, lon: number) => void;
  onClose: () => void;
}

interface Row {
  id: string;
  left?: EnrichedListing;
  right?: EnrichedListing;
  score?: number;
  reasons: string[];
  decision?: DuplicateDecision;
  decisionId?: string;
  /** A "same" answer not applied: a "Different" answer separates the two homes. */
  conflict?: boolean;
  city: string | null;
}

const yen = new Intl.NumberFormat("ja-JP");

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape inside another panel's field belongs to that field.
      const target = event.target as HTMLElement | null;
      const typing = target?.closest?.("input, textarea, select, [contenteditable]");
      if (typing && !typing.closest("[data-duplicate-review]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => setLimit(PAGE), [tab, city, likelyOnly, matchingOnly, pairs]);

  /** Pairs nobody has answered yet, and that other answers have not already made one home. */
  const pending: Row[] = useMemo(() => (pairs ?? []).flatMap((pair) => {
    const [left, right] = pair.keys.map((key) => listingsByKey.get(key));
    if (!left || !right || !isPendingPair(pair, resolved)) return [];
    return [{ id: pairId(...pair.keys), left, right, score: pair.score, reasons: pair.reasons, city: left.city ?? null }];
  }), [pairs, listingsByKey, resolved]);

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
          id, left, right, decision, decisionId: id, conflict: resolved.conflicts.has(id),
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
    && (!matchingOnly || [row.left, row.right].some((listing) => listing && visibleKeys.has(listingKey(listing)))));

  const decide = (row: Row, verdict: DuplicateVerdict) => {
    if (!row.left || !row.right) return;
    onDecide(listingAdKeys(row.left), listingAdKeys(row.right), verdict);
  };

  return (
    <aside className={styles.panel} role="dialog" aria-modal="false" aria-label="Possible duplicates" data-duplicate-review>
      <header className={styles.head}>
        <h2>Possible duplicates</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close possible duplicates">×</button>
      </header>
      <p className={styles.intro}>
        Listings that look like the same home but differ in some detail, so they were not merged
        automatically. Answers stay in this browser; “Same home” shows the pair as one listing.
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
      </div>

      <div className={styles.list}>
        {pairs == null && <p className={styles.empty}>Looking for possible duplicates…</p>}
        {pairs != null && rows.length === 0 && (
          <p className={styles.empty}>{tab === "review" ? "Nothing left to review here." : "No answers here yet."}</p>
        )}
        {rows.slice(0, limit).map((row) => (
          <article key={row.id} className={styles.pair}>
            <div className={styles.pairHead}>
              {row.score != null && (
                <span className={row.score >= LIKELY_SAME_SCORE ? styles.likely : styles.maybe}>
                  {row.score >= LIKELY_SAME_SCORE ? "Likely same" : "Maybe"} · {Math.round(row.score * 100)}%
                </span>
              )}
              {row.reasons.map((reason) => <span key={reason} className={styles.reason}>{reason}</span>)}
            </div>
            <div className={styles.sides}>
              <Side listing={row.left} other={row.right} onLocate={onLocate} />
              <Side listing={row.right} other={row.left} onLocate={onLocate} />
            </div>
            <div className={styles.actions}>
              {row.decision ? (
                <>
                  <span className={styles.answered}>
                    Marked {row.decision.verdict === "same" ? "same home" : "different"} · {row.decision.decidedAt.slice(0, 10)}
                    {row.conflict && (
                      <strong className={styles.conflict}> · not applied: a “Different” answer separates these homes</strong>
                    )}
                  </span>
                  <button type="button" className="secondary" onClick={() => onUndo(row.decisionId!)}>Undo</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => decide(row, "same")}>Same home</button>
                  <button type="button" className="secondary" onClick={() => decide(row, "different")}>Different</button>
                </>
              )}
            </div>
          </article>
        ))}
        {rows.length > limit && (
          <button type="button" className={`secondary ${styles.more}`} onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}
          </button>
        )}
      </div>
    </aside>
  );
});

function Side({ listing, other, onLocate }: {
  listing?: EnrichedListing;
  other?: EnrichedListing;
  onLocate: Props["onLocate"];
}) {
  if (!listing) return <div className={styles.side}><p className={styles.empty}>No longer listed.</p></div>;
  const differs = (a: unknown, b: unknown) => other != null && String(a ?? "") !== String(b ?? "");
  const facts: { label: string; value: string; differs: boolean }[] = [
    { label: "Rent", value: `¥${yen.format(listing.rent)}`, differs: differs(listing.rent, other?.rent) },
    { label: "Area", value: listing.sizeM2 != null ? `${listing.sizeM2}㎡` : "—", differs: differs(listing.sizeM2, other?.sizeM2) },
    { label: "Layout", value: listing.layout || "—", differs: differs(listing.layout, other?.layout) },
    { label: "Floor", value: listing.building?.floor || "—", differs: differs(listing.building?.floor, other?.building?.floor) },
    { label: "Built", value: listing.builtYear != null ? String(listing.builtYear) : "—", differs: differs(listing.builtYear, other?.builtYear) },
    {
      label: "Station",
      value: [listing.advertisedStation, listing.stationWalkMin != null ? `${listing.stationWalkMin} min` : null].filter(Boolean).join(" · ") || "—",
      differs: differs(listing.advertisedStation, other?.advertisedStation) || differs(listing.stationWalkMin, other?.stationWalkMin),
    },
    { label: "Address", value: listing.address || "—", differs: differs(listing.address, other?.address) },
  ];
  const key = listingKey(listing);
  return (
    <div className={styles.side}>
      <ListingThumb photos={listingPhotos(listing)} name={listing.name} className={styles.thumb} />
      {listing.lat != null && listing.lon != null ? (
        <button type="button" className={styles.name} title="Show on the map" onClick={() => onLocate(key, listing.lat!, listing.lon!)}>
          {listing.name}
        </button>
      ) : (
        <span className={styles.name}>{listing.name}</span>
      )}
      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div key={fact.label} className={fact.differs ? styles.differs : undefined}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.links}>
        {sourceListings(listing).filter((reference) => reference.url).map((reference) => (
          <a key={`${reference.source}-${reference.url}`} href={reference.url!} target="_blank" rel="noreferrer">
            {sourceLabel(reference.source)} ↗
          </a>
        ))}
      </div>
    </div>
  );
}
