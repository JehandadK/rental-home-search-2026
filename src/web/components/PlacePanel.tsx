/**
 * Dashboard control for "which places actually matter to us".
 *
 * Every reference place is measured for every listing at load time, so the
 * choices here are pure selection — no re-scraping, no re-enriching. Pick a
 * single station you would really commute from, or restrict schools to your
 * catchment shortlist.
 */
import { useMemo, useState } from "react";
import { SCORE_PARAMETERS } from "../../domain/scoringConfig";
import {
  categoryLabel,
  DISTANCE_PARAMETERS,
  PARAMETER_SOURCES,
  type DistanceParameterKey,
  type PlaceCatalog,
} from "../../domain/places";
import { describeSelection, type PlaceSelection } from "../../domain/placeSelection";
import styles from "./PlacePanel.module.css";
import appStyles from "../App.module.css";

interface Props {
  catalog: PlaceCatalog;
  selection: PlaceSelection;
  onToggle: (key: DistanceParameterKey, id: string) => void;
  onSetPlaces: (key: DistanceParameterKey, ids: string[] | null) => void;
  onReset: () => void;
}

const labelFor = (key: DistanceParameterKey) =>
  SCORE_PARAMETERS.find((p) => p.key === key)?.label ?? key;

export function PlacePanel({ catalog, selection, onToggle, onSetPlaces, onReset }: Props) {
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
          catalog={catalog}
          defaultOpen={index < 2}
          selection={selection}
          onToggle={onToggle}
          onSetPlaces={onSetPlaces}
        />
      ))}
    </section>
  );
}

function ParameterPlaces({
  paramKey,
  catalog,
  defaultOpen,
  selection,
  onToggle,
  onSetPlaces,
}: {
  paramKey: DistanceParameterKey;
  defaultOpen: boolean;
} & Omit<Props, "onReset">) {
  const source = PARAMETER_SOURCES[paramKey];
  const places = useMemo(() => catalog.inCategory(source.category), [catalog, source.category]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(defaultOpen);
  const chosen = selection.byParameter[paramKey];

  const shown = useMemo(() => {
    const q = query.trim();
    const base = q ? places.filter((p) => p.name.includes(q)) : places;
    return base.slice(0, 80);
  }, [places, query]);

  return (
    <details className={styles.group} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className={styles.name}>{labelFor(paramKey)}</span>
        <span className={styles.summary}>{describeSelection(selection, paramKey, catalog)}</span>
      </summary>

      <div className={styles.body}>
        <div className={styles.actions}>
          <span className={styles.hint}>
            {`Nearest of the selected ${categoryLabel(source.category).toLowerCase()}`}
          </span>
          <span className={styles.bulk}>
            <button onClick={() => onSetPlaces(paramKey, null)}>all</button>
            <button onClick={() => onSetPlaces(paramKey, [])}>clear</button>
          </span>
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
            const active = chosen == null || chosen.includes(place.id);
            return (
              <label key={place.id} className={styles.item}>
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => onToggle(paramKey, place.id)}
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
