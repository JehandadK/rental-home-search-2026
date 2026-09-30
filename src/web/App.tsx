import { useCallback, useMemo, useState } from "react";
import { SCORE_PARAMETERS, type ScoringConfig } from "../domain/scoringConfig";
import { scoreListing } from "../domain/scoring";
import { diagnoseAll } from "../domain/diagnostics";
import { matchesListing } from "../domain/filters";
import { lifecycleCounts } from "../domain/lifecycle";
import { matchesMarkFilter, summarizeMarks } from "../domain/marks";
import { listingKey } from "../domain/listingKey";
import { ProximityIndex } from "../domain/proximityIndex";
import { applySelection, selectionAllowedSets } from "../domain/placeSelection";
import { BUNDLED_REFERENCE } from "./data/bundledClient";
import { usePlaceSelection } from "./hooks/usePlaceSelection";
import { PlacePanel } from "./components/PlacePanel";
import type { ScoreParameterKey } from "../domain/types";
import { useListings } from "./hooks/useListings";
import { useScoringConfig } from "./hooks/useScoringConfig";
import { useFilters } from "./hooks/useFilters";
import { useMarks } from "./hooks/useMarks";
import { toCsv, toMarkdown } from "./lib/export";
import type { ScoredRow } from "../domain/scoring";
import { AddListingForm } from "./components/AddListingForm";
import { FilterPanel } from "./components/FilterPanel";
import { ListingTable } from "./components/ListingTable";
import { MapView } from "./components/MapView";
import { WeightPanel } from "./components/WeightPanel";
import styles from "./App.module.css";

