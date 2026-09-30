/**
 * Canvas map of Soka City and its northern neighbour Koshigaya (plus the
 * surrounding municipalities for context): city boundaries, stations,
 * elementary schools, the two POIs, and every geocoded listing coloured by
 * its current score.
 *
 * Interaction:
 *   - hover a dot            → highlights it + the matching table row (no scroll)
 *   - click a dot            → selects it; the table scrolls that row into view
 *   - scroll wheel           → zoom toward the cursor
 *   - drag                   → pan
 *   - +/−/⤢ buttons          → zoom in / out / reset
 *
 * The base projection is a plain equirectangular fit to the combined extent
 * of all boundaries; a separate view transform (scale + translation) layers
 * zoom and pan on top, so markers and labels keep a constant screen size.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scoreColor } from "../../domain/scoring";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS } from "../../domain/scoringConfig";
import { listingKey } from "../../domain/listingKey";
import { sourceListings as portalReferences } from "../../domain/listingDedup";
import { isNewListing, isSold } from "../../domain/lifecycle";
import { isRuledOut, LISTING_MARKS, type ListingMark, type MarkMap } from "../../domain/marks";
import {
  ELEMENTARY_SCHOOLS,
  MOSQUES,
  NEIGHBOR_BOUNDARIES,
  POINTS_OF_INTEREST,
  SOKA_BOUNDARY,
  STATIONS,
} from "../../domain/reference";
import type { ScoredRow } from "../../domain/scoring";
import styles from "./MapView.module.css";
import appStyles from "../App.module.css";

interface Props {
  items: ScoredRow[];
  hovered: string | null;
  onHover: (key: string | null) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  centerTarget: { key: string; lat: number; lon: number; request: number } | null;
  /** The user's decision marks, keyed by listingKey. */
  marks: MarkMap;
  onSetMark: (key: string, mark: ListingMark | null) => void;
}

interface Projected {
  x: number;
  y: number;
  key: string;
  row: ScoredRow;
}

/** Pan/zoom view transform: screen = base * scale + (tx, ty). */
interface View {
  scale: number;
  tx: number;
  ty: number;
}

const WIDTH = 1100;
const HEIGHT = 560;
const PADDING = 28;
const MIN_SCALE = 1;
const MAX_SCALE = 14;
const LOCATE_SCALE = 5;
const HIT_RADIUS = 12;
const DRAG_THRESHOLD = 4;
const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };

/**
 * Stations worth labelling: the Soka Tobu hubs plus the Koshigaya-side
 * stations near the POIs. Note: 松原団地駅 was renamed to
 * 獨協大学前〈草加松原〉 in 2017 — they are the same station.
 */
const LABELLED_STATIONS = new Set([
  "草加", "谷塚", "獨協大学前〈草加松原〉", "新田", "蒲生", "新越谷", "南越谷", "越谷", "北越谷",
]);

const CITY_LABEL_COLOR = "#94a3b8";

