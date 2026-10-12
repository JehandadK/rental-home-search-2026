import { useCallback, useEffect, useMemo, useState } from "react";
import { SCORE_PARAMETERS, travelSpeed, type ScoringConfig } from "../domain/scoringConfig";
import { scoreListing } from "../domain/scoring";
import { diagnoseAll } from "../domain/diagnostics";
import { activeFilterCount } from "../domain/filters";
import type { RelaxationHint } from "../domain/filterRelaxation";
import { lifecycleCounts } from "../domain/lifecycle";
import { isUrListing } from "../domain/ur";
import { urVacancies as countUrVacancies } from "../domain/urEstates";
import {
  carryToLeads,
  findPossibleDuplicates,
    isPendingPair,
  resolveDecisions,
  shownKey,
  type PossibleDuplicate,
} from "../domain/possibleDuplicates";
import { summarizeMarks } from "../domain/marks";
import { listingKey } from "../domain/listingKey";
import {
  buildProximityIndex,
  byScoreDesc,
  emptyResultHints,
  filterCandidates,
  meetsMinScore,
  mergeConfirmedDuplicates,
  overlayAvailability,
  rankOf,
  resolvePlaces,
  scoreCandidates,
} from "../domain/recommend/pipeline";
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
import { useDuplicateDecisions } from "./hooks/useDuplicateDecisions";
import { useMapAreas } from "./hooks/useMapAreas";
import { useWeightPresets } from "./hooks/useWeightPresets";
import { useRankMovement } from "./hooks/useRankMovement";
import { toCsv, toMarkdown } from "./lib/export";
import type { ScoredRow } from "../domain/scoring";
import { AddListingForm } from "./components/AddListingForm";
import { ComparePanel } from "./components/ComparePanel";
import { DuplicateReview } from "./components/DuplicateReview";
import { FilterPanel } from "./components/FilterPanel";
import { buildAgencyGazetteer } from "../domain/agencyNames";
import { ListingTable } from "./components/ListingTable";
import { MapView } from "./components/MapView";
import { NoMatches } from "./components/NoMatches";
import { WeightPanel } from "./components/WeightPanel";
import styles from "./App.module.css";

