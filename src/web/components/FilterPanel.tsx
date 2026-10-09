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
  agencyOptions,
  areaOptions,
  type AgencyStoreOption,
  cityOptions,
  layoutOptions,
  type ListingFilters,
} from "../../domain/filters";
import { MAX_NEW_WINDOW_DAYS, MIN_NEW_WINDOW_DAYS, NEW_LISTING_WINDOW_DAYS } from "../../domain/lifecycle";
import { MARK_FILTERS, summarizeMarks, type MarkMap } from "../../domain/marks";
import { listingKey } from "../../domain/listingKey";
import type { EnrichedListing } from "../../domain/types";
import { cityLabel, type ReferenceCity } from "../../domain/referenceData";
import type { AgencyGazetteer } from "../../domain/agencyNames";
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
  /** Stations and cities, for where each agency store is. */
  agencyGazetteer: AgencyGazetteer;
}

/** "Best Housing Co., Ltd. · ベストハウジング"; the Japanese alone when part of the name has no English. */
const bilingual = (en: string | null, ja: string) => (en && en !== ja ? `${en} · ${ja}` : ja);

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
  if (filters.newOnly) parts.push(`new only (${filters.newWithinDays}d)`);
  else if (filters.newWithinDays !== NEW_LISTING_WINDOW_DAYS) parts.push(`new = ${filters.newWithinDays}d`);
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