export const MapView = memo(function MapView({ items, hovered, onHover, selected, onSelect, centerTarget, marks, onSetMark }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Projected[]>([]);
  const [view, setView] = useState<View>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  /** Keys under the last clicked screen point; repeated clicks cycle them. */
  const [selectionCluster, setSelectionCluster] = useState<string[]>([]);
  // Pointer-interaction bookkeeping (refs so handlers stay stable).
  const drag = useRef<{ startX: number; startY: number; view: View; moved: boolean } | null>(null);

  // Base projection: fit the combined extent of Soka + all neighbour rings.
  const project = useMemo(() => {
    const allPts: [number, number][] = [
      ...SOKA_BOUNDARY,
      ...NEIGHBOR_BOUNDARIES.flatMap((c) => c.ring),
    ];
    const lons = allPts.map(([lon]) => lon);
    const lats = allPts.map(([, lat]) => lat);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const scale = Math.min(
      (WIDTH - 2 * PADDING) / (maxLon - minLon),
      (HEIGHT - 2 * PADDING) / (maxLat - minLat),
    );
    const offsetX = (WIDTH - scale * (maxLon - minLon)) / 2;
    const offsetY = (HEIGHT - scale * (maxLat - minLat)) / 2;
    return (lat: number, lon: number) => ({
      x: offsetX + (lon - minLon) * scale,
      y: HEIGHT - (offsetY + (lat - minLat) * scale),
    });
  }, []);

  // Compose base projection with the current view transform.
  const toScreen = useCallback(
    (lat: number, lon: number) => {
      const b = project(lat, lon);
      return { x: b.x * view.scale + view.tx, y: b.y * view.scale + view.ty };
    },
    [project, view],
  );

  const rowsByKey = useMemo(
    () => new Map(items.map((row) => [listingKey(row.listing), row])),
    [items],
  );
  const hoveredRow = hovered ? rowsByKey.get(hovered) ?? null : null;
  const selectedRow = selected ? rowsByKey.get(selected) ?? null : null;
  const selectedClusterIndex = selected == null ? -1 : selectionCluster.indexOf(selected);

  // Table-row locate buttons issue an explicit center request. Use the current
  // zoom when it is already useful; otherwise zoom in enough to identify the home.
  useEffect(() => {
    if (!centerTarget) return;
    setView((current) => {
      const scale = Math.max(current.scale, LOCATE_SCALE);
      const point = project(centerTarget.lat, centerTarget.lon);
      return {
        scale,
        tx: WIDTH / 2 - point.x * scale,
        ty: HEIGHT / 2 - point.y * scale,
      };
    });
    setSelectionCluster([]);
    canvasRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [centerTarget, project]);

  const cycleCluster = (direction: 1 | -1) => {
    if (selectionCluster.length < 2) return;
    const current = selectedClusterIndex >= 0 ? selectedClusterIndex : 0;
    const next = (current + direction + selectionCluster.length) % selectionCluster.length;
    onSelect(selectionCluster[next]);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.font = "11px sans-serif";

    const ring = (pts: readonly [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([lon, lat], i) => {
        const { x, y } = toScreen(lat, lon);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
    };

    // Neighbouring municipalities: faint fill, dashed outline.
    ctx.setLineDash([4, 4]);
    for (const city of NEIGHBOR_BOUNDARIES) {
      ring(city.ring);
      ctx.fillStyle = "#f6f7f9";
      ctx.fill();
      ctx.strokeStyle = "#d3d9e2";
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = CITY_LABEL_COLOR;
    ctx.font = "13px sans-serif";
    for (const city of NEIGHBOR_BOUNDARIES) {
      const c = centroid(city.ring);
      const { x, y } = toScreen(c[1], c[0]);
      ctx.fillText(city.name, x - 18, y);
    }
    ctx.font = "11px sans-serif";

    // Soka boundary: solid, emphasised (the primary search area).
    ring(SOKA_BOUNDARY);
    ctx.fillStyle = "rgba(238,244,251,0.65)";
    ctx.fill();
    ctx.strokeStyle = "#6f8bb5";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
    {
      const c = centroid(SOKA_BOUNDARY);
      const { x, y } = toScreen(c[1], c[0]);
      ctx.fillStyle = "#5b7099";
      ctx.font = "13px sans-serif";
      ctx.fillText("草加市", x - 18, y);
      ctx.font = "11px sans-serif";
    }

    // Elementary schools.
    for (const school of ELEMENTARY_SCHOOLS) {
      const { x, y } = toScreen(school.lat, school.lon);
      ctx.fillStyle = "#9db4ce";
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stations: squares, labelled for the main hubs.
    for (const station of STATIONS) {
      const { x, y } = toScreen(station.lat, station.lon);
      const major = LABELLED_STATIONS.has(station.name);
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(x - (major ? 4 : 3), y - (major ? 4 : 3), major ? 8 : 6, major ? 8 : 6);
      if (major) {
        ctx.fillStyle = "#1e3a6e";
        ctx.fillText(station.name.replace(/〈草加松原〉/, ""), x + 7, y - 5);
      }
    }

    // Al Sanad and other general POIs as red stars.
    for (const poi of POINTS_OF_INTEREST.filter((place) => place.id === "poi1")) {
      const { x, y } = toScreen(poi.lat, poi.lon);
      drawStar(ctx, x, y, 9, "#dc2626");
      ctx.fillStyle = "#7f1d1d";
      ctx.fillText("Al Sanad School", x + 11, y + 4);
    }

    // Mosque candidates as purple diamonds; scoring uses the nearest selected one.
    for (const mosque of MOSQUES) {
      const { x, y } = toScreen(mosque.lat, mosque.lon);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#7c3aed";
      ctx.fillRect(-5, -5, 10, 10);
      ctx.restore();
      ctx.fillStyle = "#5b21b6";
      ctx.fillText(mosque.name, x + 9, y + 4);
    }

    // Listings, coloured by score. Hovered/selected dots are drawn last, on top.
    dotsRef.current = [];
    let hoveredDot: Projected | null = null;
    let selectedDot: Projected | null = null;
    for (const row of items) {
      const { listing, score } = row;
      if (listing.lat == null || listing.lon == null) continue;
      const { x, y } = toScreen(listing.lat, listing.lon);
      const key = listingKey(listing);
      dotsRef.current.push({ x, y, key, row });
      if (key === hovered) hoveredDot = { x, y, key, row };
      if (key === selected) selectedDot = { x, y, key, row };
      if (key === hovered || key === selected) continue;
      const sold = isSold(listing);
      const mark = marks[key];
      // Sold listings and ruled-out decisions recede to grey.
      const dimmed = sold || isRuledOut(mark);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = dimmed ? "#9ca3af" : scoreColor(score.total);
      ctx.globalAlpha = dimmed ? 0.4 : hovered || selected ? 0.45 : 0.82;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      // New discoveries get a green halo so they pop on the map.
      if (isNewListing(listing)) {
        ctx.beginPath();
        ctx.arc(x, y, 7.5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#16a34a";
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // Shortlisted/applied candidates get a gold ring.
      if (mark && !isRuledOut(mark)) {
        ctx.beginPath();
        ctx.arc(x, y, isNewListing(listing) ? 10.5 : 7.5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#d97706";
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    if (selectedDot) drawEmphasis(ctx, selectedDot, "#2563eb");
    if (hoveredDot && hoveredDot.key !== selected) drawEmphasis(ctx, hoveredDot, "#111827");
  }, [items, toScreen, hovered, selected, marks]);

  // Wheel zoom toward the cursor. Attached manually so preventDefault works
  // (React's onWheel is passive and cannot block the page from scrolling).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { mx, my } = canvasCoords(canvas, e.clientX, e.clientY);
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
        const k = scale / v.scale;
        // Keep the base point under the cursor fixed.
        return { scale, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const hitsAt = (mx: number, my: number): Projected[] =>
    dotsRef.current
      .map((dot) => ({ dot, distance: Math.hypot(dot.x - mx, dot.y - my) }))
      .filter(({ distance }) => distance < HIT_RADIUS)
      // Prefer the highest score when multiple listings share a geocode, then
      // allow cycling instead of making all but one impossible to select.
      .sort((a, b) =>
        ((b.dot.row.score.total ?? -1) - (a.dot.row.score.total ?? -1)) ||
        a.distance - b.distance,
      )
      .map(({ dot }) => dot);

  const hitTest = (mx: number, my: number): Projected | null => {
    // Pointer hover is the map's hottest path. Avoid allocating and sorting an
    // array of every marker for each mousemove; retain only the best hit.
    let best: Projected | null = null;
    let bestDistance = Infinity;
    for (const dot of dotsRef.current) {
      const distance = Math.hypot(dot.x - mx, dot.y - my);
      if (distance >= HIT_RADIUS) continue;
      const score = dot.row.score.total ?? -1;
      const bestScore = best?.row.score.total ?? -1;
      if (!best || score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = dot;
        bestDistance = distance;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { mx, my } = canvasCoords(e.currentTarget, e.clientX, e.clientY);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: mx, startY: my, view, moved: false };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { mx, my } = canvasCoords(e.currentTarget, e.clientX, e.clientY);
    const d = drag.current;
    if (d) {
      const dx = mx - d.startX;
      const dy = my - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
      if (d.moved) {
        setView({ scale: d.view.scale, tx: d.view.tx + dx, ty: d.view.ty + dy });
        onHover(null);
      }
      return;
    }
    const hit = hitTest(mx, my);
    const nextHovered = hit?.key ?? null;
    if (nextHovered !== hovered) onHover(nextHovered);
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    if (!d.moved) {
      const { mx, my } = canvasCoords(e.currentTarget, e.clientX, e.clientY);
      const hits = hitsAt(mx, my);
      const keys = hits.map((hit) => hit.key);
      setSelectionCluster(keys);
      if (keys.length === 0) {
        onSelect(null);
      } else {
        // Clicking the same stack again advances to its next property.
        const current = selected ? keys.indexOf(selected) : -1;
        onSelect(keys[(current + 1) % keys.length]);
      }
    }
  };

  const zoomBy = (factor: number) =>
    setView((v) => {
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = scale / v.scale;
      const cx = WIDTH / 2;
      const cy = HEIGHT / 2;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });

  return (
    <section className={appStyles.card}>
      <h2 className={appStyles.cardTitle}>
        Map — 草加市 &amp; 越谷市 · hover to link · click to pin · scroll/drag to zoom &amp; pan
      </h2>
      <div className={styles.wrap}>
        <canvas
          ref={canvasRef}
          className={`${styles.canvas} ${dragging ? styles.dragging : ""}`}
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => onHover(null)}
        />
        {selectedRow && (
          <MapListingCard
            row={selectedRow}
            mark={marks[listingKey(selectedRow.listing)]}
            onSetMark={onSetMark}
            clusterSize={selectionCluster.length}
            clusterIndex={selectedClusterIndex}
            onPrevious={() => cycleCluster(-1)}
            onNext={() => cycleCluster(1)}
            onClose={() => {
              onSelect(null);
              setSelectionCluster([]);
            }}
          />
        )}
        <div className={styles.controls}>
          <button type="button" title="Zoom in" onClick={() => zoomBy(1.4)}>
            +
          </button>
          <button type="button" title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
            −
          </button>
          <button
            type="button"
            className={styles.reset}
            title="Reset view"
            onClick={() => setView(IDENTITY)}
          >
            ⤢
          </button>
        </div>
      </div>
      <div className={styles.info}>
        {hoveredRow && !selectedRow
          ? `${hoveredRow.listing.name} — score ${
              hoveredRow.score.total?.toFixed(0) ?? "—"
            } · ¥${hoveredRow.listing.rent.toLocaleString()} · ${
              hoveredRow.listing.layout ?? "?"
            } · ${hoveredRow.listing.city ?? ""} · ${hoveredRow.listing.address}`
          : selectedRow
            ? "Selected property is pinned above. Use View listing or Google Maps to continue. Click the same marker to cycle overlapping homes."
            : "★ Al Sanad · ◆ mosques (nearest scores) · ■ stations · dots = listings · click for score/details/links · green ring = new · gold ring = shortlisted · grey = sold / ruled out"}
      </div>
    </section>
  );
});

function MapListingCard({
  row,
  mark,
  onSetMark,
  clusterSize,
  clusterIndex,
  onPrevious,
  onNext,
  onClose,
}: {
  row: ScoredRow;
  mark: ListingMark | undefined;
  onSetMark: (key: string, mark: ListingMark | null) => void;
  clusterSize: number;
  clusterIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { listing, score } = row;
  const rentPerM2 = score.parts.find((part) => part.key === "rentPerM2")?.value;
  const rankedParts = score.parts
    .filter((part) => part.weight > 0 && part.score != null)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);
  const label = (key: string) =>
    [...SCORE_PARAMETERS, ...FEATURE_PARAMETERS].find((meta) => meta.key === key)?.label ?? key;

  return (
    <aside className={styles.popup} aria-live="polite" aria-label="Selected property details">
      <button className={styles.popupClose} onClick={onClose} aria-label="Close selected property">×</button>
      <div className={styles.popupHeader}>
        <span
          className={styles.popupScore}
          style={{ background: scoreColor(score.total) }}
          title="Current weighted score"
        >
          {score.total?.toFixed(1) ?? "—"}
        </span>
        <div>
          <strong>{listing.name}</strong>
          <small>
            {listing.city ?? ""} · {portalReferences(listing).map(({ source }) => source)
              .join(" + ").toUpperCase()}
          </small>
        </div>
      </div>
      <div className={styles.popupFacts}>
        <strong>¥{listing.rent.toLocaleString()}<small>/month</small></strong>
        <strong>{listing.sizeM2 ?? "—"}<small>㎡ exclusive</small></strong>
        <strong>{listing.layout ?? "—"}<small>layout</small></strong>
        <strong>{rentPerM2 != null ? `¥${Math.round(rentPerM2).toLocaleString()}` : "—"}<small>/㎡/month</small></strong>
      </div>
      <div className={styles.popupBreakdown}>
        {rankedParts.map((part) => (
          <div key={part.key} title={part.detail}>
            <span>{label(part.key)}</span>
            <span>{part.score!.toFixed(0)} <small>×w{part.weight}</small></span>
          </div>
        ))}
      </div>
      <p className={styles.popupAddress}>{listing.address}</p>
      {clusterSize > 1 && (
        <div className={styles.clusterNav}>
          <button onClick={onPrevious} aria-label="Previous property at this location">‹</button>
          <span>{Math.max(0, clusterIndex) + 1} of {clusterSize} homes at this point</span>
          <button onClick={onNext} aria-label="Next property at this location">›</button>
        </div>
      )}
      <div className={styles.popupMark}>
        <label htmlFor="map-mark-select">My decision</label>
        <select
          id="map-mark-select"
          value={mark ?? ""}
          onChange={(e) =>
            onSetMark(listingKey(listing), (e.target.value || null) as ListingMark | null)
          }
        >
          <option value="">— undecided</option>
          {LISTING_MARKS.map((meta) => (
            <option key={meta.key} value={meta.key}>
              {meta.icon} {meta.label} · {meta.labelJa}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.popupActions}>
        {portalReferences(listing).filter(({ url }) => Boolean(url)).map(({ source, url }) => (
          <a key={`${source}-${url}`} href={url!} target="_blank" rel="noreferrer">
            View on {source} ↗
          </a>
        ))}
        {listing.lat != null && listing.lon != null && (
          <a href={`https://www.google.com/maps?q=${listing.lat},${listing.lon}`} target="_blank" rel="noreferrer">
            Google Maps ↗
          </a>
        )}
      </div>
    </aside>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Mouse client coords → canvas coordinate space (WIDTH×HEIGHT, pre-DPR). */
function canvasCoords(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return {
    mx: ((clientX - rect.left) / rect.width) * WIDTH,
    my: ((clientY - rect.top) / rect.height) * HEIGHT,
  };
}

/** Draw an enlarged, ringed marker for the hovered/selected listing. */
function drawEmphasis(ctx: CanvasRenderingContext2D, dot: Projected, ringColor: string) {
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = scoreColor(dot.row.score.total);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = ringColor;
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** Simple average-of-vertices centroid, good enough for label placement. */
function centroid(ring: readonly [number, number][]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [lon, lat] of ring) {
    sx += lon;
    sy += lat;
  }
  return [sx / ring.length, sy / ring.length];
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
