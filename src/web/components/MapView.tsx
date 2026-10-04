/**
 * Canvas map of Soka City and its northern neighbour Koshigaya (plus the
 * surrounding municipalities for context): city boundaries, stations,
 * elementary schools, the target POI, mosques, and every geocoded listing
 * coloured by its current score.
 *
 * Cities, boundaries (any number per city, polygons or multipolygons), places,
 * and the map extent all come from the loaded reference model.
 *
 * Walk/ride rings (5, 10, 15 minutes) surround the school target and the
 * selected mosques, sized by the same speed and detour the scoring uses.
 * Listing markers read without colour: candidates are stars, ruled-out homes a
 * faded cross, everything else a score-coloured dot.
 *
 * Interaction:
 *   - hover a dot            → highlights it + the matching table row (no scroll),
 *                              and shows a preview card with the listing's photo
 *   - click a dot            → selects it; the table scrolls that row into view
 *   - scroll wheel           → zoom toward the cursor
 *   - drag                   → pan
 *   - +/−/◎/⤢ buttons        → zoom in / out / fit the shown listings / reset
 *   - layer chips            → show or hide stations, schools, mosques, new rings
 *
 * The base projection is an equirectangular fit to the combined extent of all
 * boundaries (or of the places, when there are no boundaries), with longitude
 * scaled by cos(latitude) so distances are true in both directions. A separate
 * view transform (scale + translation) layers zoom and pan on top, so markers
 * and labels keep a constant screen size.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { scoreColor } from "../../domain/scoring";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS } from "../../domain/scoringConfig";
import { listingKey } from "../../domain/listingKey";
import { sourceListings as portalReferences } from "../../domain/listingDedup";
import { isNewListing, isSold } from "../../domain/lifecycle";
import { isRentedOut } from "../../domain/availability";
import { isRuledOut, LISTING_MARKS, type ListingMark, type MarkMap } from "../../domain/marks";
import type { ReferenceBoundary, ReferenceModel } from "../../domain/referenceData";
import type { CatalogPlace } from "../../domain/places";
import {
  boundaryExtent,
  circleOffCanvas,
  extentOf,
  KM_PER_DEGREE,
  labelPosition,
  longitudeScale,
  padExtent,
  polygonsOf,
  ringRadiusPx,
  scaleBarLength,
  type Extent,
} from "../../domain/mapGeometry";
import { listingPhotos } from "../../domain/listingPhotos";
import { describeNote, type ListingNote, type NoteMap } from "../../domain/notes";
import { MAX_COMPARE } from "../../domain/compare";
import type { ScoredRow } from "../../domain/scoring";
import { ListingThumb, PhotoGallery } from "./ListingPhoto";
import styles from "./MapView.module.css";
import appStyles from "../App.module.css";

interface Props {
  items: ScoredRow[];
  reference: ReferenceModel;
  /** The place the poi1 score measures to; drawn as a star. */
  targetPoi: CatalogPlace | null;
  hovered: string | null;
  onHover: (key: string | null) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  centerTarget: { key: string; lat: number; lon: number; request: number } | null;
  /** The user's decision marks, keyed by listingKey. */
  marks: MarkMap;
  onSetMark: (key: string, mark: ListingMark | null) => void;
  /** The user's notes, shown on the hover and selection cards. */
  notes?: NoteMap;
  /** Listing keys pinned for comparison; the selection card can pin or unpin. */
  compare?: readonly string[];
  onToggleCompare?: (key: string) => void;
  /** Places to draw 5/10/15-minute travel rings around (the poi1 school target and the selected mosques). */
  ringCenters?: readonly CatalogPlace[];
  /** Straight-line metres covered per travel minute (travel speed ÷ detour factor), so a ring matches the scoring's travel-time estimate. */
  ringMetresPerMinute?: number;
  /** Travel mode label for the legend/tooltip. */
  travelMode?: "walk" | "bicycle";
}