const NO_HINTS: RelaxationHint[] = [];

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
    applyPreset,
    reset,
  } = useScoringConfig();
  const { presets, savePreset, deletePreset } = useWeightPresets();
  const { listings, addListing, removeListing } = useListings(data.listings);
  const { filters, update: updateFilters, reset: resetFilters } = useFilters();
  const { marks: savedMarks, setMark: saveMark, clearMarks } = useMarks();
  const { availabilityMarks, markAd } = useAvailabilityMarks();
  const { notes: savedNotes, setNote: saveNote } = useNotes();
  const { compare: savedCompare, toggleCompare: toggleSavedCompare, clearCompare, retainCompare: retainSavedCompare } = useCompare();
  const { selection, setPlaces, togglePlace, reset: resetPlaces } = usePlaceSelection(catalog);
  const { decisions: duplicateDecisions, decide: decideDuplicate, undo: undoDuplicate } = useDuplicateDecisions();
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);

  /** Each duplicate answer's listings today, and the homes the "same" answers form. */
  const resolvedDuplicates = useMemo(() => resolveDecisions(listings, duplicateDecisions), [listings, duplicateDecisions]);
  /**
   * The confirmed groups, changing identity only when the groups do: a
   * "Different" answer or an undo that merges nothing re-scores nothing.
   */
  const groupSignature = useMemo(
    () => [...resolvedDuplicates.leadOf].map(([member, lead]) => `${member}>${lead}`).sort().join("|"),
    [resolvedDuplicates.leadOf],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const leadOf = useMemo(() => resolvedDuplicates.leadOf, [groupSignature]);

  /**
   * Marks, notes and the compare list are saved per listing key. A merged
   * home shows what was saved on any of its listings; changing it on the
   * merged home clears the absorbed listings' copies so they cannot reappear.
   */
  const marks = useMemo(() => carryToLeads(savedMarks, leadOf), [savedMarks, leadOf]);
  const notes = useMemo(() => carryToLeads(savedNotes, leadOf), [savedNotes, leadOf]);
  const membersOf = useCallback(
    (key: string) => [...leadOf].filter(([member, lead]) => lead === key && member !== key).map(([member]) => member),
    [leadOf],
  );
  const setMark = useCallback((key: string, mark: Parameters<typeof saveMark>[1]) => {
    saveMark(key, mark);
    for (const member of membersOf(key)) saveMark(member, null);
  }, [saveMark, membersOf]);
  const setNote = useCallback((key: string, draft: Parameters<typeof saveNote>[1]) => {
    saveNote(key, draft);
    for (const member of membersOf(key)) saveNote(member, { text: "", viewingAt: null });
  }, [saveNote, membersOf]);
  const compare = useMemo(
    () => [...new Set(savedCompare.map((key) => shownKey({ leadOf }, key)))],
    [savedCompare, leadOf],
  );
  const toggleCompare = useCallback(
    (key: string) => toggleSavedCompare(savedCompare.find((saved) => shownKey({ leadOf }, saved) === key) ?? key),
    [toggleSavedCompare, savedCompare, leadOf],
  );
  const retainCompare = useCallback(
    (known: { has(key: string): boolean }) => retainSavedCompare({ has: (key) => known.has(shownKey({ leadOf }, key)) }),
    [retainSavedCompare, leadOf],
  );

  /**
   * Full listing × place distance matrix, built once per listing set. Every
   * reference place is measured, so changing which places count is a cheap
   * in-memory reduction rather than a pipeline re-run.
   */
  const index = useMemo(() => buildProximityIndex(listings, catalog), [listings, catalog]);

  /**
   * The private schools the poi1 score takes the nearest of, marked on the
   * map. With none chosen the score uses every private school.
   */
  const scoredPois = useMemo(() => {
    const ids = selection.byParameter.poi1;
    return ids == null ? catalog.inCategory("poi") : ids.flatMap((id) => catalog.byId.get(id) ?? []);
  }, [catalog, selection]);

  /**
   * Places the map draws travel-time rings around: the scored private schools
   * and the mosques chosen for the poi2 score. With no mosques chosen the
   * score uses all of them (hundreds across Japan), too many to ring, so none
   * are; the private schools are few enough to ring all of them.
   */
  const ringCenters = useMemo(() => {
    const mosques = (selection.byParameter.poi2 ?? []).flatMap((id) => catalog.byId.get(id) ?? []);
    return [...scoredPois, ...mosques];
  }, [catalog, selection, scoredPois]);

  /** Walking knobs for the map card's distance list. */
  const walking = useMemo(
    () => ({ speedMPerMin: config.walkSpeedMPerMin, detourFactor: config.detourFactor, includeHoikuen: config.includeHoikuen }),
    [config.walkSpeedMPerMin, config.detourFactor, config.includeHoikuen],
  );

  /** Listings with proximities resolved against the current place selection. */
  const resolved = useMemo(() => resolvePlaces(listings, index, selection), [listings, index, selection]);

  /**
   * Overlay the user's hand-made availability marks. Applied after the
   * proximity work so toggling one ad never rebuilds the distance matrix, and
   * untouched rows keep their identity.
   */
  const withMarks = useMemo(() => overlayAvailability(resolved, availabilityMarks), [resolved, availabilityMarks]);

  /**
   * Show pairs the user confirmed as one home as one listing. Everything
   * downstream (filters, scores, map, table) sees the merged set.
   */
  const available = useMemo(() => mergeConfirmedDuplicates(withMarks, leadOf), [withMarks, leadOf]);

  /**
   * Pairs that may be one home, for the review panel. Found after the first
   * paint, so loading the dashboard never waits for it.
   */
  const [duplicatePairs, setDuplicatePairs] = useState<PossibleDuplicate[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDuplicatePairs(findPossibleDuplicates(listings)), 0);
    return () => clearTimeout(timer);
  }, [listings]);
  /** Every listing by key before any "same" merge: the review panel shows both sides. */
  const unmergedByKey = useMemo(() => new Map(listings.map((listing) => [listingKey(listing), listing])), [listings]);
  /** Pairs still to review: unanswered, and not already one home through other answers. */
  const pendingDuplicates = useMemo(
    () => duplicatePairs?.filter((pair) => isPendingPair(pair, resolvedDuplicates)).length ?? null,
    [duplicatePairs, resolvedDuplicates],
  );

  /**
   * Apply every score-independent filter before scoring. This avoids doing
   * ten-parameter move-in calculations for hundreds of rows the user has
   * already excluded by city, area, rent, size, status, layout or parking.
   * The decision-mark filter is applied here too, since the marks are user
   * state kept outside the listing data.
   */
  const candidates = useMemo(
    () => filterCandidates(available, filters, marks),
    // Marks only affect candidates when the decision filter is active. Without
    // this split, changing one row's mark rescored the entire visible market.
    [available, filters, filters.markFilter === "all" ? null : marks],
  );
  // The map draws the chosen areas (by default every city the listings are in).
  const mapAreas = useMapAreas(reference.cities, listings);
  // Where each agency store is: rail stations and city names, from the reference catalog.
  const agencyGazetteer = useMemo(() => buildAgencyGazetteer(reference.cities, reference.catalog.inCategory("railStation")
    .map((station) => ({ name: station.name, cityId: typeof station.attributes?.cityId === "string" ? station.attributes.cityId : undefined }))),
  [reference]);

  const scored: ScoredRow[] = useMemo(() => scoreCandidates(candidates, config), [candidates, config]);

  const filtered: ScoredRow[] = useMemo(() => meetsMinScore(scored, filters.minScore), [scored, filters.minScore]);

  /**
   * How far each home moved in the ranking after the last change to the
   * scoring (weights, anchors, places), shown for a few seconds.
   */
  const rankMoves = useRankMovement(filtered, [config, selection]);

  /**
   * When nothing matches, which single filter to clear and what that would
   * bring back. Only computed for the empty case, where it runs the whole
   * filter pipeline once per active filter.
   */
  const relaxHints = useMemo(() => {
    if (filtered.length > 0 || available.length === 0) return NO_HINTS;
    return emptyResultHints(available, filters, marks, config);
  }, [filtered.length, available, filters, marks, config]);

  // Memoised: a fresh element would re-render the memoised table on every hover.
  const noMatches = useMemo(
    () => (
      <NoMatches
        filtersActive={available.length > 0 && activeFilterCount(filters) > 0}
        hints={relaxHints}
        onRelax={updateFilters}
        onResetFilters={resetFilters}
      />
    ),
    [available.length, filters, relaxHints, updateFilters, resetFilters],
  );

  /** The move-in assumptions and parking switch behind every cost figure. */
  const costBasis = useMemo(
    () => ({ moveIn: config.moveIn, includeParking: config.includeParking }),
    [config.moveIn, config.includeParking],
  );

  /** Every listing by key, for the pinned homes. Built once per listing set. */
  const listingsByKey = useMemo(
    () => new Map(available.map((listing) => [listingKey(listing), listing])),
    [available],
  );

  // A pinned home can leave the data (a key-changing rescrape, a removed
  // custom listing). Unpin it, or it would hold a compare slot nobody can see.
  useEffect(() => {
    if (compare.some((key) => !listingsByKey.has(key))) retainCompare(listingsByKey);
  }, [compare, listingsByKey, retainCompare]);

  /**
   * The pinned homes, scored on their own so a comparison survives filters
   * that would hide one of them.
   */
  const compareRows: ScoredRow[] = useMemo(
    () => compare.flatMap((key) => {
      const listing = listingsByKey.get(key);
      return listing ? [{ listing, score: scoreListing(listing, config) }] : [];
    }),
    [compare, listingsByKey, config],
  );

  /** Where each pinned home sits in the current ranking (1 = best). */
  const compareRanks = useMemo(() => {
    const ranks = new Map<string, number>();
    for (const key of compare) {
      const row = filtered.find(({ listing }) => listingKey(listing) === key);
      if (!row) continue;
      ranks.set(key, rankOf(filtered, row.score.total));
    }
    return ranks;
  }, [compare, filtered]);

  /** Lifecycle headline numbers: fresh discoveries and sold stock. */
  const { newCount, soldCount, rentedOutCount } = useMemo(
    () => lifecycleCounts(available, filters.newWithinDays),
    [available, filters.newWithinDays],
  );

  /** UR rooms on offer, for the header (the UR filter may hide them). */
  const urCount = useMemo(() => available.filter(isUrListing).length, [available]);
  /** Each UR estate's advertised rooms, from every listing: the map's estates ignore the filters. */
  const urVacancies = useMemo(() => countUrVacancies(available), [available]);

  /** Decision-mark headline numbers: candidates shortlisted and homes ruled out. */
  const markSummary = useMemo(
    () => summarizeMarks(listings.map((listing) => marks[listingKey(listing)])),
    [listings, marks],
  );

  const copyRanked = useCallback(
    (format: typeof toCsv) => {
      // Export sorting is deferred until the user actually requests it. Keeping
      // a permanently sorted duplicate of 1,600 rows added work to each score change.
      const ranked = [...filtered].sort(byScoreDesc);
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

  /** Keys of the listings the filters currently show, for the review panel's "matching" toggle. */
  const visibleKeys = useMemo(() => new Set(filtered.map(({ listing }) => listingKey(listing))), [filtered]);
  const closeDuplicates = useCallback(() => setDuplicatesOpen(false), []);

  const centerMapOn = useCallback((key: string, lat: number, lon: number) => {
    setSelected(key);
    setMapCenterTarget((current) => ({
      key,
      lat,
      lon,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);

  /** A listing merged by a "same" answer is shown as the listing it joined. */
  const locateReviewed = useCallback((key: string, lat: number, lon: number) => {
    const shown = listingsByKey.get(shownKey({ leadOf }, key));
    if (shown?.lat != null && shown.lon != null) centerMapOn(listingKey(shown), shown.lat, shown.lon);
    else centerMapOn(key, lat, lon);
  }, [centerMapOn, listingsByKey, leadOf]);

  return (
    <>
      <header className={styles.header}>
        <h1>Soka Rental Scorer</h1>
        <span className={styles.subtitle}>
          草加市・越谷市・川口市・葛飾区 — weighted 0–100 scoring · nearest private school &amp; nearest mosque
        </span>
        <span className={styles.subtitle}>
          {filtered.length} / {available.length} listings
          {newCount > 0 && ` · ${newCount} new`}
          {soldCount > 0 && ` · ${soldCount} sold`}
          {rentedOutCount > 0 && ` · ${rentedOutCount} rented out${filters.rentedOut === "hide" ? " (hidden)" : ""}`}
          {urCount > 0 && ` · ${urCount} UR${filters.ur === "hide" ? " (hidden)" : ""}`}
          {markSummary.candidates > 0 && ` · ★${markSummary.candidates} shortlisted`}
          {markSummary.ruledOut > 0 && ` · ✕${markSummary.ruledOut} ruled out`}
        </span>
        <button
          type="button"
          className={`secondary ${styles.headerButton}`}
          onClick={() => setDuplicatesOpen((open) => !open)}
          aria-expanded={duplicatesOpen}
          title="Listings that may be the same home on two portals: check and mark them"
        >
          ⧉ Possible duplicates{pendingDuplicates != null && ` · ${pendingDuplicates}`}
        </button>
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
            agencyGazetteer={agencyGazetteer}
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
            presets={presets}
            onApplyPreset={applyPreset}
            onSavePreset={(label) => savePreset(config, label)}
            onDeletePreset={deletePreset}
          />
          <PlacePanel
            catalog={catalog}
            selection={selection}
            onToggle={togglePlace}
            onSetPlaces={setPlaces}
            onReset={resetPlaces}
          />
          <AddListingForm catalog={catalog} onAdd={addListing} />
        </aside>
        <section className={styles.main}>
          <MapView
            items={filtered}
            reference={reference}
            scoredPois={scoredPois}
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
            newWithinDays={filters.newWithinDays}
            ringCenters={ringCenters}
            ringMetresPerMinute={travelSpeed(config) / config.detourFactor}
            travelMode={config.travelMode}
            walking={walking}
            areas={mapAreas.areas}
            urVacancies={urVacancies}
            onSetAreas={mapAreas.setAreas}
            onResetAreas={mapAreas.resetAreas}
            language={mapAreas.language}
            onSetLanguage={mapAreas.setLanguage}
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
            rankMoves={rankMoves}
            newWithinDays={filters.newWithinDays}
            emptyState={noMatches}
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
      {duplicatesOpen && (
        <DuplicateReview
          pairs={duplicatePairs}
          listingsByKey={unmergedByKey}
          decisions={duplicateDecisions}
          resolved={resolvedDuplicates}
          visibleKeys={visibleKeys}
          onDecide={decideDuplicate}
          onUndo={undoDuplicate}
          onLocate={locateReviewed}
          onClose={closeDuplicates}
        />
      )}
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
