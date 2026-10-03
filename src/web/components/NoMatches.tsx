/**
 * What to do when the filters leave nothing: each active filter that would
 * bring homes back on its own, with how many, as a one-click relax.
 */
import type { ListingFilters } from "../../domain/filters";
import type { RelaxationHint } from "../../domain/filterRelaxation";
import styles from "./NoMatches.module.css";

interface Props {
  /** False when no filter is set, or there is no data: then filters are not the cause. */
  filtersActive: boolean;
  hints: readonly RelaxationHint[];
  onRelax: (patch: Partial<ListingFilters>) => void;
  onResetFilters: () => void;
}

export function NoMatches({ filtersActive, hints, onRelax, onResetFilters }: Props) {
  if (!filtersActive) {
    return <div className={styles.empty} role="status"><strong>No listings to show yet.</strong></div>;
  }
  return (
    <div className={styles.empty} role="status">
      <strong>No listings match these filters.</strong>
      {hints.length > 0 ? (
        <ul>
          {hints.map((hint) => (
            <li key={hint.id}>
              <button type="button" onClick={() => onRelax(hint.patch)}>
                Clear {hint.label}
              </button>
              <span>→ {hint.count} listing{hint.count === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No single filter brings any back on its own; several are excluding everything together.</p>
      )}
      <button type="button" className="secondary" onClick={onResetFilters}>Reset all filters</button>
    </div>
  );
}