const NO_NOTES: NoteMap = {};
const NO_COMPARE: readonly string[] = [];
const NO_RING_CENTERS: readonly CatalogPlace[] = [];
/** Travel-time rings, in minutes; the last is drawn solid, the others dashed. */
const RING_MINUTES = [5, 10, 15] as const;
/** Rings smaller than this on screen get no minute label. */
const RING_LABEL_MIN_RADIUS = 18;
const CANDIDATE_GOLD = "#d97706";

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
// Taller than wide screens need: the three cities stack north–south.
const HEIGHT = 680;
const PADDING = 28;
const MIN_SCALE = 1;
const MAX_SCALE = 14;
const LOCATE_SCALE = 5;
const HIT_RADIUS = 12;
const DRAG_THRESHOLD = 4;
const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };
/** Margin kept around the listings when fitting the view to them. */
const FIT_PADDING = 40;
const HOVER_CARD_WIDTH = 300;
/** Matches the narrow-screen breakpoint in MapView.module.css. */
const NARROW_MAX = 650;
/** Longest scale bar, in canvas pixels. */
const SCALE_BAR_MAX = 110;
const FONT = 'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif';

type LayerKey = "stations" | "schools" | "mosques" | "newRings" | "rings";

const LAYERS: readonly { key: LayerKey; label: string; title: string }[] = [
  { key: "stations", label: "Stations", title: "Railway stations (main hubs labelled)" },
  { key: "schools", label: "Schools", title: "Public elementary schools" },
  { key: "mosques", label: "Mosques", title: "Mosques and musallas; the nearest one is scored" },
  { key: "newRings", label: "New rings", title: "Green ring around listings first seen in the last 14 days" },
  { key: "rings", label: "Travel rings", title: "5/10/15-minute travel rings around the school target and the selected mosques" },
];
const ALL_LAYERS: Record<LayerKey, boolean> = { stations: true, schools: true, mosques: true, newRings: true, rings: true };

/** CSS gradient matching scoreColor, for the legend. */
const SCORE_GRADIENT = `linear-gradient(90deg, ${[0, 25, 50, 75, 100].map((score) => scoreColor(score)).join(", ")})`;

/**
 * Stations worth labelling: the Soka Tobu hubs plus the Koshigaya-side
 * stations near the POIs. Note: 松原団地駅 was renamed to
 * 獨協大学前〈草加松原〉 in 2017 — they are the same station.
 */
const LABELLED_STATIONS = new Set([
  "草加", "谷塚", "獨協大学前〈草加松原〉", "新田", "蒲生", "新越谷", "南越谷", "越谷", "北越谷",
]);

const CITY_LABEL_COLOR = "#94a3b8";

/** The primary search area, drawn emphasised when the data contains it. */
const FOCUS_CITY_ID = "city:soka";

/** Soka and its neighbours; only used when the data has nothing to fit. */
const DEFAULT_EXTENT: Extent = { minLon: 139.68, maxLon: 139.86, minLat: 35.74, maxLat: 35.93 };

interface CityLayer {
  id: string;
  label: string;
  boundaries: ReferenceBoundary[];
  focus: boolean;
}

