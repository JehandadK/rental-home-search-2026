import { useCallback, useMemo, useState } from "react";
import { SCORE_PARAMETERS, type ScoringConfig } from "../domain/scoringConfig";
import { scoreListing } from "../domain/scoring";
import { diagnoseAll } from "../domain/diagnostics";
import { matchesListing } from "../domain/filters";
import { lifecycleCounts } from "../domain/lifecycle";
import { withAvailability } from "../domain/availability";
import { matchesMarkFilter, summarizeMarks } from "../domain/marks";
import { listingKey } from "../domain/listingKey";
import { ProximityIndex } from "../domain/proximityIndex";
import { applySelection, selectionAllowedSets } from "../domain/placeSelection";
import type { WebData } from "./data/useWebData";
import { usePlaceSelection } from "./hooks/usePlaceSelection";
import { PlacePanel } from "./components/PlacePanel";
import type { ScoreParameterKey } from "../domain/types";
import { useListings } from "./hooks/useListings";
import { useScoringConfig } from "./hooks/useScoringConfig";
import { useFilters } from "./hooks/useFilters";
import { useMarks } from "./hooks/useMarks";
import { useAvailabilityMarks } from "./hooks/useAvailabilityMarks";
import { useNotes } from "./hooks/useNotes";
import { useCompare } from "./hooks/useCompare";
import { toCsv, toMarkdown } from "./lib/export";
import type { ScoredRow } from "../domain/scoring";
import { AddListingForm } from "./components/AddListingForm";
import { ComparePanel } from "./components/ComparePanel";
import { FilterPanel } from "./components/FilterPanel";
import { ListingTable } from "./components/ListingTable";
import { MapView } from "./components/MapView";
import { WeightPanel } from "./components/WeightPanel";
import styles from "./App.module.css";

/** The dashboard, over data the WebDataBoundary has already loaded. */
export function App({ data }: { data: WebData }) {
  const { reference } = data;
  const { catalog } = reference;
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
  const { listings, addListing, removeListing } = useListings(data.listings);
  const { filters, update: updateFilters, reset: resetFilters } = useFilters();
  const { marks, setMark, clearMarks } = useMarks();
  const { availabilityMarks, markAd } = useAvailabilityMarks();
  const { notes, setNote } = useNotes();
  const { compare, toggleCompare, clearCompare } = useCompare();
  const { selection, setPlaces, togglePlace, setTarget, reset: resetPlaces } = usePlaceSelection(catalog);

  /**
   * Full listing × place distance matrix, built once per listing set. Every
   * reference place is measured, so changing which places count is a cheap
   * in-memory reduction rather than a pipeline re-run.
   */
  const index = useMemo(() => new ProximityIndex(listings, catalog), [listings, catalog]);

  /** The place the poi1 score measures to, marked on the map. */
  const targetPoi = useMemo(() => {
    const id = selection.byParameter.poi1?.[0];
    return id ? catalog.byId.get(id) ?? null : null;
  }, [catalog, selection]);

  /** Listings with proximities resolved against the current place selection. */
  const resolved = useMemo(() => {
    const allowedSets = selectionAllowedSets(selection);
    return listings.map((listing, i) => applySelection(listing, i, index, selection, allowedSets));
  }, [listings, index, selection]);

  /**
   * Overlay the user's hand-made availability marks. Applied after the
   * proximity work so toggling one ad never rebuilds the distance matrix, and
   * untouched rows keep their identity.
   */
  const available = useMemo(
    () => Object.keys(availabilityMarks).length ? resolved.map((listing) => withAvailability(listing, availabilityMarks)) : resolved,
    [resolved, availabilityMarks],
  );

  /**
   * Apply every score-independent filter before scoring. This avoids doing
   * ten-parameter move-in calculations for hundreds of rows the user has
   * already excluded by city, area, rent, size, status, layout or parking.
   * The decision-mark filter is applied here too, since the marks are user
   * state kept outside the listing data.
   */
  const candidates = useMemo(
    () =>
      available.filter(
        (listing) =>
          matchesListing(listing, filters) &&
          matchesMarkFilter(marks[listingKey(listing)], filters.markFilter),
      ),
    // Marks only affect candidates when the decision filter is active. Without
    // this split, changing one row's mark rescored the entire visible market.
    [available, filters, filters.markFilter === "all" ? null : marks],
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

  /** The move-in assumptions and parking switch behind every cost figure. */
  const costBasis = useMemo(
    () => ({ moveIn: config.moveIn, includeParking: config.includeParking }),
    [config.moveIn, config.includeParking],
  );

  /**
   * The pinned homes, scored on their own so a comparison survives filters
   * that would hide one of them. Keys whose listing has left the data are
   * skipped.
   */
  const compareRows: ScoredRow[] = useMemo(() => {
    if (!compare.length) return [];
    const byKey = new Map(available.map((listing) => [listingKey(listing), listing]));
    return compare.flatMap((key) => {
      const listing = byKey.get(key);
      return listing ? [{ listing, score: scoreListing(listing, config) }] : [];
    });
  }, [compare, available, config]);

  /** Where each pinned home sits in the current ranking (1 = best). */
  const compareRanks = useMemo(() => {
    const ranks = new Map<string, number>();
    for (const key of compare) {
      const row = filtered.find(({ listing }) => listingKey(listing) === key);
      if (!row) continue;
      const total = row.score.total ?? -1;
      ranks.set(key, 1 + filtered.filter(({ score }) => (score.total ?? -1) > total).length);
    }
    return ranks;
  }, [compare, filtered]);

  /** Lifecycle headline numbers: fresh discoveries and sold stock. */
  const { newCount, soldCount, rentedOutCount } = useMemo(() => lifecycleCounts(available), [available]);

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
      return navigator.clipboard.writeText(format(ranked, marks, notes));
    },
    [filtered, marks, notes],
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
          {rentedOutCount > 0 && ` · ${rentedOutCount} rented out${filters.rentedOut === "hide" ? " (hidden)" : ""}`}
          {markSummary.candidates > 0 && ` · ★${markSummary.candidates} shortlisted`}
          {markSummary.ruledOut > 0 && ` · ✕${markSummary.ruledOut} ruled out`}
        </span>
      </header>
      <main className={styles.layout}>
        <aside className={styles.sidebar}>
          <FilterPanel
            listings={listings}
            cities={reference.cities}
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
            catalog={catalog}
            selection={selection}
            onToggle={togglePlace}
            onSetTarget={setTarget}
            onSetPlaces={setPlaces}
            onReset={resetPlaces}
          />
          <AddListingForm catalog={catalog} onAdd={addListing} />
        </aside>
        <section className={styles.main}>
          <MapView
            items={filtered}
            reference={reference}
            targetPoi={targetPoi}
            hovered={hovered}
            onHover={setHovered}
            selected={selected}
            onSelect={setSelected}
            centerTarget={mapCenterTarget}
            marks={marks}
            onSetMark={setMark}
            notes={notes}
            compare={compare}
            onToggleCompare={toggleCompare}
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
            onMarkAd={markAd}
            costBasis={costBasis}
            notes={notes}
            onSetNote={setNote}
            compare={compare}
            onToggleCompare={toggleCompare}
          />
          {compare.length > 0 && (
            <div id="compare">
              <ComparePanel
                rows={compareRows}
                ranks={compareRanks}
                rankedCount={filtered.length}
                costBasis={costBasis}
                marks={marks}
                notes={notes}
                onRemove={toggleCompare}
                onClear={clearCompare}
                onLocate={centerMapOn}
              />
            </div>
          )}
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
