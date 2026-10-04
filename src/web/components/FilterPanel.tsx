/**
 * Sidebar panel for filtering the listing set before scoring/ranking.
 * The everyday filters (min score, city, rent, rooms, size, parking) stay
 * open at the top; the neighbourhood (町名) picker and less-used refinements
 * fold into collapsible sections whose headers show their current value.
 */
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  activeFilterCount,
  areaOptions,
  cityOptions,
  layoutOptions,
  type ListingFilters,
} from "../../domain/filters";
import { MARK_FILTERS, summarizeMarks, type MarkMap } from "../../domain/marks";
import { listingKey } from "../../domain/listingKey";
import type { EnrichedListing } from "../../domain/types";
import { cityLabel, type ReferenceCity } from "../../domain/referenceData";
import styles from "./FilterPanel.module.css";
import appStyles from "../App.module.css";

interface Props {
  listings: readonly EnrichedListing[];
  /** Reference cities, for labelling the city chips. */
  cities: readonly ReferenceCity[];
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

/** Summary of the lifecycle chips for the collapsed "Listing status" header. */
function statusSummary(filters: ListingFilters): string {
  const parts: string[] = [];
  if (filters.status !== "all") parts.push(filters.status === "active" ? "active only" : "sold only");
  if (filters.rentedOut !== "hide") parts.push(filters.rentedOut === "show" ? "+ rented out" : "rented out only");
  if (filters.newOnly) parts.push("new only");
  return parts.length ? parts.join(" · ") : "default";
}

/**
 * A collapsible filter group. Starts open when its filter is active so a
 * reload never hides a constraint that is narrowing the results.
 */
function Section({
  title,
  summary,
  active,
  nested = false,
  children,
}: {
  title: string;
  summary: string;
  active: boolean;
  nested?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(active);
  return (
    <details
      className={`${styles.section} ${nested ? styles.nested : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={styles.sectionName}>{title}</span>
        <span className={`${styles.sectionValue} ${active ? styles.sectionActive : ""}`}>{summary}</span>
      </summary>
      <div className={styles.sectionBody}>{children}</div>
    </details>
  );
}

export function FilterPanel({ listings, cities: referenceCities, filters, onUpdate, onReset, marks, onClearMarks, matchCount }: Props) {
  const cities = useMemo(() => cityOptions(listings), [listings]);
  // Listings name their city in English ("Soka"); the reference catalog adds the local name.
  const cityLabels = useMemo(
    () => new Map(referenceCities.map((city) => [city.name, cityLabel(city)])),
    [referenceCities],
  );
  const labelFor = (city: string) => cityLabels.get(city) ?? city;
  const layouts = useMemo(() => layoutOptions(listings), [listings]);
  // Neighbourhood choices follow the selected city chips, preventing an
  // unrelated 100-area wall and making the city → neighbourhood hierarchy clear.
  const allAreas = useMemo(() => areaOptions(listings, filters.cities), [listings, filters.cities]);
  const [areaQuery, setAreaQuery] = useState("");

  const activeCount = activeFilterCount(filters);
  const statusActive = filters.status !== "all" || filters.rentedOut !== "hide" || filters.newOnly;
  const markFilterLabel = MARK_FILTERS.find(({ key }) => key === filters.markFilter)?.label ?? "all";

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

      {/* Min score: the ranking threshold, always in view. */}
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

      {/* Location: city chips up front; the neighbourhood picker folds away. */}
      <div className={styles.group}>
        <div className={styles.groupLabel}>City</div>
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
              {labelFor(city)}
            </button>
          ))}
        </div>

        <Section
          title="Neighbourhood (町名)"
          summary={
            filters.areas.length
              ? `${filters.areaMode === "include" ? "only" : "not"} ${filters.areas.length}`
              : "any"
          }
          active={filters.areas.length > 0}
          nested
        >
          <div className={styles.groupLabel}>
            <span className={styles.help}>
              in {filters.cities.length ? filters.cities.map(labelFor).join(" + ") : "all cities"}
            </span>
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
        </Section>
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

      {/* Less-used refinements fold away; each summary shows its current value. */}

      {/* Lifecycle: new discoveries vs sold listings */}
      <Section title="Listing status" summary={statusSummary(filters)} active={statusActive}>
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
        </div>
        <div className={`${styles.chips} ${styles.chipRow}`}>
          {(["hide", "show", "only"] as const).map((mode) => (
            <button
              key={`rented-${mode}`}
              className={`${styles.chip} ${filters.rentedOut === mode ? styles.on : ""}`}
              onClick={() => onUpdate({ rentedOut: mode })}
              title={
                mode === "hide"
                  ? "Hide properties that every portal has taken down (rented out)"
                  : mode === "show"
                    ? "Show rented-out properties, marked"
                    : "Only properties that every portal has taken down"
              }
            >
              {mode === "hide" ? "hide rented out" : mode === "show" ? "show rented out" : "rented out only"}
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
      </Section>

      {/* Decision marks: the user's own rulings (shortlist, taken, …) */}
      <Section
        title="My decisions"
        summary={`${markFilterLabel}${markSummary.total > 0 ? ` · ${markSummary.total} marked` : ""}`}
        active={filters.markFilter !== "all"}
      >
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
            Decision column of any row.{" "}
            <button
              className={styles.clearMarks}
              onClick={() => {
                if (window.confirm(`Remove all ${markSummary.total} decision marks?`)) onClearMarks();
              }}
              title="Remove every decision mark"
            >
              clear marks
            </button>
          </p>
        )}
      </Section>
    </section>
  );
}
