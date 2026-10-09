/**
 * The map's area chooser: which cities the main map draws, and whether place
 * names read in English or Japanese.
 *
 * A small overview map of the whole region shows every municipality; the
 * chosen ones are highlighted, and clicking one adds or removes it. Below it,
 * a checkbox list by prefecture does the same, a prefecture's own checkbox
 * taking all of its cities at once. Hovering a city in either place
 * highlights it in the other.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReferenceBoundary, ReferenceCity } from "../../domain/referenceData";
import {
  joinSegments,
  longitudeScale,
  padExtent,
  pointInGeometry,
  polygonsOf,
  type BorderSegment,
  type Extent,
} from "../../domain/mapGeometry";
import {
  cityName,
  groupByPrefecture,
  matchesCity,
  prefectureName,
  prefectureSelection,
  setPrefecture,
  toggleCity,
  type NameLanguage,
  type PrefectureGroup,
} from "../../domain/mapAreas";
import styles from "./AreaPicker.module.css";

export interface AreaCity {
  city: ReferenceCity;
  boundaries: readonly ReferenceBoundary[];
  extent: Extent;
}

interface Props {
  cities: readonly AreaCity[];
  /** Border edges between prefectures, for the overview's outlines. */
  borders: readonly BorderSegment[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  onReset: () => void;
  language: NameLanguage;
  onLanguage: (language: NameLanguage) => void;
  onClose: () => void;
}

const WIDTH = 300;
const HEIGHT = 250;
const PADDING = 6;

const COLOR_PROPERTIES = {
  fill: "--rs-map-neighbour-fill",
  line: "--rs-map-neighbour-line",
  border: "--rs-map-prefecture-line",
  selected: "--rs-map-area-selected",
  selectedLine: "--rs-map-focus-line",
  hovered: "--rs-map-area-hovered",
} as const;

