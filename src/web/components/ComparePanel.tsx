/**
 * Side-by-side comparison of the homes the user pinned: one column per home,
 * one row per fact, with the best value in each row highlighted. This is the
 * view a shortlist is actually decided in.
 */
import { memo, useMemo, useState, type ReactNode } from "react";
import { bestIndexes, MAX_COMPARE } from "../../domain/compare";
import { computeMoveInCosts, parkingInfo, parkingMonthlyYen, stayCost, STAY_MONTHS } from "../../domain/moveInCost";
import { describeNote, formatViewing, type NoteMap } from "../../domain/notes";
import { markMeta, type MarkMap } from "../../domain/marks";
import { listingKey } from "../../domain/listingKey";
import { listingPhotos } from "../../domain/listingPhotos";
import { sourceListings as portalReferences } from "../../domain/listingDedup";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS } from "../../domain/scoringConfig";
import { scoreColor, type ScoredRow } from "../../domain/scoring";
import type { ScoringCriterionKey } from "../../domain/types";
import type { CostBasis } from "./ListingTable";
import { ListingThumb } from "./ListingPhoto";
import styles from "./ComparePanel.module.css";
import appStyles from "../App.module.css";

interface Props {
  /** The pinned homes, in the order they were added. */
  rows: ScoredRow[];
  /** Each home's position in the current ranking; absent when filtered out. */
  ranks: ReadonlyMap<string, number>;
  rankedCount: number;
  costBasis: CostBasis;
  marks: MarkMap;
  notes: NoteMap;
  onRemove: (key: string) => void;
  onClear: () => void;
  onLocate: (key: string, lat: number, lon: number) => void;
}

/** One compared fact: how to show it, and (optionally) which way is better. */
interface Fact {
  label: string;
  labelJa?: string;
  /** Per home: what to show, and the number the highlight compares. */
  cells: { display: ReactNode; value?: number | null; sameAs?: string }[];
  better?: "low" | "high";
  hint?: string;
}

interface Section {
  title: string;
  facts: Fact[];
}

const yen = new Intl.NumberFormat("ja-JP");
const money = (n: number) => `¥${yen.format(n)}`;
const DISTANCE_KEYS = ["poi1", "poi2", "station", "busStop", "kindergarten", "school"] as const;
const LABELS = new Map<string, string>([...SCORE_PARAMETERS, ...FEATURE_PARAMETERS].map((meta) => [meta.key, meta.label]));

