/**
 * Sidebar panel for filtering the listing set before scoring/ranking.
 * The area (町名) filter is the centrepiece: pick neighbourhoods and choose
 * whether to keep only those (include) or drop them (exclude).
 */
import { useMemo, useState } from "react";
import {
  activeFilterCount,
  areaOptions,
  cityOptions,
  layoutOptions,
  type ListingFilters,
} from "../domain/filters";
import { MARK_FILTERS, summarizeMarks, type MarkMap } from "../domain/marks";
import { listingKey } from "../domain/listingKey";
import type { EnrichedListing } from "../types";
import styles from "./FilterPanel.module.css";
import appStyles from "../App.module.css";

interface Props {
  listings: readonly EnrichedListing[];
  filters: ListingFilters;
  onUpdate: (patch: Partial<ListingFilters>) => void;
  onReset: () => void;
  /** The user's decision marks (for the decisions group + its counts). */
  marks: MarkMap;
  onClearMarks: () => void;
  /** How many listings survive the current filters (for the count line). */
  matchCount: number;
}

const numberOrNull = (raw: string): number | null => {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const CITY_LABELS: Record<string, string> = {
  Soka: "Soka · 草加",
  Koshigaya: "Koshigaya · 越谷",
  Kawaguchi: "Kawaguchi · 川口",
};
const cityLabel = (city: string) => CITY_LABELS[city] ?? city;

export function FilterPanel({ listings, filters, onUpdate, onReset, marks, onClearMarks, matchCount }: Props) {
  const cities = useMemo(() => cityOptions(listings), [listings]);
  const layouts = useMemo(() => layoutOptions(listings), [listings]);
  // Neighbourhood choices follow the selected city chips, preventing an
  // unrelated 100-area wall and making the city → neighbourhood hierarchy clear.
  const allAreas = useMemo(() => areaOptions(listings, filters.cities), [listings, filters.cities]);
  const [areaQuery, setAreaQuery] = useState("");

  const activeCount = activeFilterCount(filters);

  /** Decision-mark headline numbers over the current listing set. */
  const markSummary = useMemo(
    () => summarizeMarks(listings.map((listing) => marks[listingKey(listing)])),
    [listings, marks],
  );

  const shownAreas = useMemo(() => {
    const q = areaQuery.trim();
    const base = q ? allAreas.filter((a) => a.includes(q)) : allAreas;
    // Keep selected areas visible even when they don't match the search.
    const selectedMissing = filters.areas.filter((a) => !base.includes(a));
    return [...selectedMissing, ...base].slice(0, 60);
  }, [allAreas, areaQuery, filters.areas]);

  const toggleArea = (area: string) => {
    const next = filters.areas.includes(area)
      ? filters.areas.filter((a) => a !== area)
      : [...filters.areas, area];
    onUpdate({ areas: next });
  };

  const toggleCity = (city: string) => {
    const next = filters.cities.includes(city)
      ? filters.cities.filter((c) => c !== city)
      : [...filters.cities, city];
    // Clear neighbourhoods when city scope changes; otherwise an invisible
    // selection from the previous city can make the result set mysteriously empty.
    onUpdate({ cities: next, areas: [] });
  };

  const toggleLayout = (layout: string) => {
    const next = filters.layouts.includes(layout)
      ? filters.layouts.filter((l) => l !== layout)
      : [...filters.layouts, layout];
    onUpdate({ layouts: next });
  };

  return (
    <section className={appStyles.card}>
      <h2 className={appStyles.cardTitle}>
        Filters
        {activeCount > 0 && <span className={styles.badge}>{activeCount}</span>}
        <button className={`secondary ${styles.reset}`} onClick={onReset}>
          clear
        </button>
      </h2>

      <p className={styles.count}>
        {matchCount} of {listings.length} listings match
      </p>

      {/* Lifecycle: new discoveries vs sold listings */}
      <div className={styles.group}>
        <div className={styles.groupLabel}>Status</div>
        <div className={styles.chips}>
          {(["all", "active", "sold"] as const).map((mode) => (
            <button
              key={mode}
              className={`${styles.chip} ${filters.status === mode ? styles.on : ""}`}
              onClick={() => onUpdate({ status: mode })}
              title={
                mode === "all"
                  ? "Show active and sold listings"
                  : mode === "active"
                    ? "Hide listings that are no longer advertised"
                    : "Only listings that are no longer advertised"
              }
            >
              {mode === "all" ? "all" : mode === "active" ? "active only" : "sold only"}
            </button>
          ))}
          <button
            className={`${styles.chip} ${styles.chipNew} ${filters.newOnly ? styles.on : ""}`}
            onClick={() => onUpdate({ newOnly: !filters.newOnly })}
            title="Only listings first seen in the last 14 days"
          >
            ✦ new only
          </button>
        </div>
      </div>

      {/* Decision marks: the user's own rulings (shortlist, taken, …) */}
      <div className={styles.group}>
        <div className={styles.groupLabel}>
          My decisions
          {markSummary.total > 0 && (
            <button
              className={styles.clearMarks}
              onClick={() => {
                if (window.confirm(`Remove all ${markSummary.total} decision marks?`)) onClearMarks();
              }}
              title="Remove every decision mark"
            >
              clear marks
            </button>
          )}
        </div>
        <div className={styles.chips}>
          {MARK_FILTERS.map(({ key, label, hint }) => (
            <button
              key={key}
              className={`${styles.chip} ${filters.markFilter === key ? styles.on : ""}`}
              onClick={() => onUpdate({ markFilter: key })}
              title={hint}
            >
              {label}
            </button>
          ))}
        </div>
        {markSummary.total > 0 && (
          <p className={styles.help}>
            ★ {markSummary.candidates} candidate{markSummary.candidates === 1 ? "" : "s"} · ✕{" "}
            {markSummary.ruledOut} ruled out · {markSummary.total} marked — pick a mark from the
            Decision column of any row.
          </p>
        )}
      </div>

      {/* Location is one hierarchical control: city first, neighbourhood second. */}
      <div className={`${styles.group} ${styles.locationGroup}`}>
        <div className={styles.locationTitle}>Location</div>
        <p className={styles.help}>1. Choose city (none selected means all cities)</p>
        <div className={styles.chips}>
          <button
            className={`${styles.chip} ${filters.cities.length === 0 ? styles.on : ""}`}
            onClick={() => onUpdate({ cities: [], areas: [] })}
          >
            All cities
          </button>
          {cities.map((city) => (
            <button
              key={city}
              className={`${styles.chip} ${filters.cities.includes(city) ? styles.on : ""}`}
              onClick={() => toggleCity(city)}
            >
              {cityLabel(city)}
            </button>
          ))}
        </div>

        <div className={styles.areaDivider} />
        <p className={styles.help}>
          2. Optional neighbourhood (町名) · showing {filters.cities.length ? filters.cities.map(cityLabel).join(" + ") : "all cities"}
        </p>
        <div className={styles.groupLabel}>
          Neighbourhood mode
          <div className={styles.modeToggle}>
            <button
              className={filters.areaMode === "include" ? styles.on : ""}
              onClick={() => onUpdate({ areaMode: "include" })}
              title="Keep only listings in the selected areas"
            >
              include
            </button>
            <button
              className={filters.areaMode === "exclude" ? styles.on : ""}
              onClick={() => onUpdate({ areaMode: "exclude" })}
              title="Drop listings in the selected areas"
            >
              exclude
            </button>
          </div>
        </div>

        {filters.areas.length > 0 && (
          <div className={styles.selectedRow}>
            <span>
              {filters.areaMode === "include" ? "Only: " : "Not: "}
              {filters.areas.join("、")}
            </span>
            <button className={styles.clearAreas} onClick={() => onUpdate({ areas: [] })}>
              ×
            </button>
          </div>
        )}

        <input
          className={styles.search}
          type="search"
          placeholder="Search neighbourhoods (町名)…"
          value={areaQuery}
          onChange={(e) => setAreaQuery(e.target.value)}
        />
        <div className={styles.areaList}>
          {shownAreas.map((area) => (
            <label key={area} className={styles.areaItem}>
              <input
                type="checkbox"
                checked={filters.areas.includes(area)}
                onChange={() => toggleArea(area)}
              />
              {area}
            </label>
          ))}
          {shownAreas.length === 0 && <span className={styles.empty}>no matches</span>}
        </div>
      </div>

      {/* Rent */}
      <div className={styles.group}>
        <div className={styles.groupLabel}>Rent (¥/mo, incl. fees)</div>
        <div className={styles.range}>
          <input
            type="number"
            placeholder="min"
            step={5000}
            value={filters.rentMin ?? ""}
            onChange={(e) => onUpdate({ rentMin: numberOrNull(e.target.value) })}
          />
          <span>–</span>
          <input
            type="number"
            placeholder="max"
            step={5000}
            value={filters.rentMax ?? ""}
            onChange={(e) => onUpdate({ rentMax: numberOrNull(e.target.value) })}
          />
        </div>
      </div>

      {/* Size */}
      <div className={styles.group}>
        <div className={styles.groupLabel}>Size (㎡)</div>
        <div className={styles.range}>
          <input
            type="number"
            placeholder="min"
            value={filters.sizeMin ?? ""}
            onChange={(e) => onUpdate({ sizeMin: numberOrNull(e.target.value) })}
          />
          <span>–</span>
          <input
            type="number"
            placeholder="max"
            value={filters.sizeMax ?? ""}
            onChange={(e) => onUpdate({ sizeMax: numberOrNull(e.target.value) })}
          />
        </div>
      </div>

      {/* Layout family */}
      {layouts.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupLabel}>Rooms (layout)</div>
          <div className={styles.chips}>
            {layouts.map((layout) => (
              <button
                key={layout}
                className={`${styles.chip} ${filters.layouts.includes(layout) ? styles.on : ""}`}
                onClick={() => toggleLayout(layout)}
              >
                {layout}+
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Parking */}
      <div className={styles.group}>
        <div className={styles.groupLabel}>駐車場 Parking</div>
        <div className={styles.chips}>
          {(["any", "required", "free"] as const).map((mode) => (
            <button
              key={mode}
              className={`${styles.chip} ${filters.parking === mode ? styles.on : ""}`}
              onClick={() => onUpdate({ parking: mode })}
              title={
                mode === "any"
                  ? "No parking constraint"
                  : mode === "required"
                    ? "A space must be available"
                    : "A space must be available at no monthly charge"
              }
            >
              {mode === "any" ? "any" : mode === "required" ? "must have" : "free only"}
            </button>
          ))}
        </div>
        <label className={styles.maxParking}>
          Max ¥/month
          <input
            type="number"
            placeholder="any"
            step={1000}
            value={filters.parkingMaxYen ?? ""}
            onChange={(e) => onUpdate({ parkingMaxYen: numberOrNull(e.target.value) })}
          />
        </label>
      </div>

      {/* Min score */}
      <div className={styles.group}>
        <div className={styles.groupLabel}>
          Min score <span className={styles.scoreVal}>{filters.minScore}</span>
        </div>
        <input
          className={styles.slider}
          type="range"
          min={0}
          max={100}
          step={1}
          value={filters.minScore}
          onChange={(e) => onUpdate({ minScore: Number(e.target.value) })}
        />
      </div>
    </section>
  );
}