export function AreaPicker({ cities, borders, selected, onChange, onReset, language, onLanguage, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(() => groupByPrefecture(cities.map((entry) => entry.city)), [cities]);
  const byId = useMemo(() => new Map(cities.map((entry) => [entry.city.id, entry])), [cities]);

  // Overview projection: the whole region, north up, true proportions.
  const { project, unproject } = useMemo(() => {
    const extent = padExtent(cities.reduce<Extent>((all, { extent: e }) => ({
      minLon: Math.min(all.minLon, e.minLon), maxLon: Math.max(all.maxLon, e.maxLon),
      minLat: Math.min(all.minLat, e.minLat), maxLat: Math.max(all.maxLat, e.maxLat),
    }), { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity }));
    const kx = longitudeScale(extent);
    const scale = Math.min((WIDTH - 2 * PADDING) / ((extent.maxLon - extent.minLon) * kx), (HEIGHT - 2 * PADDING) / (extent.maxLat - extent.minLat));
    const ox = (WIDTH - scale * (extent.maxLon - extent.minLon) * kx) / 2;
    const oy = (HEIGHT - scale * (extent.maxLat - extent.minLat)) / 2;
    return {
      project: (lon: number, lat: number) => [ox + (lon - extent.minLon) * kx * scale, HEIGHT - (oy + (lat - extent.minLat) * scale)] as const,
      unproject: (x: number, y: number) => [extent.minLon + (x - ox) / (kx * scale), extent.minLat + (HEIGHT - y - oy) / scale] as const,
    };
  }, [cities]);

  // One path per city, plus every outline and the prefecture borders, built once.
  const paths = useMemo(() => {
    if (typeof Path2D === "undefined") return null;
    const trace = (path: Path2D, ring: readonly (readonly [number, number])[], close: boolean) => {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        i === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
      });
      if (close) path.closePath();
    };
    const byCity = new Map<string, Path2D>();
    const outlines = new Path2D();
    for (const { city, boundaries } of cities) {
      const path = new Path2D();
      for (const boundary of boundaries) {
        for (const polygon of polygonsOf(boundary.geometry)) for (const ring of polygon) trace(path, ring, true);
      }
      byCity.set(city.id, path);
      outlines.addPath(path);
    }
    const prefectureBorders = new Path2D();
    for (const line of joinSegments(borders)) trace(prefectureBorders, line, false);
    return { byCity, outlines, prefectureBorders };
  }, [cities, borders, project]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !paths) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== WIDTH * dpr) canvas.width = WIDTH * dpr;
    if (canvas.height !== HEIGHT * dpr) canvas.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const style = getComputedStyle(canvas);
    const color = Object.fromEntries(Object.entries(COLOR_PROPERTIES)
      .map(([key, property]) => [key, style.getPropertyValue(property).trim()])) as Record<keyof typeof COLOR_PROPERTIES, string>;

    ctx.fillStyle = color.fill;
    ctx.fill(paths.outlines, "evenodd");
    ctx.fillStyle = color.selected;
    for (const id of selected) {
      const path = paths.byCity.get(id);
      if (path) ctx.fill(path, "evenodd");
    }
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = color.line;
    ctx.stroke(paths.outlines);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color.border;
    ctx.stroke(paths.prefectureBorders);
    const hover = hovered ? paths.byCity.get(hovered) : undefined;
    if (hover) {
      ctx.fillStyle = color.hovered;
      ctx.fill(hover, "evenodd");
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color.selectedLine;
      ctx.stroke(hover);
    }
  }, [paths, selected, hovered]);

  const cityAt = (event: React.MouseEvent<HTMLCanvasElement>): string | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const [lon, lat] = unproject(((event.clientX - rect.left) / rect.width) * WIDTH, ((event.clientY - rect.top) / rect.height) * HEIGHT);
    for (const { city, boundaries, extent } of cities) {
      if (lon < extent.minLon || lon > extent.maxLon || lat < extent.minLat || lat > extent.maxLat) continue;
      if (boundaries.some((boundary) => pointInGeometry([lon, lat], boundary.geometry))) return city.id;
    }
    return null;
  };

  const hoveredCity = hovered ? byId.get(hovered)?.city : undefined;
  const q = query.trim();
  const shown = groups
    .map((group) => ({ group, cities: group.cities.filter((city) => matchesCity(city, group, q)) }))
    .filter(({ cities: matching }) => matching.length > 0);

  return (
    <div className={styles.panel} role="dialog" aria-label="Map areas">
      <div className={styles.header}>
        <strong>Areas</strong>
        <span className={styles.count}>{selected.size} shown</span>
        <div className={styles.language} role="group" aria-label="Name language">
          <button type="button" aria-pressed={language === "en"} onClick={() => onLanguage("en")}>EN</button>
          <button type="button" aria-pressed={language === "ja"} onClick={() => onLanguage("ja")}>日本語</button>
        </div>
        <button type="button" className={styles.close} aria-label="Close areas" onClick={onClose}>×</button>
      </div>

      <div className={styles.overview}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          aria-label="Click a municipality to show or hide it"
          onPointerMove={(event) => setHovered(cityAt(event))}
          onPointerLeave={() => setHovered(null)}
          onClick={(event) => {
            const id = cityAt(event);
            if (id) onChange(toggleCity(selected, id));
          }}
        />
        <span className={styles.tooltip} aria-live="polite">
          {hoveredCity
            ? `${cityName(hoveredCity, language)}${language === "en" && hoveredCity.prefectureEn ? `, ${hoveredCity.prefectureEn}` : language === "ja" ? `（${hoveredCity.prefecture ?? ""}）` : ""}`
            : "Click a municipality to show or hide it"}
        </span>
      </div>

      <div className={styles.actions}>
        <button type="button" onClick={onReset}>Search area</button>
        <button type="button" onClick={() => onChange(new Set(cities.map((entry) => entry.city.id)))}>All</button>
        <button type="button" onClick={() => onChange(new Set())}>None</button>
        <input
          type="search"
          className={styles.search}
          placeholder={language === "en" ? "Find a city…" : "市区町村を検索…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <ul className={styles.prefectures}>
        {shown.map(({ group, cities: matching }) => (
          <PrefectureRow
            key={group.name}
            group={group}
            cities={matching}
            expanded={q !== "" || open.has(group.name)}
            onExpand={() => setOpen((current) => toggleCity(current, group.name))}
            selected={selected}
            onChange={onChange}
            language={language}
            onHover={setHovered}
          />
        ))}
      </ul>
    </div>
  );
}

function PrefectureRow({
  group,
  cities,
  expanded,
  onExpand,
  selected,
  onChange,
  language,
  onHover,
}: {
  group: PrefectureGroup;
  cities: readonly ReferenceCity[];
  expanded: boolean;
  onExpand: () => void;
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  language: NameLanguage;
  onHover: (id: string | null) => void;
}) {
  const state = prefectureSelection(group, selected);
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = state === "some";
  }, [state]);
  const count = group.cities.filter((city) => selected.has(city.id)).length;

  return (
    <li className={styles.prefecture}>
      <div className={styles.prefectureRow}>
        <button type="button" className={styles.expand} aria-expanded={expanded} aria-label={`Show ${prefectureName(group, language)} cities`} onClick={onExpand}>
          {expanded ? "▾" : "▸"}
        </button>
        <label>
          <input
            ref={checkbox}
            type="checkbox"
            checked={state === "all"}
            onChange={(event) => onChange(setPrefecture(selected, group, event.target.checked))}
          />
          <span className={styles.prefectureName}>{prefectureName(group, language)}</span>
        </label>
        <span className={styles.count}>{count}/{group.cities.length}</span>
      </div>
      {expanded && (
        <div className={styles.cities}>
          {cities.map((city) => (
            <label key={city.id} onPointerEnter={() => onHover(city.id)} onPointerLeave={() => onHover(null)}>
              <input type="checkbox" checked={selected.has(city.id)}
                onChange={() => onChange(toggleCity(selected, city.id))} />
              <span>{cityName(city, language)}</span>
            </label>
          ))}
        </div>
      )}
    </li>
  );
}