export const MapView = memo(function MapView({
  items,
  reference,
  targetPoi,
  hovered,
  onHover,
  selected,
  onSelect,
  centerTarget,
  marks,
  onSetMark,
  notes = NO_NOTES,
  compare = NO_COMPARE,
  onToggleCompare,
  ringCenters = NO_RING_CENTERS,
  ringMetresPerMinute,
  travelMode = "walk",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Projected[]>([]);
  const [view, setView] = useState<View>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const [layers, setLayers] = useState(ALL_LAYERS);
  // The legend starts collapsed on narrow screens, where it would cover the map.
  const [legendInitiallyOpen] = useState(() => window.matchMedia?.(`(min-width: ${NARROW_MAX + 1}px)`).matches ?? true);
  /** True while the pointer is over a listing dot, for the pointer cursor. */
  const [overDot, setOverDot] = useState(false);
  /** Keys under the last clicked screen point; repeated clicks cycle them. */
  const [selectionCluster, setSelectionCluster] = useState<string[]>([]);
  // Pointer-interaction bookkeeping (refs so handlers stay stable).
  const drag = useRef<{ startX: number; startY: number; view: View; moved: boolean } | null>(null);

  /** Cities with at least one boundary; the focus city is drawn last, on top. */
  const cityLayers = useMemo((): CityLayer[] => {
    const layers = reference.cities
      .map((city) => ({
        id: city.id,
        label: city.nameLocal ?? city.name,
        boundaries: reference.boundaries.filter((boundary) => boundary.cityId === city.id),
        focus: city.id === FOCUS_CITY_ID,
      }))
      .filter((layer) => layer.boundaries.length > 0);
    return [...layers.filter((layer) => !layer.focus), ...layers.filter((layer) => layer.focus)];
  }, [reference]);

  // Base projection: fit the combined extent of every city boundary.
  const { project, basePxPerKm } = useMemo(() => {
    const extent = padExtent(
      boundaryExtent(reference.boundaries) ?? extentOf(reference.catalog.places) ?? DEFAULT_EXTENT,
    );
    const { minLon, maxLon, minLat, maxLat } = extent;
    const kx = longitudeScale(extent);
    const scale = Math.min(
      (WIDTH - 2 * PADDING) / ((maxLon - minLon) * kx),
      (HEIGHT - 2 * PADDING) / (maxLat - minLat),
    );
    const offsetX = (WIDTH - scale * (maxLon - minLon) * kx) / 2;
    const offsetY = (HEIGHT - scale * (maxLat - minLat)) / 2;
    return {
      project: (lat: number, lon: number) => ({
        x: offsetX + (lon - minLon) * kx * scale,
        y: HEIGHT - (offsetY + (lat - minLat) * scale),
      }),
      basePxPerKm: scale / KM_PER_DEGREE,
    };
  }, [reference]);

  // Compose base projection with the current view transform.
  const toScreen = useCallback(
    (lat: number, lon: number) => {
      const b = project(lat, lon);
      return { x: b.x * view.scale + view.tx, y: b.y * view.scale + view.ty };
    },
    [project, view],
  );

  // Open on the listings rather than the whole reference extent, once data
  // arrives — before the first paint, and never over a view the user chose.
  const autoFitted = useRef(false);
  useLayoutEffect(() => {
    if (autoFitted.current || !items.some(({ listing }) => listing.lat != null && listing.lon != null)) return;
    autoFitted.current = true;
    setView(fitView(items, project));
  }, [items, project]);

  const rowsByKey = useMemo(
    () => new Map(items.map((row) => [listingKey(row.listing), row])),
    [items],
  );
  // Draw the best scores last so they sit on top where dots overlap.
  const drawOrder = useMemo(
    () => [...items].sort((a, b) => (a.score.total ?? -1) - (b.score.total ?? -1)),
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
    // Resizing reallocates the backing store; only do it when the size changes.
    if (canvas.width !== WIDTH * dpr) canvas.width = WIDTH * dpr;
    if (canvas.height !== HEIGHT * dpr) canvas.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Map text gets a white halo so it stays legible over dots and outlines.
    const haloText = (text: string, x: number, y: number, color: string, font = `11px ${FONT}`, align: CanvasTextAlign = "left") => {
      ctx.font = font;
      ctx.textAlign = align;
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.lineWidth = 1;
      ctx.textAlign = "left";
    };
    const trace = (boundaries: readonly ReferenceBoundary[]) => {
      ctx.beginPath();
      for (const boundary of boundaries) {
        for (const polygon of polygonsOf(boundary.geometry)) {
          for (const ring of polygon) {
            ring.forEach(([lon, lat], i) => {
              const { x, y } = toScreen(lat, lon);
              i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.closePath();
          }
        }
      }
    };
    const drawLabel = (layer: CityLayer, color: string) => {
      const position = labelPosition(layer.boundaries);
      if (!position) return;
      const { x, y } = toScreen(position[1], position[0]);
      haloText(layer.label, x, y, color, `600 13px ${FONT}`, "center");
    };

    // Neighbouring municipalities: faint fill, dashed outline.
    const neighbours = cityLayers.filter((layer) => !layer.focus);
    ctx.setLineDash([4, 4]);
    for (const layer of neighbours) {
      trace(layer.boundaries);
      ctx.fillStyle = "#fbfcfd";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#cfd7e3";
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // The focus city (Soka): solid, emphasised (the primary search area).
    const focus = cityLayers.filter((candidate) => candidate.focus);
    for (const layer of focus) {
      trace(layer.boundaries);
      ctx.fillStyle = "rgba(232,240,252,0.8)";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#6f8bb5";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Elementary schools.
    if (layers.schools) {
      for (const school of reference.catalog.inCategory("school")) {
        const { x, y } = toScreen(school.lat, school.lon);
        ctx.fillStyle = "#9db4ce";
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Travel-time rings under the listings: dashed at 5 and 10 minutes, solid at 15.
    if (layers.rings && ringsDrawable(ringMetresPerMinute)) {
      for (const center of ringCenters) {
        const { x, y } = toScreen(center.lat, center.lon);
        const poi = center.category === "poi";
        for (const minutes of RING_MINUTES) {
          const r = ringRadiusPx(minutes, ringMetresPerMinute, basePxPerKm * view.scale);
          if (circleOffCanvas(x, y, r, WIDTH, HEIGHT)) continue;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.setLineDash(minutes === RING_MINUTES[RING_MINUTES.length - 1] ? [] : [4, 3]);
          ctx.strokeStyle = poi ? "rgba(220,38,38,0.5)" : "rgba(124,58,237,0.45)";
          ctx.stroke();
          ctx.setLineDash([]);
          const labelY = y - r - 3;
          if (r > RING_LABEL_MIN_RADIUS && x >= 0 && x <= WIDTH && labelY >= 8 && labelY <= HEIGHT) {
            haloText(`${minutes}′`, x, labelY, poi ? "#991b1b" : "#5b21b6", `10px ${FONT}`, "center");
          }
        }
      }
    }

    // Listings, coloured by score; the best scores are drawn last, on top.
    // Dots grow a little when zoomed in. Hovered/selected dots come after all.
    const radius = 4.5 * Math.min(1.5, 1 + (view.scale - 1) * 0.06);
    dotsRef.current = [];
    let hoveredDot: Projected | null = null;
    let selectedDot: Projected | null = null;
    for (const row of drawOrder) {
      const { listing, score } = row;
      if (listing.lat == null || listing.lon == null) continue;
      const { x, y } = toScreen(listing.lat, listing.lon);
      const key = listingKey(listing);
      dotsRef.current.push({ x, y, key, row });
      if (key === hovered) hoveredDot = { x, y, key, row };
      if (key === selected) selectedDot = { x, y, key, row };
      if (key === hovered || key === selected) continue;
      if (x < -radius || y < -radius || x > WIDTH + radius || y > HEIGHT + radius) continue;
      const sold = isSold(listing);
      const mark = marks[key];
      const ruledOut = isRuledOut(mark);
      const candidate = mark != null && !ruledOut;
      // Sold listings recede to grey; ruled-out homes become a faded cross.
      const dimmed = sold || isRentedOut(listing);
      const fresh = layers.newRings && isNewListing(listing);
      if (ruledOut) {
        drawCross(ctx, x, y, radius * 0.8, hovered || selected ? 0.2 : 0.4);
      } else if (candidate) {
        // Shortlisted/applied candidates are stars with a gold edge, a little larger than a dot.
        ctx.globalAlpha = dimmed ? 0.5 : hovered || selected ? 0.6 : 1;
        starPath(ctx, x, y, radius * 1.55);
        ctx.lineJoin = "round";
        ctx.lineWidth = 3;
        ctx.strokeStyle = CANDIDATE_GOLD;
        ctx.stroke();
        ctx.fillStyle = dimmed ? "#9ca3af" : scoreColor(score.total);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = dimmed ? "#9ca3af" : scoreColor(score.total);
        ctx.globalAlpha = dimmed ? 0.4 : hovered || selected ? 0.5 : 0.88;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      }
      // New discoveries get a thin green halo (a layer: about half of all homes are new).
      if (fresh) {
        ctx.beginPath();
        ctx.arc(x, y, radius * (candidate ? 1.55 : 1) + 2.5, 0, Math.PI * 2);
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = "rgba(22,163,74,0.7)";
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // Reference places sit above the listings so they are never buried.
    // Stations: squares, labelled for the main hubs.
    if (layers.stations) {
      for (const station of reference.catalog.inCategory("station")) {
        const { x, y } = toScreen(station.lat, station.lon);
        const major = LABELLED_STATIONS.has(station.name);
        const half = major ? 4 : 3;
        ctx.fillStyle = "#2563eb";
        ctx.strokeStyle = "#fff";
        ctx.fillRect(x - half, y - half, half * 2, half * 2);
        ctx.strokeRect(x - half, y - half, half * 2, half * 2);
        if (major) haloText(station.name.replace(/〈草加松原〉/, ""), x + 7, y - 5, "#1e3a6e", `600 11px ${FONT}`);
      }
    }

    // Mosque candidates as purple diamonds; scoring uses the nearest selected one.
    if (layers.mosques) {
      for (const mosque of reference.catalog.inCategory("mosque")) {
        const { x, y } = toScreen(mosque.lat, mosque.lon);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = "#7c3aed";
        ctx.strokeStyle = "#fff";
        ctx.fillRect(-5, -5, 10, 10);
        ctx.strokeRect(-5, -5, 10, 10);
        ctx.restore();
        haloText(mosque.name, x + 9, y + 4, "#5b21b6");
      }
    }

    // The target POI (Al Sanad by default) as a red star.
    if (targetPoi) {
      const { x, y } = toScreen(targetPoi.lat, targetPoi.lon);
      drawStar(ctx, x, y, 10, "#dc2626");
      haloText(targetPoi.name, x + 12, y + 4, "#7f1d1d", `600 11px ${FONT}`);
    }

    for (const layer of neighbours) drawLabel(layer, CITY_LABEL_COLOR);
    for (const layer of focus) drawLabel(layer, "#4b6290");

    if (selectedDot) drawEmphasis(ctx, selectedDot, "#2563eb", marks[selectedDot.key]);
    if (hoveredDot && hoveredDot.key !== selected) drawEmphasis(ctx, hoveredDot, "#111827", marks[hoveredDot.key]);
  }, [drawOrder, reference, targetPoi, cityLayers, toScreen, basePxPerKm, view.scale, hovered, selected, marks, layers, ringCenters, ringMetresPerMinute]);

  // Wheel zoom toward the cursor. Attached manually so preventDefault works
  // (React's onWheel is passive and cannot block the page from scrolling).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      autoFitted.current = true;
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
    autoFitted.current = true;
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
    if (Boolean(hit) !== overDot) setOverDot(Boolean(hit));
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

  const zoomBy = (factor: number) => {
    autoFitted.current = true;
    setView((v) => {
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = scale / v.scale;
      const cx = WIDTH / 2;
      const cy = HEIGHT / 2;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  };

  const fitToListings = () => setView(fitView(items, project));

  // The rings chip names the travel mode the scoring uses.
  const layerChips = LAYERS.map((layer) =>
    layer.key === "rings" && travelMode === "bicycle"
      ? { ...layer, label: "Ride rings", title: layer.title.replace("travel", "bicycle") }
      : layer,
  );

  const scaleBar = scaleBarLength(basePxPerKm * view.scale, SCALE_BAR_MAX);

  // Preview card for the hovered home (from the map or a table row), pinned
  // above its dot, or below it near the top edge. Hidden while dragging, for
  // the pinned home, and when the dot is outside the current view.
  const hoverPoint = hoveredRow && hovered !== selected && !dragging && hoveredRow.listing.lat != null && hoveredRow.listing.lon != null
    ? toScreen(hoveredRow.listing.lat, hoveredRow.listing.lon)
    : null;
  const hoverVisible = hoverPoint && hoverPoint.x >= 0 && hoverPoint.x <= WIDTH && hoverPoint.y >= 0 && hoverPoint.y <= HEIGHT;

  return (
    <section className={appStyles.card}>
      <h2 className={appStyles.cardTitle}>Map — 草加市 &amp; 越谷市</h2>
      <div className={styles.wrap}>
        <canvas
          ref={canvasRef}
          className={`${styles.canvas} ${dragging ? styles.dragging : overDot ? styles.overDot : ""}`}
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => {
            onHover(null);
            setOverDot(false);
          }}
        />
        <div className={styles.layers} role="group" aria-label="Map layers">
          {layerChips.map((layer) => (
            <button
              key={layer.key}
              type="button"
              title={layer.title}
              aria-pressed={layers[layer.key]}
              className={`${styles.layerChip} ${styles[`layer_${layer.key}`]} ${layers[layer.key] ? styles.layerOn : ""}`}
              onClick={() => setLayers((current) => ({ ...current, [layer.key]: !current[layer.key] }))}
            >
              <i aria-hidden="true" />
              {layer.label}
            </button>
          ))}
        </div>
        {hoverPoint && hoverVisible && hoveredRow && (
          <MapHoverCard
            row={hoveredRow}
            note={notes[listingKey(hoveredRow.listing)]}
            style={{
              // Centred on the dot, but clamped (in screen pixels) inside the map.
              left: `clamp(4px, calc(${(hoverPoint.x / WIDTH) * 100}% - ${HOVER_CARD_WIDTH / 2}px), calc(100% - ${HOVER_CARD_WIDTH + 4}px))`,
              top: `${(hoverPoint.y / HEIGHT) * 100}%`,
              width: HOVER_CARD_WIDTH,
              transform: hoverPoint.y < HEIGHT * 0.25 ? "translateY(18px)" : "translateY(calc(-100% - 18px))",
            }}
          />
        )}
        {selectedRow && (
          <MapListingCard
            row={selectedRow}
            mark={marks[listingKey(selectedRow.listing)]}
            onSetMark={onSetMark}
            note={notes[listingKey(selectedRow.listing)]}
            comparing={compare.includes(listingKey(selectedRow.listing))}
            compareFull={compare.length >= MAX_COMPARE}
            onToggleCompare={onToggleCompare}
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
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>
            +
          </button>
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
            −
          </button>
          <button
            type="button"
            className={styles.reset}
            title="Fit the listings currently shown"
            aria-label="Fit the listings currently shown"
            onClick={fitToListings}
          >
            ◎
          </button>
          <button
            type="button"
            className={styles.reset}
            title="Reset view"
            aria-label="Reset view"
            onClick={() => setView(IDENTITY)}
          >
            ⤢
          </button>
        </div>
        <details className={styles.legend} open={legendInitiallyOpen}>
          <summary>Legend</summary>
          <div className={styles.legendScore}>
            <span>Score</span>
            <span className={styles.legendGradient} style={{ background: SCORE_GRADIENT }} />
            <small>0</small>
            <small>100</small>
          </div>
          <div className={styles.legendKeys}>
            <span><i className={styles.keyStar}>★</i>{targetPoi?.name ?? "Target"}</span>
            <span><i className={styles.keyMosque} />Mosque</span>
            <span><i className={styles.keyStation} />Station</span>
            <span><i className={styles.keySchool} />School</span>
            <span><i className={styles.keyNew} />New</span>
            <span><i className={styles.keyCandidate}>★</i>Shortlisted · applied</span>
            <span><i className={styles.keyUndecided} />Undecided</span>
            <span><i className={styles.keyRuledOut}>✕</i>Ruled out</span>
            <span><i className={styles.keyDimmed} />Sold</span>
            {layers.rings && ringsDrawable(ringMetresPerMinute) && ringCenters.length > 0 && (
              <span className={styles.legendNote}><i className={styles.keyRing} />Dashed rings: 5/10/15 min by {travelMode} (solid = 15) at the scoring's speed and detour</span>
            )}
          </div>
          <div className={styles.scaleBar}>
            {/* The bar is drawn in canvas pixels; cqw converts them to the map's rendered width. */}
            <span style={{ width: `calc(${(scaleBar.px / WIDTH) * 100} * 1cqw)` }} />
            <small>{scaleBar.km < 1 ? `${scaleBar.km * 1000} m` : `${scaleBar.km} km`}</small>
          </div>
        </details>
      </div>
      <div className={styles.info}>
        {hoveredRow && !selectedRow
          ? `${hoveredRow.listing.name} — score ${
              hoveredRow.score.total?.toFixed(0) ?? "—"
            } · ¥${hoveredRow.listing.rent.toLocaleString()} · ${
              hoveredRow.listing.layout ?? "?"
            } · ${hoveredRow.listing.city ?? ""} · ${hoveredRow.listing.address}`
          : selectedRow
            ? "Pinned above. Click the same marker again to cycle homes that share a location."
            : "Hover or tap a home for its photo and details · scroll or pinch to zoom · drag to pan · ◎ fits the listings shown"}
      </div>
    </section>
  );
});

/** Lightweight hover preview: photo, name, the key numbers and the score. */
function MapHoverCard({ row, note, style }: { row: ScoredRow; note: ListingNote | undefined; style: React.CSSProperties }) {
  const { listing, score } = row;
  return (
    <div className={styles.hoverCard} style={style} aria-hidden="true">
      <ListingThumb photos={listingPhotos(listing)} name={listing.name} className={styles.hoverThumb} />
      <div className={styles.hoverText}>
        <strong>{listing.name}</strong>
        <span>
          ¥{listing.rent.toLocaleString()} · {listing.layout ?? "?"} · {listing.sizeM2 ?? "—"}㎡
        </span>
        <small>
          {[listing.city, listing.advertisedStation && listing.stationWalkMin != null
            ? `${listing.advertisedStation} ${listing.stationWalkMin} min`
            : null].filter(Boolean).join(" · ")}
        </small>
        {note && <small className={styles.hoverNote}>📝 {describeNote(note)}</small>}
      </div>
      <span className={styles.hoverScore} style={{ background: scoreColor(score.total) }}>
        {score.total?.toFixed(0) ?? "—"}
      </span>
    </div>
  );
}

function MapListingCard({
  row,
  mark,
  onSetMark,
  note,
  comparing,
  compareFull,
  onToggleCompare,
  clusterSize,
  clusterIndex,
  onPrevious,
  onNext,
  onClose,
}: {
  row: ScoredRow;
  mark: ListingMark | undefined;
  onSetMark: (key: string, mark: ListingMark | null) => void;
  note: ListingNote | undefined;
  comparing: boolean;
  compareFull: boolean;
  onToggleCompare?: (key: string) => void;
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
      {/* Keyed so a newly pinned home starts on its own first photo. */}
      <PhotoGallery key={listingKey(listing)} photos={listingPhotos(listing)} name={listing.name} className={styles.popupGallery} />
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
      {note && <p className={styles.popupNote}>📝 {describeNote(note)}</p>}
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
        {onToggleCompare && (
          <button
            type="button"
            className={comparing ? styles.comparing : "secondary"}
            disabled={!comparing && compareFull}
            title={!comparing && compareFull ? `The comparison holds ${MAX_COMPARE} homes — remove one first` : undefined}
            onClick={() => onToggleCompare(listingKey(listing))}
          >
            {comparing ? "✓ Comparing" : "+ Compare"}
          </button>
        )}
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

/** The view that frames these listings, or the full map when they already fill it. */
function fitView(items: readonly ScoredRow[], project: (lat: number, lon: number) => { x: number; y: number }): View {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { listing } of items) {
    if (listing.lat == null || listing.lon == null) continue;
    const { x, y } = project(listing.lat, listing.lon);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (minX === Infinity) return IDENTITY;
  const scale = clamp(
    Math.min((WIDTH - 2 * FIT_PADDING) / Math.max(maxX - minX, 1), (HEIGHT - 2 * FIT_PADDING) / Math.max(maxY - minY, 1)),
    MIN_SCALE,
    LOCATE_SCALE * 2,
  );
  if (scale <= MIN_SCALE * 1.05) return IDENTITY;
  return { scale, tx: WIDTH / 2 - ((minX + maxX) / 2) * scale, ty: HEIGHT / 2 - ((minY + maxY) / 2) * scale };
}

/** Mouse client coords → canvas coordinate space (WIDTH×HEIGHT, pre-DPR). */
function canvasCoords(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return {
    mx: ((clientX - rect.left) / rect.width) * WIDTH,
    my: ((clientY - rect.top) / rect.height) * HEIGHT,
  };
}

/** A usable ring scale: positive and finite (a zero detour factor makes it Infinity). */
function ringsDrawable(metresPerMinute: number | undefined): metresPerMinute is number {
  return metresPerMinute != null && Number.isFinite(metresPerMinute) && metresPerMinute > 0;
}

/** Draw an enlarged, ringed marker for the hovered/selected listing; candidates stay stars. */
function drawEmphasis(ctx: CanvasRenderingContext2D, dot: Projected, ringColor: string, mark: ListingMark | undefined) {
  if (mark != null && !isRuledOut(mark)) starPath(ctx, dot.x, dot.y, 14);
  else {
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 9, 0, Math.PI * 2);
  }
  ctx.fillStyle = scoreColor(dot.row.score.total);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.strokeStyle = ringColor;
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** A faded grey ✕ marking a ruled-out listing. */
function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number, alpha: number) {
  ctx.beginPath();
  ctx.moveTo(cx - half, cy - half);
  ctx.lineTo(cx + half, cy + half);
  ctx.moveTo(cx + half, cy - half);
  ctx.lineTo(cx - half, cy + half);
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.75;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#6b7280";
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.lineWidth = 1;
  ctx.globalAlpha = 1;
}

/** Trace a five-point star path (not yet filled or stroked). */
function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  starPath(ctx, cx, cy, r);
  ctx.fillStyle = color;
  ctx.fill();
}