export function FilterPanel({ listings, cities: referenceCities, filters, onUpdate, onReset, marks, onClearMarks, matchCount, agencyGazetteer }: Props) {
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
  const agencies = useMemo(() => agencyOptions(listings, agencyGazetteer), [listings, agencyGazetteer]);
  const knownAgencyCount = useMemo(() => agencies.reduce((sum, group) => sum + group.count, 0), [agencies]);
  const [agencyQuery, setAgencyQuery] = useState("");

  const activeCount = activeFilterCount(filters);
  const statusActive =
    filters.status !== "all" ||
    filters.rentedOut !== "hide" ||
    filters.newOnly ||
    filters.newWithinDays !== NEW_LISTING_WINDOW_DAYS;
  const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
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

  /** "Koshigaya · 越谷 · 北越谷店": where a store is, then its branch. */
  const storeLabel = (store: AgencyStoreOption) =>
    [store.city ? cityLabel(store.city) : null, store.branch].filter(Boolean).join(" · ") || "main store";

  // A chain or agency matches its stores' text too, so "草加" or "Soka" finds every agency with a Soka store.
  const shownAgencies = useMemo(() => {
    const q = agencyQuery.trim().toLowerCase();
    if (!q) return agencies;
    const hit = (...texts: (string | null | undefined)[]) => texts.some((text) => text?.toLowerCase().includes(q));
    const storeHit = (store: AgencyStoreOption) => hit(store.name, store.branch, store.place, store.city?.name, store.city?.nameLocal);
    return agencies.flatMap((brand) => {
      if (hit(brand.brand, brand.brandEn)) return [brand];
      const kept = brand.agencies.flatMap((agency) => {
        if (hit(agency.agency, agency.agencyEn)) return [agency];
        const stores = agency.stores.filter(storeHit);
        return stores.length ? [{ ...agency, stores }] : [];
      });
      return kept.length ? [{ ...brand, agencies: kept }] : [];
    });
  }, [agencies, agencyQuery]);

  // How many stores each agency has, before a search narrows its list.
  const storeTotals = useMemo(() => new Map(agencies.flatMap((brand) => brand.agencies.map((agency) => [agency.key, agency.stores.length] as const))), [agencies]);

  const agencyLabels = useMemo(() => new Map(agencies.flatMap((brand) => [
    ...(brand.key && brand.brand ? [[brand.key, `${bilingual(brand.brandEn, brand.brand)} (all)`] as const] : []),
    ...brand.agencies.flatMap((agency) => [
      [agency.key, bilingual(agency.agencyEn, agency.agency)] as const,
      ...agency.stores.map((store) => [store.key, `${agency.agencyEn ?? agency.agency} — ${storeLabel(store)}`] as const),
    ]),
  ])), [agencies]);

  const toggleAgency = (key: string) => {
    const next = filters.agencies.includes(key)
      ? filters.agencies.filter((k) => k !== key)
      : [...filters.agencies, key];
    onUpdate({ agencies: next });
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

      {/* Agency: a whole brand or single stores, like the neighbourhood picker. */}
      <div className={styles.group}>
        <Section
          title="Agency (仲介業者)"
          summary={
            filters.agencies.length
              ? `${filters.agencyMode === "include" ? "only" : "not"} ${filters.agencies.length}`
              : "any"
          }
          active={filters.agencies.length > 0}
        >
          <div className={styles.groupLabel}>
            <span className={styles.help}>
              known for {knownAgencyCount} of {listings.length} listings
            </span>
            <div className={styles.modeToggle}>
              <button
                className={filters.agencyMode === "include" ? styles.on : ""}
                onClick={() => onUpdate({ agencyMode: "include" })}
                title="Keep only listings known to be advertised by the selected agencies"
              >
                include
              </button>
              <button
                className={filters.agencyMode === "exclude" ? styles.on : ""}
                onClick={() => onUpdate({ agencyMode: "exclude" })}
                title="Drop listings advertised by the selected agencies; listings with no known agency stay"
              >
                exclude
              </button>
            </div>
          </div>

          {filters.agencies.length > 0 && (
            <div className={styles.selectedRow}>
              <span>
                {filters.agencyMode === "include" ? "Only: " : "Not: "}
                {filters.agencies.map((key) => agencyLabels.get(key) ?? key.replace(/^(brand|agency|store):/, "")).join("、")}
              </span>
              <button className={styles.clearAreas} onClick={() => onUpdate({ agencies: [] })}>
                ×
              </button>
            </div>
          )}

          <input
            className={styles.search}
            type="search"
            placeholder="Search agency, branch or city (English or 日本語)…"
            value={agencyQuery}
            onChange={(e) => setAgencyQuery(e.target.value)}
          />
          <div className={styles.agencyList}>
            {shownAgencies.map((brand) => (
              <div key={brand.key ?? "independent"} className={styles.agencyGroup}>
                {brand.key && brand.brand && (
                  <label className={styles.areaItem}>
                    <input
                      type="checkbox"
                      checked={filters.agencies.includes(brand.key)}
                      onChange={() => toggleAgency(brand.key!)}
                    />
                    <strong>{bilingual(brand.brandEn, brand.brand)}</strong>
                    <span className={styles.agencyMeta}>{brand.count}</span>
                  </label>
                )}
                {brand.agencies.map((agency) => {
                  // One store: say where it is on the agency's own row.
                  const single = storeTotals.get(agency.key) === 1 ? agency.stores[0] : null;
                  return (
                    <div key={agency.key} className={brand.key ? styles.agencyStore : undefined}>
                      <label className={styles.areaItem} title={agency.stores.map((store) => store.name).join("\n")}>
                        <input
                          type="checkbox"
                          checked={filters.agencies.includes(agency.key)}
                          onChange={() => toggleAgency(agency.key)}
                        />
                        {brand.key ? bilingual(agency.agencyEn, agency.agency) : <strong>{bilingual(agency.agencyEn, agency.agency)}</strong>}
                        <span className={styles.agencyMeta}>
                          {[single?.city ? cityLabel(single.city) : null, agency.count].filter((part) => part != null).join(" · ")}
                        </span>
                      </label>
                      {!single && agency.stores.map((store) => (
                        <label key={store.key} className={`${styles.areaItem} ${styles.agencyStore}`} title={store.name}>
                          <input
                            type="checkbox"
                            checked={filters.agencies.includes(store.key)}
                            onChange={() => toggleAgency(store.key)}
                          />
                          {storeLabel(store)}
                          <span className={styles.agencyMeta}>{store.count}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
            {shownAgencies.length === 0 && <span className={styles.empty}>no matches</span>}
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
            title={`Only listings first seen in the last ${dayWord(filters.newWithinDays)}`}
          >
            ✦ new only
          </button>
        </div>
        <label className={`${styles.groupLabel} ${styles.newWindow}`}>
          New = first seen within
          <span className={styles.scoreVal}>{dayWord(filters.newWithinDays)}</span>
        </label>
        <input
          className={styles.slider}
          type="range"
          min={MIN_NEW_WINDOW_DAYS}
          max={MAX_NEW_WINDOW_DAYS}
          step={1}
          value={filters.newWithinDays}
          onChange={(e) => onUpdate({ newWithinDays: Number(e.target.value) })}
          aria-label="Days a listing counts as new"
          title="How long after it is first seen a listing counts as new — for the new-only filter, NEW badges, map rings and the header count"
        />
      </Section>

      {/* UR賃貸: public housing leased by UR itself, on its own terms */}
      <Section
        title="UR housing"
        summary={filters.ur === "show" ? "shown" : filters.ur === "hide" ? "hidden" : "UR only"}
        active={filters.ur !== "show"}
      >
        <div className={styles.chips}>
          {(["show", "hide", "only"] as const).map((mode) => (
            <button
              key={`ur-${mode}`}
              className={`${styles.chip} ${filters.ur === mode ? styles.on : ""}`}
              onClick={() => onUpdate({ ur: mode })}
              title={
                mode === "show"
                  ? "Show UR rooms with the rest"
                  : mode === "hide"
                    ? "Hide UR rooms (UR's own ads and portal ads for them)"
                    : "Only UR rooms"
              }
            >
              {mode === "show" ? "show UR" : mode === "hide" ? "hide UR" : "UR only"}
            </button>
          ))}
        </div>
        <p className={styles.help}>
          UR賃貸 leases directly: no key money, agency fee, guarantor or renewal fee, and a two-month deposit. The map's
          UR estates layer shows every estate, vacant or full, whatever this filter says.
        </p>
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