export function App() {
  const {
    config,
    setWeight,
    setFeatureWeight,
    setFeaturePreference,
    update,
    setWalkZero,
    zeroAllWeights,
    reset,
  } = useScoringConfig();
  const { listings, addListing, removeListing } = useListings();
  const { filters, update: updateFilters, reset: resetFilters } = useFilters();
  const { marks, setMark, clearMarks } = useMarks();
  const { selection, setPlaces, togglePlace, setTarget, reset: resetPlaces } = usePlaceSelection();

  /**
   * Full listing × place distance matrix, built once per listing set. Every
   * reference place is measured, so changing which places count is a cheap
   * in-memory reduction rather than a pipeline re-run.
   */
  const index = useMemo(() => new ProximityIndex(listings, BUNDLED_REFERENCE.catalog), [listings]);

  /** Listings with proximities resolved against the current place selection. */
  const resolved = useMemo(() => {
    const allowedSets = selectionAllowedSets(selection);
    return listings.map((listing, i) => applySelection(listing, i, index, selection, allowedSets));
  }, [listings, index, selection]);

  /**
   * Apply every score-independent filter before scoring. This avoids doing
   * ten-parameter move-in calculations for hundreds of rows the user has
   * already excluded by city, area, rent, size, status, layout or parking.
   * The decision-mark filter is applied here too, since the marks are user
   * state kept outside the listing data.
   */
  const candidates = useMemo(
    () =>
      resolved.filter(
        (listing) =>
          matchesListing(listing, filters) &&
          matchesMarkFilter(marks[listingKey(listing)], filters.markFilter),
      ),
    // Marks only affect candidates when the decision filter is active. Without
    // this split, changing one row's mark rescored the entire visible market.
    [resolved, filters, filters.markFilter === "all" ? null : marks],
  );

  const scored: ScoredRow[] = useMemo(
    () => candidates.map((listing) => ({ listing, score: scoreListing(listing, config) })),
    [candidates, config],
  );

  const filtered: ScoredRow[] = useMemo(
    () => filters.minScore > 0
      ? scored.filter(({ score }) => (score.total ?? -1) >= filters.minScore)
      : scored,
    [scored, filters.minScore],
  );

  /** Lifecycle headline numbers: fresh discoveries and sold stock. */
  const { newCount, soldCount } = useMemo(() => lifecycleCounts(listings), [listings]);

  /** Decision-mark headline numbers: candidates shortlisted and homes ruled out. */
  const markSummary = useMemo(
    () => summarizeMarks(listings.map((listing) => marks[listingKey(listing)])),
    [listings, marks],
  );

  const copyRanked = useCallback(
    (format: typeof toCsv) => {
      // Export sorting is deferred until the user actually requests it. Keeping
      // a permanently sorted duplicate of 1,600 rows added work to each score change.
      const ranked = [...filtered].sort((a, b) => (b.score.total ?? -1) - (a.score.total ?? -1));
      return navigator.clipboard.writeText(format(ranked, marks));
    },
    [filtered, marks],
  );

  /**
   * Which weighted criteria currently fail to separate any listing. Measured
   * over the filtered set, since that is what the ranking is actually made of.
   */
  const diagnoses = useMemo(
    () => diagnoseAll(SCORE_PARAMETERS.map((p) => p.key), filtered, config.weights),
    [filtered, config.weights],
  );

  /** Move a parameter's anchor to a value fitted to the visible data. */
  const fitAnchor = useCallback(
    (key: ScoreParameterKey, suggested: number) => {
      if (isWalkParameter(key)) setWalkZero(key, suggested);
      else update(scalarAnchorPatch(key, suggested));
    },
    [update, setWalkZero],
  );

  /** Fit every flagged parameter at once, in a single config update. */
  const fitAll = useCallback(() => {
    const walkZeroMinutes = { ...config.walkZeroMinutes };
    let patch: Partial<ScoringConfig> = {};
    for (const d of diagnoses) {
      if (d.suggestedAnchor == null) continue;
      if (isWalkParameter(d.key)) walkZeroMinutes[d.key] = d.suggestedAnchor;
      else patch = { ...patch, ...scalarAnchorPatch(d.key, d.suggestedAnchor) };
    }
    update({ ...patch, walkZeroMinutes });
  }, [diagnoses, update, config.walkZeroMinutes]);

  /** The listing currently hovered in either the map or the table (transient). */
  const [hovered, setHovered] = useState<string | null>(null);
  /** The selected listing (persistent; links the map and table). */
  const [selected, setSelected] = useState<string | null>(null);
  /** A new object for every locate click, including repeated clicks on one row. */
  const [mapCenterTarget, setMapCenterTarget] = useState<{
    key: string;
    lat: number;
    lon: number;
    request: number;
  } | null>(null);

  const centerMapOn = useCallback((key: string, lat: number, lon: number) => {
    setSelected(key);
    setMapCenterTarget((current) => ({
      key,
      lat,
      lon,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);

  return (
    <>
      <header className={styles.header}>
        <h1>Soka Rental Scorer</h1>
        <span className={styles.subtitle}>
          草加市・越谷市・川口市 — weighted 0–100 scoring · Al Sanad School &amp; nearest mosque
        </span>
        <span className={styles.subtitle}>
          {filtered.length} / {listings.length} listings
          {newCount > 0 && ` · ${newCount} new`}
          {soldCount > 0 && ` · ${soldCount} sold`}
          {markSummary.candidates > 0 && ` · ★${markSummary.candidates} shortlisted`}
          {markSummary.ruledOut > 0 && ` · ✕${markSummary.ruledOut} ruled out`}
        </span>
      </header>
      <main className={styles.layout}>
        <aside className={styles.sidebar}>
          <FilterPanel
            listings={listings}
            filters={filters}
            onUpdate={updateFilters}
            onReset={resetFilters}
            marks={marks}
            onClearMarks={clearMarks}
            matchCount={filtered.length}
          />
          <WeightPanel
            config={config}
            onSetWeight={setWeight}
            onSetFeatureWeight={setFeatureWeight}
            onSetFeaturePreference={setFeaturePreference}
            onUpdate={update}
            onSetWalkZero={setWalkZero}
            onZeroAllWeights={zeroAllWeights}
            onReset={reset}
            onExportCsv={() => copyRanked(toCsv)}
            onExportMarkdown={() => copyRanked(toMarkdown)}
            diagnoses={diagnoses}
            onFitAnchor={fitAnchor}
            onFitAll={fitAll}
          />
          <PlacePanel
            selection={selection}
            onToggle={togglePlace}
            onSetTarget={setTarget}
            onSetPlaces={setPlaces}
            onReset={resetPlaces}
          />
          <AddListingForm onAdd={addListing} />
        </aside>
        <section className={styles.main}>
          <MapView
            items={filtered}
            reference={BUNDLED_REFERENCE}
            hovered={hovered}
            onHover={setHovered}
            selected={selected}
            onSelect={setSelected}
            centerTarget={mapCenterTarget}
            marks={marks}
            onSetMark={setMark}
          />
          <ListingTable
            items={filtered}
            onRemove={removeListing}
            hovered={hovered}
            onHover={setHovered}
            selected={selected}
            onSelect={setSelected}
            onCenterMap={centerMapOn}
            marks={marks}
            onSetMark={setMark}
          />
        </section>
      </main>
    </>
  );
}

type WalkParameterKey = keyof ScoringConfig["walkZeroMinutes"];

/** Distance-based parameters store their anchor inside walkZeroMinutes. */
function isWalkParameter(key: ScoreParameterKey): key is WalkParameterKey {
  return !["rent", "rentPerM2", "moveInCost", "size", "yearBuilt"].includes(key);
}

/** Which top-level config field a non-distance parameter's anchor maps to. */
function scalarAnchorPatch(key: ScoreParameterKey, value: number): Partial<ScoringConfig> {
  switch (key) {
    case "rent":
      return { rentZeroScoreAbove: value };
    case "rentPerM2":
      return { rentPerM2ZeroScoreAbove: value };
    case "moveInCost":
      return { moveInZeroScoreAboveMonths: value };
    case "size":
      return { sizeFullScoreAbove: value };
    default:
      return { buildingAgeZeroAt: value };
  }
}