export const ComparePanel = memo(function ComparePanel({
  rows,
  ranks,
  rankedCount,
  costBasis,
  marks,
  notes,
  onRemove,
  onClear,
  onLocate,
}: Props) {
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const sections = useMemo(
    () => buildSections(rows, ranks, rankedCount, costBasis, marks, notes),
    [rows, ranks, rankedCount, costBasis, marks, notes],
  );

  return (
    <section className={appStyles.card} aria-label="Compare homes">
      <div className={styles.heading}>
        <h2 className={appStyles.cardTitle}>
          Compare <span className={styles.count}>{rows.length}/{MAX_COMPARE}</span>
        </h2>
        <label className={styles.toggle}>
          <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
          Only differences
        </label>
        <button type="button" className="secondary" onClick={onClear}>clear</button>
      </div>
      {rows.length < 2 && (
        <p className={styles.hint}>
          Tick <strong>Compare</strong> on another row, or use “+ Compare” on the map card, to put homes side by side.
        </p>
      )}
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.factHead} scope="col" aria-label="Fact" />
              {rows.map(({ listing, score }) => {
                const key = listingKey(listing);
                return (
                  <th key={key} scope="col" className={styles.home}>
                    <button
                      type="button"
                      className={styles.removeHome}
                      aria-label={`Remove ${listing.name} from the comparison`}
                      title="Remove from the comparison"
                      onClick={() => onRemove(key)}
                    >
                      ×
                    </button>
                    <ListingThumb photos={listingPhotos(listing)} name={listing.name} className={styles.thumb} />
                    <span className={styles.score} style={{ background: scoreColor(score.total) }}>
                      {score.total?.toFixed(0) ?? "—"}
                    </span>
                    {listing.lat != null && listing.lon != null ? (
                      <button
                        type="button"
                        className={styles.homeName}
                        title={`${listing.address}\nShow on the map`}
                        onClick={() => onLocate(key, listing.lat!, listing.lon!)}
                      >
                        {listing.name}
                      </button>
                    ) : (
                      <span className={styles.homeName} title={listing.address}>{listing.name}</span>
                    )}
                    <small>{listing.city ?? ""}</small>
                  </th>
                );
              })}
            </tr>
          </thead>
          {sections.map((section) => {
            const facts = onlyDifferences && rows.length > 1 ? section.facts.filter((fact) => !allSame(fact)) : section.facts;
            if (!facts.length) return null;
            return (
              <tbody key={section.title}>
                <tr className={styles.section}>
                  <th colSpan={rows.length + 1} scope="colgroup">{section.title}</th>
                </tr>
                {facts.map((fact) => {
                  const best = fact.better ? bestIndexes(fact.cells.map((cell) => cell.value), fact.better) : new Set<number>();
                  return (
                    <tr key={fact.label}>
                      <th scope="row" className={styles.fact} title={fact.hint}>
                        {fact.label}
                        {fact.labelJa && <small>{fact.labelJa}</small>}
                      </th>
                      {fact.cells.map((cell, index) => (
                        <td key={index} className={best.has(index) ? styles.best : undefined}>
                          {cell.display}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>
    </section>
  );
});

/** A row is "the same" when every home shows the same thing. */
function allSame(fact: Fact): boolean {
  const keys = fact.cells.map((cell) => cell.sameAs ?? (cell.value != null ? String(cell.value) : String(cell.display)));
  return keys.every((key) => key === keys[0]);
}

function buildSections(
  rows: ScoredRow[],
  ranks: ReadonlyMap<string, number>,
  rankedCount: number,
  { moveIn, includeParking }: CostBasis,
  marks: MarkMap,
  notes: NoteMap,
): Section[] {
  const columns = rows.map((row) => ({
    row,
    key: listingKey(row.listing),
    costs: computeMoveInCosts(row.listing, moveIn),
    stay: stayCost(row.listing, moveIn, includeParking),
    part: (key: ScoringCriterionKey) => row.score.parts.find((part) => part.key === key),
  }));
  const fact = (
    label: string,
    cell: (column: (typeof columns)[number]) => Fact["cells"][number],
    extra: Partial<Fact> = {},
  ): Fact => ({ label, cells: columns.map(cell), ...extra });
  const known = (value: number | null | undefined, show: (v: number) => ReactNode) =>
    ({ display: value == null ? "—" : show(value), value: value ?? null });

  const overall: Fact[] = [
    fact("Score", ({ row }) => known(row.score.total, (v) => v.toFixed(1)), { better: "high" }),
    fact("Rank", ({ key }) => {
      const rank = ranks.get(key);
      return rank == null
        ? { display: <em>filtered out</em>, value: null, sameAs: "out" }
        : { display: `#${rank} of ${rankedCount}`, value: rank };
    }, { better: "low", hint: "Position in the current ranking, with today's filters" }),
    fact("Decision", ({ key }) => {
      const meta = markMeta(marks[key]);
      return { display: meta ? `${meta.icon} ${meta.label}` : "—", sameAs: meta?.key ?? "" };
    }),
  ];

  const parkingCell = ({ row }: (typeof columns)[number]): Fact["cells"][number] => {
    const info = parkingInfo(row.listing);
    const monthly = parkingMonthlyYen(row.listing);
    if (info && !info.available) return { display: "none", sameAs: "none" };
    if (monthly == null) return { display: info?.available ? "available · price ?" : "—", sameAs: String(info?.available) };
    return { display: monthly === 0 ? "free" : `${money(monthly)}/mo`, value: monthly };
  };

  const moneyFacts: Fact[] = [
    fact("Rent", ({ row }) => known(row.listing.rent, money), { better: "low", labelJa: "賃料+管理費" }),
    fact("Monthly outlay", ({ stay }) => ({
      display: <>{money(stay.monthly)}{stay.parkingUnknown && <span title="Parking price not stated, so not included">*</span>}</>,
      value: stay.monthly,
    }), {
      better: "low",
      hint: `Rent incl. 管理費, listed monthly extras${includeParking ? " and parking" : ""}`,
    }),
    fact("Move-in upfront", ({ costs }) => known(costs.totalUpfront, money), { better: "low", labelJa: "初期費用" }),
    fact("Never returned", ({ costs }) => known(costs.sunkCost, money), {
      better: "low",
      hint: "礼金, fees, cleaning, insurance and the share of 敷金 lost to 原状回復",
    }),
    fact(`${STAY_MONTHS / 12}-year cost`, ({ stay }) => known(stay.total, money), {
      better: "low",
      hint: `Never-returned move-in money + ${STAY_MONTHS} × monthly outlay`,
    }),
    fact("Rent / ㎡", ({ part }) => known(part("rentPerM2")?.value, (v) => `${money(Math.round(v))}/㎡`), { better: "low" }),
    fact("Parking", parkingCell, { better: "low", labelJa: "駐車場" }),
  ];

  const home: Fact[] = [
    fact("Layout", ({ row }) => ({ display: row.listing.layout ?? "—", sameAs: row.listing.layout ?? "" })),
    fact("Size", ({ row }) => known(row.listing.sizeM2, (v) => `${v} ㎡`), { better: "high" }),
    fact("Built", ({ row }) => known(row.listing.builtYear, String), { better: "high" }),
    fact("Moving in", ({ row }) => {
      const from = row.listing.tenancy?.availableFrom;
      return { display: from ?? "—", sameAs: from ?? "" };
    }, { labelJa: "入居時期" }),
  ];

  const around: Fact[] = DISTANCE_KEYS.map((key) =>
    fact(LABELS.get(key) ?? key, ({ part }) => {
      const p = part(key);
      if (p?.value == null) return { display: "—", value: null };
      return {
        display: <>{p.value} min{p.detail && <small className={styles.detail}>{p.detail}</small>}</>,
        value: p.value,
      };
    }, { better: "low" }),
  );

  // Only features at least one home states, so the list stays about these homes.
  const features: Fact[] = FEATURE_PARAMETERS
    .filter((meta) => columns.some(({ part }) => part(meta.key)?.value != null))
    .map((meta) =>
      fact(meta.label, ({ part }) => {
        const p = part(meta.key);
        const display = p?.value == null ? "—" : p.value === 1 ? "✓ Yes" : "✕ No";
        // Highlight whichever answer the user prefers (score 100), not simply "Yes".
        return { display, value: p?.score ?? null, sameAs: display };
      }, { better: "high", labelJa: meta.labelJa }),
    );

  const mine: Fact[] = [
    fact("Viewing", ({ key }) => {
      const at = notes[key]?.viewingAt;
      return { display: at ? `📅 ${formatViewing(at)}` : "—", sameAs: at ?? "" };
    }),
    fact("Notes", ({ key }) => {
      const note = notes[key];
      return {
        display: note?.text.trim() ? <span className={styles.note}>{note.text}</span> : "—",
        sameAs: note ? describeNote(note) : "",
      };
    }),
    fact("Ads", ({ row }) => {
      const ads = portalReferences(row.listing).filter(({ url }) => Boolean(url));
      return {
        display: ads.length
          ? ads.map(({ source, url }) => (
            <a key={`${source}-${url}`} href={url!} target="_blank" rel="noreferrer" className={styles.ad}>
              {source} ↗
            </a>
          ))
          : "—",
        sameAs: ads.map(({ url }) => url).join(" "),
      };
    }),
  ];

  return [
    { title: "Overall", facts: overall },
    { title: "Money", facts: moneyFacts },
    { title: "The home", facts: home },
    { title: "Getting around", facts: around },
    { title: "Features", facts: features },
    { title: "My notes", facts: mine },
  ];
}
