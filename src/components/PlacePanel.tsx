/**
 * Dashboard control for "which places actually matter to us".
 *
 * Every reference place is measured for every listing at load time, so the
 * choices here are pure selection — no re-scraping, no re-enriching. Pick a
 * single station you would really commute from, restrict schools to your
 * catchment shortlist, or swap the POI target outright.
 */
import { useMemo, useState } from "react";
import { SCORE_PARAMETERS } from "../config/scoring";
import {
  CATEGORY_LABELS,
  DISTANCE_PARAMETERS,
  PARAMETER_SOURCES,
  placesInCategory,
  type DistanceParameterKey,
} from "../domain/places";
import { describeSelection, type PlaceSelection } from "../domain/placeSelection";
import styles from "./PlacePanel.module.css";
import appStyles from "../App.module.css";

interface Props {
  selection: PlaceSelection;
  onToggle: (key: DistanceParameterKey, id: string) => void;
  onSetTarget: (key: DistanceParameterKey, id: string) => void;
  onSetPlaces: (key: DistanceParameterKey, ids: string[] | null) => void;
  onReset: () => void;
}

const labelFor = (key: DistanceParameterKey) =>
  SCORE_PARAMETERS.find((p) => p.key === key)?.label ?? key;

export function PlacePanel({ selection, onToggle, onSetTarget, onSetPlaces, onReset }: Props) {
  return (
    <section className={appStyles.card}>
      <h2 className={appStyles.cardTitle}>
        Places
        <button className={`secondary ${styles.reset}`} onClick={onReset}>
          reset
        </button>
      </h2>
      <p className={styles.intro}>
        All distances are computed for every place — choose which ones count.
      </p>

      {DISTANCE_PARAMETERS.map((key, index) => (
        <ParameterPlaces
          key={key}
          paramKey={key}
          defaultOpen={index < 2}
          selection={selection}
          onToggle={onToggle}
          onSetTarget={onSetTarget}
          onSetPlaces={onSetPlaces}
        />
      ))}
    </section>
  );
}

function ParameterPlaces({
  paramKey,
  defaultOpen,
  selection,
  onToggle,
  onSetTarget,
  onSetPlaces,
}: {
  paramKey: DistanceParameterKey;
  defaultOpen: boolean;
} & Omit<Props, "onReset">) {
  const source = PARAMETER_SOURCES[paramKey];
  const places = useMemo(() => placesInCategory(source.category), [source.category]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(defaultOpen);
  const chosen = selection.byParameter[paramKey];

  const shown = useMemo(() => {
    const q = query.trim();
    const base = q ? places.filter((p) => p.name.includes(q)) : places;
    return base.slice(0, 80);
  }, [places, query]);

  const isTarget = source.mode === "target";

  return (
    <details className={styles.group} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className={styles.name}>{labelFor(paramKey)}</span>
        <span className={styles.summary}>{describeSelection(selection, paramKey)}</span>
      </summary>

      <div className={styles.body}>
        <div className={styles.actions}>
          <span className={styles.hint}>
            {isTarget
              ? `Measure distance to one ${CATEGORY_LABELS[source.category].toLowerCase()}`
              : `Nearest of the selected ${CATEGORY_LABELS[source.category].toLowerCase()}`}
          </span>
          {!isTarget && (
            <span className={styles.bulk}>
              <button onClick={() => onSetPlaces(paramKey, null)}>all</button>
              <button onClick={() => onSetPlaces(paramKey, [])}>clear</button>
            </span>
          )}
        </div>

        {places.length > 12 && (
          <input
            className={styles.search}
            type="search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        <div className={styles.list}>
          {shown.map((place) => {
            const active = isTarget
              ? chosen?.[0] === place.id
              : chosen == null || chosen.includes(place.id);
            return (
              <label key={place.id} className={styles.item}>
                <input
                  type={isTarget ? "radio" : "checkbox"}
                  name={isTarget ? `target-${paramKey}` : undefined}
                  checked={active}
                  onChange={() =>
                    isTarget ? onSetTarget(paramKey, place.id) : onToggle(paramKey, place.id)
                  }
                />
                <span className={styles.itemName} title={place.subtitle ?? place.name}>
                  {place.name}
                </span>
              </label>
            );
          })}
          {places.length > shown.length && (
            <span className={styles.more}>
              +{places.length - shown.length} more — refine the search
            </span>
          )}
        </div>
      </div>
    </details>
  );
}
