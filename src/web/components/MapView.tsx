/**
 * Canvas map of the Kanto region, centred on the search area (Soka City and
 * its neighbours): municipal boundaries with prefecture borders, the region's
 * rail stations, elementary schools, the target POI, mosques, and every
 * geocoded listing coloured by its current score.
 *
 * Cities, boundaries (any number per city, polygons or multipolygons), places,
 * and the map extent all come from the loaded reference model. Prefecture
 * borders are traced from the city boundaries (cities carry their
 * prefecture). Names appear as the map is zoomed in: prefectures when zoomed
 * out, then cities that are big enough on screen, then stations, busiest
 * first; a label never overlaps one already drawn.
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
 *   - +/−/◎/⤢ buttons        → zoom in / out / fit the shown listings / all of Kanto
 *   - layer chips            → show or hide stations, schools, mosques, new rings
 *
 * The base projection is an equirectangular fit to the combined extent of all
 * boundaries (or of the places, when there are no boundaries), with longitude
 * scaled by cos(latitude) so distances are true in both directions. A separate
 * view transform (scale + translation) layers zoom and pan on top, so markers
 * and labels keep a constant screen size. Zoom limits are set in pixels per
 * kilometre, so they hold whatever extent the reference data covers.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { scoreColor } from "../../domain/scoring";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS } from "../../domain/scoringConfig";
import { listingKey } from "../../domain/listingKey";
import { sourceListings as portalReferences } from "../../domain/listingDedup";
import { isNewListing, isSold, NEW_LISTING_WINDOW_DAYS } from "../../domain/lifecycle";
import { isRentedOut } from "../../domain/availability";
import { isRuledOut, LISTING_MARKS, type ListingMark, type MarkMap } from "../../domain/marks";
import type { ReferenceBoundary, ReferenceCity, ReferenceModel } from "../../domain/referenceData";
import type { CatalogPlace } from "../../domain/places";
import {
  areaCentroid,
  borderSegments,
  boundaryExtent,
  circleOffCanvas,
  extentOf,
  joinSegments,
  KM_PER_DEGREE,
  labelPosition,
  longitudeScale,
  padExtent,
  pointInGeometry,
  polygonsOf,
  ringRadiusPx,
  scaleBarLength,
  type Extent,
} from "../../domain/mapGeometry";
import type { Position } from "../../domain/referenceData";
import { listingPhotos } from "../../domain/listingPhotos";
import { formatKm, listingDistances, type ListingDistance } from "../../domain/listingDistances";
import { describeNote, type ListingNote, type NoteMap } from "../../domain/notes";
import { MAX_COMPARE } from "../../domain/compare";
import type { ScoredRow } from "../../domain/scoring";
import { cityName, type NameLanguage } from "../../domain/mapAreas";
import { ListingThumb, PhotoGallery } from "./ListingPhoto";
import { AreaPicker, type AreaCity } from "./AreaPicker";
import styles from "./MapView.module.css";
import appStyles from "../App.module.css";

interface Props {
  items: ScoredRow[];
  reference: ReferenceModel;
  /** The private schools the poi1 score takes the nearest of; drawn as solid stars. */
  scoredPois: readonly CatalogPlace[];
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
  /** Days a listing counts as new after it is first seen (the green ring). */
  newWithinDays?: number;
  /** Places to draw 5/10/15-minute travel rings around (the poi1 school target and the selected mosques). */
  ringCenters?: readonly CatalogPlace[];
  /** Straight-line metres covered per travel minute (travel speed ÷ detour factor), so a ring matches the scoring's travel-time estimate. */
  ringMetresPerMinute?: number;
  /** Travel mode label for the legend/tooltip. */
  travelMode?: "walk" | "bicycle";
  /** Walking knobs for the selection card's distance list (always on foot, whatever the travel mode). */
  walking?: { speedMPerMin: number; detourFactor: number; includeHoikuen: boolean };
  /** City ids the map draws (the area picker changes them). */
  areas: ReadonlySet<string>;
  /** Cities whose listings are shown; always drawn, so locked in the area picker. */
  onSetAreas: (areas: ReadonlySet<string>) => void;
  onResetAreas: () => void;
  /** Language for city, prefecture and station names. */
  language: NameLanguage;
  onSetLanguage: (language: NameLanguage) => void;
}

const NO_NOTES: NoteMap = {};
const NO_COMPARE: readonly string[] = [];
const NO_RING_CENTERS: readonly CatalogPlace[] = [];
const DEFAULT_WALKING = { speedMPerMin: 80, detourFactor: 1.3, includeHoikuen: false };
/** Travel-time rings, in minutes; the last is drawn solid, the others dashed. */
const RING_MINUTES = [5, 10, 15] as const;
/** Rings smaller than this on screen get no minute label. */
const RING_LABEL_MIN_RADIUS = 18;

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

/**
 * The frame the projection fits the chosen areas into, in canvas units. The
 * canvas is always HEIGHT units tall but as wide as its box allows (never
 * narrower than WIDTH); the frame sits centred in it, so a wider screen shows
 * more map to either side rather than a letterboxed one.
 */
const WIDTH = 1100;
// Taller than wide screens need: the three cities stack north–south.
const HEIGHT = 680;
const PADDING = 28;
const MIN_SCALE = 1;
/** Closest zoom, and the zoom a table row's locate button jumps to, in screen pixels per km. */
const MAX_PX_PER_KM = 400;
const LOCATE_PX_PER_KM = 140;
/** Listing dots start growing past this zoom (the old Soka-only map's opening scale). */
const DOT_BASE_PX_PER_KM = 30;
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

/**
 * Canvas colours come from the theme stylesheet, like every other colour:
 * each key names the `--rs-map-*` custom property it is read from.
 */
const MAP_COLOR_PROPERTIES = {
  halo: "--rs-map-halo",
  neighbourFill: "--rs-map-neighbour-fill",
  neighbourLine: "--rs-map-neighbour-line",
  focusFill: "--rs-map-focus-fill",
  focusLine: "--rs-map-focus-line",
  focusLabel: "--rs-map-focus-label",
  cityLabel: "--rs-map-city-label",
  school: "--rs-map-school",
  ringStroke: "--rs-map-ring-stroke",
  ringLabel: "--rs-map-ring-label",
  mosqueRingStroke: "--rs-map-mosque-ring-stroke",
  mosqueRingLabel: "--rs-map-mosque-ring-label",
  newRingStroke: "--rs-map-new-ring-stroke",
  candidate: "--rs-map-candidate",
  dimmed: "--rs-map-dimmed",
  ruledOut: "--rs-map-ruled-out",
  markerOutline: "--rs-map-marker-outline",
  station: "--rs-map-station",
  stationLabel: "--rs-map-station-label",
  railStation: "--rs-map-rail-station",
  railStationLabel: "--rs-map-rail-station-label",
  prefectureLine: "--rs-map-prefecture-line",
  prefectureLabel: "--rs-map-prefecture-label",
  mosque: "--rs-map-mosque",
  mosqueLabel: "--rs-map-mosque-label",
  target: "--rs-map-target",
  targetLabel: "--rs-map-target-label",
  selected: "--rs-map-selected",
  hovered: "--rs-map-hovered",
} as const;

type MapColors = Record<keyof typeof MAP_COLOR_PROPERTIES, string>;

/** The theme's map colours, as resolved for `element`. */
function readMapColors(element: Element): MapColors {
  const style = getComputedStyle(element);
  return Object.fromEntries(Object.entries(MAP_COLOR_PROPERTIES)
    .map(([key, property]) => [key, style.getPropertyValue(property).trim()])) as MapColors;
}

type LayerKey = "stations" | "schools" | "mosques" | "newRings" | "rings";

const LAYERS: readonly { key: LayerKey; label: string; title: string }[] = [
  { key: "stations", label: "Stations", title: "Railway stations across Kanto; the scored stations are larger, and names appear as you zoom in" },
  { key: "schools", label: "Schools", title: "Public elementary schools" },
  { key: "mosques", label: "Mosques", title: "Mosques and musallas; the nearest one is scored" },
  { key: "newRings", label: "New rings", title: "Green ring around new listings (see Listing status in the filters)" },
  { key: "rings", label: "Travel rings", title: "5/10/15-minute travel rings around the school target and the selected mosques" },
];
const ALL_LAYERS: Record<LayerKey, boolean> = { stations: true, schools: true, mosques: true, newRings: true, rings: true };

/** How many lines serve a station (from the station import), for label priority. */
function lineCount(place: CatalogPlace): number {
  const count = place.attributes?.lineCount;
  return typeof count === "number" ? count : 0;
}

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

/** The primary search area, drawn emphasised when the data contains it. */
const FOCUS_CITY_ID = "city:soka";

/** Region-wide stations: map context, not scored. */
const RAIL_STATION_CATEGORY = "railStation";
/** A rail station this close to a scored station of the same name is that station, drawn once. */
const SAME_STATION_KM = 1.5;

/** Zoom (screen pixels per km) at which each kind of name appears. */
const PREFECTURE_LABEL_MAX_PX_PER_KM = 7;
const RAIL_STATION_LABEL_MIN_PX_PER_KM = 14;
/** A city is named once its outline is at least this large on screen. */
const CITY_LABEL_MIN_PX = { width: 46, height: 16 };

interface LabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Soka and its neighbours; only used when the data has nothing to fit. */
const DEFAULT_EXTENT: Extent = { minLon: 139.68, maxLon: 139.86, minLat: 35.74, maxLat: 35.93 };

interface CityLayer {
  id: string;
  city: ReferenceCity;
  prefecture: string;
  boundaries: ReferenceBoundary[];
  focus: boolean;
  /** Bounding box of the outlines, for skipping cities off screen. */
  extent: Extent;
  /** Where the name goes (the centroid of the largest piece). */
  labelAt: Position | null;
}

interface PrefectureLayer {
  name: string;
  nameEn?: string;
  labelAt: Position | null;
}


export const MapView = memo(function MapView({
  items,
  reference,
  scoredPois,
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
  newWithinDays = NEW_LISTING_WINDOW_DAYS,
  ringCenters = NO_RING_CENTERS,
  ringMetresPerMinute,
  travelMode = "walk",
  walking = DEFAULT_WALKING,
  areas,
  onSetAreas,
  onResetAreas,
  language,
  onSetLanguage,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Projected[]>([]);
  const [view, setView] = useState<View>(IDENTITY);
  /** The canvas width in canvas units: HEIGHT × its rendered aspect ratio. */
  const [canvasWidth, setCanvasWidth] = useState(WIDTH);
  /** How far right of the canvas's left edge the projection frame starts. */
  const frameShift = (canvasWidth - WIDTH) / 2;
  const frameShiftRef = useRef(frameShift);
  frameShiftRef.current = frameShift;
  const [dragging, setDragging] = useState(false);
  const [layers, setLayers] = useState(ALL_LAYERS);
  const [pickingAreas, setPickingAreas] = useState(false);
  // The legend starts collapsed on narrow screens, where it would cover the map.
  const [legendInitiallyOpen] = useState(() => window.matchMedia?.(`(min-width: ${NARROW_MAX + 1}px)`).matches ?? true);
  /** True while the pointer is over a listing dot, for the pointer cursor. */
  const [overDot, setOverDot] = useState(false);
  /** Keys under the last clicked screen point; repeated clicks cycle them. */
  const [selectionCluster, setSelectionCluster] = useState<string[]>([]);
  // Pointer-interaction bookkeeping (refs so handlers stay stable).
  const drag = useRef<{ startX: number; startY: number; view: View; moved: boolean } | null>(null);
  /** Measured label widths by font and text; measuring hundreds of names per frame adds up. */
  const labelWidths = useRef(new Map<string, number>());
  /** Boundary outlines as canvas paths, rebuilt when the reference changes. */
  const outlinesRef = useRef<{ source: unknown; project: unknown; neighbours: Path2D; focus: Path2D; borders: Path2D } | null>(null);

  /** Cities with at least one boundary; the focus city is drawn last, on top. */
  // Every city with an outline; the map draws the chosen areas, the area picker all of them.
  const allCities = useMemo((): CityLayer[] => {
    const byCity = new Map<string, ReferenceBoundary[]>();
    for (const boundary of reference.boundaries) {
      const list = byCity.get(boundary.cityId);
      if (list) list.push(boundary);
      else byCity.set(boundary.cityId, [boundary]);
    }
    return reference.cities.flatMap((city): CityLayer[] => {
      const boundaries = byCity.get(city.id) ?? [];
      const extent = boundaryExtent(boundaries);
      if (!extent) return [];
      return [{
        id: city.id,
        city,
        prefecture: city.prefecture ?? "",
        boundaries,
        focus: city.id === FOCUS_CITY_ID,
        extent,
        labelAt: labelPosition(boundaries),
      }];
    });
  }, [reference]);

  /** The chosen cities; the focus city is drawn last, on top. */
  const cityLayers = useMemo((): CityLayer[] => {
    const shown = allCities.filter((layer) => areas.has(layer.id));
    return [...shown.filter((layer) => !layer.focus), ...shown.filter((layer) => layer.focus)];
  }, [allCities, areas]);

  // Prefecture border edges, traced once from every city's outline.
  const borderEdges = useMemo(() => borderSegments(allCities
    .filter((layer) => layer.prefecture)
    .flatMap((layer) => layer.boundaries.map((boundary) => ({ geometry: boundary.geometry, group: layer.prefecture, owner: layer.id })))),
  [allCities]);

  // The borders and names of the prefectures the chosen cities touch.
  const prefectures = useMemo(() => {
    const byPrefecture = new Map<string, { boundaries: ReferenceBoundary[]; nameEn?: string }>();
    for (const layer of cityLayers) {
      if (!layer.prefecture) continue;
      const entry = byPrefecture.get(layer.prefecture) ?? { boundaries: [], nameEn: layer.city.prefectureEn };
      entry.boundaries.push(...layer.boundaries);
      byPrefecture.set(layer.prefecture, entry);
    }
    const layers: PrefectureLayer[] = [...byPrefecture].map(([name, { boundaries, nameEn }]) =>
      ({ name, nameEn, labelAt: areaCentroid(boundaries) }));
    const borders = joinSegments(borderEdges.filter((edge) => edge.owners.some((owner) => areas.has(owner))));
    // Names only help when the chosen areas span more than one prefecture.
    return { layers: byPrefecture.size < 2 ? [] : layers, borders };
  }, [cityLayers, borderEdges, areas]);

  // Stations in the chosen areas, minus those already drawn as a scored station.
  const railStations = useMemo(() => {
    const scored = reference.catalog.inCategory("station");
    return reference.catalog.inCategory(RAIL_STATION_CATEGORY)
      .filter((station) => areas.has(String(station.attributes?.cityId ?? "")))
      .filter((station) => !scored.some((other) =>
        other.name.replace(/〈.*〉$/u, "") === station.name.replace(/〈.*〉$/u, "") &&
        Math.hypot((other.lon - station.lon) * Math.cos((station.lat * Math.PI) / 180), other.lat - station.lat) * KM_PER_DEGREE < SAME_STATION_KM))
      // Busiest first, so their names win the space when labels compete.
      .sort((a, b) => lineCount(b) - lineCount(a));
  }, [reference, areas]);

  // Mosques and private schools inside the chosen areas (plus any with a travel ring),
  // so hidden areas stay empty: the mosque list covers all of Japan.
  const areaPlaces = useMemo(() => {
    const inAreas = (place: CatalogPlace) => cityLayers.some((layer) =>
      place.lon >= layer.extent.minLon && place.lon <= layer.extent.maxLon &&
      place.lat >= layer.extent.minLat && place.lat <= layer.extent.maxLat &&
      layer.boundaries.some((boundary) => pointInGeometry([place.lon, place.lat], boundary.geometry)));
    const ringed = new Set(ringCenters.map((place) => place.id));
    const keep = (place: CatalogPlace) => ringed.has(place.id) || inAreas(place);
    return {
      mosques: reference.catalog.inCategory("mosque").filter(keep),
      pois: reference.catalog.inCategory("poi").filter(keep),
    };
  }, [reference, cityLayers, ringCenters]);

  const areaCities = useMemo((): AreaCity[] =>
    allCities.map(({ city, boundaries, extent }) => ({ city, boundaries, extent })), [allCities]);

  // Base projection: fit the chosen areas (every boundary when none are chosen).
  const { project, basePxPerKm } = useMemo(() => {
    const extent = padExtent(
      boundaryExtent(cityLayers.flatMap((layer) => layer.boundaries)) ??
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
  }, [cityLayers, reference]);
  const maxScale = Math.max(MIN_SCALE, MAX_PX_PER_KM / basePxPerKm);
  const locateScale = clamp(LOCATE_PX_PER_KM / basePxPerKm, MIN_SCALE, maxScale);
  const maxScaleRef = useRef(maxScale);
  maxScaleRef.current = maxScale;
  // Changing the areas refits the map to them: the old view belongs to the old projection.
  // A layout effect, so the new projection is never painted with the old view.
  const shownProjection = useRef(project);
  useLayoutEffect(() => {
    if (shownProjection.current === project) return;
    shownProjection.current = project;
    setView(IDENTITY);
  }, [project]);

  // Follow the canvas's rendered shape; measured before paint so the first frame is right.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (width > 0 && height > 0) setCanvasWidth(Math.max(WIDTH, Math.round((HEIGHT * width) / height)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Compose base projection with the current view transform, then centre the frame.
  const toScreen = useCallback(
    (lat: number, lon: number) => {
      const b = project(lat, lon);
      return { x: b.x * view.scale + view.tx + frameShift, y: b.y * view.scale + view.ty };
    },
    [project, view, frameShift],
  );

  // Open on the listings rather than the whole reference extent, once data
  // arrives — before the first paint, and never over a view the user chose.
  const autoFitted = useRef(false);
  useLayoutEffect(() => {
    if (autoFitted.current || !items.some(({ listing }) => listing.lat != null && listing.lon != null)) return;
    autoFitted.current = true;
    setView(fitView(items, project, Math.min(locateScale * 2, maxScale)));
  }, [items, project, locateScale, maxScale]);

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
  // The private school this home's poi1 score measured to: the nearest scored one.
  const scoredPoiId = useMemo(() => {
    const name = selectedRow?.listing.poi1?.name;
    return name == null ? undefined : scoredPois.find((poi) => poi.name === name)?.id;
  }, [selectedRow, scoredPois]);
  const selectedDistances = useMemo(
    () => selectedRow
      ? listingDistances(selectedRow.listing, {
          pois: reference.catalog.inCategory("poi"),
          targetPoiId: scoredPoiId,
          walkSpeedMPerMin: walking.speedMPerMin,
          detourFactor: walking.detourFactor,
          includeHoikuen: walking.includeHoikuen,
        })
      : [],
    [selectedRow, reference, scoredPoiId, walking.speedMPerMin, walking.detourFactor, walking.includeHoikuen],
  );

  // Table-row locate buttons issue an explicit center request. Use the current
  // zoom when it is already useful; otherwise zoom in enough to identify the home.
  // Each request is handled once: the target stays set afterwards, and changing
  // the areas (a new projection) must not jump back to it.
  const handledCenterRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!centerTarget || handledCenterRequest.current === centerTarget.request) return;
    handledCenterRequest.current = centerTarget.request;
    setView((current) => {
      const scale = Math.max(current.scale, locateScale);
      const point = project(centerTarget.lat, centerTarget.lon);
      return {
        scale,
        tx: WIDTH / 2 - point.x * scale,
        ty: HEIGHT / 2 - point.y * scale,
      };
    });
    setSelectionCluster([]);
    canvasRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [centerTarget, project, locateScale]);

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
    if (canvas.width !== Math.round(canvasWidth * dpr)) canvas.width = Math.round(canvasWidth * dpr);
    if (canvas.height !== HEIGHT * dpr) canvas.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, HEIGHT);
    const colors = readMapColors(canvas);

    // Map text gets a white halo so it stays legible over dots and outlines.
    const haloText = (text: string, x: number, y: number, color: string, font = `11px ${FONT}`, align: CanvasTextAlign = "left") => {
      ctx.font = font;
      ctx.textAlign = align;
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.halo;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.lineWidth = 1;
      ctx.textAlign = "left";
    };
    const pxPerKm = basePxPerKm * view.scale;
    /** True when a lon/lat box overlaps the canvas (the projection keeps north up). */
    const onScreen = (extent: Extent) => {
      const topLeft = toScreen(extent.maxLat, extent.minLon);
      const bottomRight = toScreen(extent.minLat, extent.maxLon);
      return bottomRight.x >= 0 && topLeft.x <= canvasWidth && bottomRight.y >= 0 && topLeft.y <= HEIGHT;
    };
    // Outlines are built once per reference as paths in base-projection pixels
    // and drawn through the view transform, so panning and zooming never
    // re-trace the region's ~100k boundary vertices. Line widths and dashes
    // are divided by the zoom to stay constant on screen.
    let outlines = outlinesRef.current;
    if (outlines?.source !== prefectures || outlines.project !== project) {
      const tracePath = (path: Path2D, rings: Iterable<readonly Position[]>, close: boolean) => {
        for (const ring of rings) {
          ring.forEach(([lon, lat], i) => {
            const { x, y } = project(lat, lon);
            i === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
          });
          if (close) path.closePath();
        }
      };
      const cityPath = (cities: readonly CityLayer[]) => {
        const path = new Path2D();
        for (const layer of cities) {
          for (const boundary of layer.boundaries) {
            for (const polygon of polygonsOf(boundary.geometry)) tracePath(path, polygon, true);
          }
        }
        return path;
      };
      const borders = new Path2D();
      tracePath(borders, prefectures.borders, false);
      outlines = {
        source: prefectures,
        project,
        neighbours: cityPath(cityLayers.filter((layer) => !layer.focus)),
        focus: cityPath(cityLayers.filter((layer) => layer.focus)),
        borders,
      };
      outlinesRef.current = outlines;
    }
    ctx.save();
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * (view.tx + frameShift), dpr * view.ty);
    const px = 1 / view.scale;
    // Municipalities around the search area: faint fill, dashed outline.
    ctx.fillStyle = colors.neighbourFill;
    ctx.fill(outlines.neighbours, "evenodd");
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.lineWidth = px;
    ctx.strokeStyle = colors.neighbourLine;
    ctx.stroke(outlines.neighbours);
    ctx.setLineDash([]);
    // Prefecture borders (and the coast), solid over the municipal outlines.
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.25 * px;
    ctx.strokeStyle = colors.prefectureLine;
    ctx.stroke(outlines.borders);
    // The focus city (Soka): solid, emphasised (the primary search area).
    ctx.fillStyle = colors.focusFill;
    ctx.fill(outlines.focus, "evenodd");
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = colors.focusLine;
    ctx.stroke(outlines.focus);
    ctx.restore();
    const neighbours = cityLayers.filter((layer) => !layer.focus);
    const focus = cityLayers.filter((candidate) => candidate.focus);

    // Elementary schools.
    if (layers.schools) {
      for (const school of reference.catalog.inCategory("school")) {
        const { x, y } = toScreen(school.lat, school.lon);
        ctx.fillStyle = colors.school;
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
          if (circleOffCanvas(x, y, r, canvasWidth, HEIGHT)) continue;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.setLineDash(minutes === RING_MINUTES[RING_MINUTES.length - 1] ? [] : [4, 3]);
          ctx.strokeStyle = poi ? colors.ringStroke : colors.mosqueRingStroke;
          ctx.stroke();
          ctx.setLineDash([]);
          const labelY = y - r - 3;
          if (r > RING_LABEL_MIN_RADIUS && x >= 0 && x <= canvasWidth && labelY >= 8 && labelY <= HEIGHT) {
            haloText(`${minutes}′`, x, labelY, poi ? colors.ringLabel : colors.mosqueRingLabel, `10px ${FONT}`, "center");
          }
        }
      }
    }

    // Listings, coloured by score; the best scores are drawn last, on top.
    // Dots grow a little when zoomed in. Hovered/selected dots come after all.
    const radius = 4.5 * Math.min(1.5, 1 + Math.max(0, pxPerKm / DOT_BASE_PX_PER_KM - 1) * 0.06);
    dotsRef.current = [];
    let hoveredDot: Projected | null = null;
    let selectedDot: Projected | null = null;
    const now = new Date();
    for (const row of drawOrder) {
      const { listing, score } = row;
      if (listing.lat == null || listing.lon == null) continue;
      const { x, y } = toScreen(listing.lat, listing.lon);
      const key = listingKey(listing);
      dotsRef.current.push({ x, y, key, row });
      if (key === hovered) hoveredDot = { x, y, key, row };
      if (key === selected) selectedDot = { x, y, key, row };
      if (key === hovered || key === selected) continue;
      if (x < -radius || y < -radius || x > canvasWidth + radius || y > HEIGHT + radius) continue;
      const sold = isSold(listing);
      const mark = marks[key];
      const ruledOut = isRuledOut(mark);
      const candidate = mark != null && !ruledOut;
      // Sold listings recede to grey; ruled-out homes become a faded cross.
      const dimmed = sold || isRentedOut(listing);
      const fresh = layers.newRings && isNewListing(listing, now, newWithinDays);
      if (ruledOut) {
        drawCross(ctx, x, y, radius * 0.8, hovered || selected ? 0.2 : 0.4, colors.ruledOut);
      } else if (candidate) {
        // Shortlisted/applied candidates are stars with a gold edge, a little larger than a dot.
        ctx.globalAlpha = dimmed ? 0.5 : hovered || selected ? 0.6 : 1;
        starPath(ctx, x, y, radius * 1.55);
        ctx.lineJoin = "round";
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors.candidate;
        ctx.stroke();
        ctx.fillStyle = dimmed ? colors.dimmed : scoreColor(score.total);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = colors.markerOutline;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = dimmed ? colors.dimmed : scoreColor(score.total);
        ctx.globalAlpha = dimmed ? 0.4 : hovered || selected ? 0.5 : 0.88;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.markerOutline;
        ctx.stroke();
      }
      // New discoveries get a thin green halo (a layer: about half of all homes are new).
      if (fresh) {
        ctx.beginPath();
        ctx.arc(x, y, radius * (candidate ? 1.55 : 1) + 2.5, 0, Math.PI * 2);
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = colors.newRingStroke;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // Names are placed after every marker, most important first; one that would
    // overlap a name already placed is skipped.
    const placed: LabelBox[] = [];
    const label = (
      text: string, x: number, y: number, color: string,
      { font = `11px ${FONT}`, size = 11, align = "left" as CanvasTextAlign, force = false } = {},
    ) => {
      ctx.font = font;
      const widthKey = `${font}|${text}`;
      let width = labelWidths.current.get(widthKey);
      if (width == null) {
        width = ctx.measureText(text).width;
        labelWidths.current.set(widthKey, width);
      }
      const left = align === "center" ? x - width / 2 : x;
      const box = { left: left - 2, top: y - size - 1, right: left + width + 2, bottom: y + 3 };
      if (box.right < 0 || box.left > canvasWidth || box.bottom < 0 || box.top > HEIGHT) return;
      if (!force && placed.some((other) =>
        box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) return;
      placed.push(box);
      haloText(text, x, y, color, font, align);
    };
    // Station names wait for the label pass: the hubs early, the rest last.
    let hubLabels = () => {};
    let stationLabels = () => {};

    // Reference places sit above the listings so they are never buried.
    // Stations: small squares across the region, larger ones for the scored stations.
    if (layers.stations) {
      const half = pxPerKm < 8 ? 1.25 : pxPerKm < 30 ? 2 : 2.75;
      ctx.fillStyle = colors.railStation;
      ctx.strokeStyle = colors.markerOutline;
      ctx.lineWidth = half > 1.5 ? 1 : 0.5;
      const railLabels: CatalogPlace[] = [];
      for (const station of railStations) {
        const { x, y } = toScreen(station.lat, station.lon);
        if (x < -4 || y < -4 || x > canvasWidth + 4 || y > HEIGHT + 4) continue;
        ctx.fillRect(x - half, y - half, half * 2, half * 2);
        if (half > 1.5) ctx.strokeRect(x - half, y - half, half * 2, half * 2);
        railLabels.push(station);
      }
      ctx.lineWidth = 1;
      const scored = reference.catalog.inCategory("station");
      for (const station of scored) {
        const { x, y } = toScreen(station.lat, station.lon);
        const major = LABELLED_STATIONS.has(station.name);
        const size = major ? 4 : 3;
        ctx.fillStyle = colors.station;
        ctx.strokeStyle = colors.markerOutline;
        ctx.fillRect(x - size, y - size, size * 2, size * 2);
        ctx.strokeRect(x - size, y - size, size * 2, size * 2);
      }
      // Scored stations have English names; the region's stations only Japanese ones.
      const stationName = (station: CatalogPlace) => {
        const english = station.attributes?.nameEn;
        return language === "en" && typeof english === "string" ? english : station.name.replace(/〈.*〉$/u, "");
      };
      hubLabels = () => {
        for (const station of scored.filter((candidate) => LABELLED_STATIONS.has(candidate.name))) {
          const { x, y } = toScreen(station.lat, station.lon);
          label(stationName(station), x + 7, y - 5, colors.stationLabel, { font: `600 11px ${FONT}` });
        }
      };
      if (pxPerKm >= RAIL_STATION_LABEL_MIN_PX_PER_KM) {
        // Scored stations first, then the region's stations, busiest first.
        stationLabels = () => {
          for (const station of scored.filter((candidate) => !LABELLED_STATIONS.has(candidate.name))) {
            const { x, y } = toScreen(station.lat, station.lon);
            label(stationName(station), x + 6, y - 4, colors.stationLabel, { font: `600 10px ${FONT}`, size: 10 });
          }
          for (const station of railLabels) {
            const { x, y } = toScreen(station.lat, station.lon);
            label(stationName(station), x + half + 3, y - half - 1, colors.railStationLabel, { font: `10px ${FONT}`, size: 10 });
          }
        };
      }
    }

    // Mosque candidates as purple diamonds; scoring uses the nearest selected one.
    if (layers.mosques) {
      for (const mosque of areaPlaces.mosques) {
        const { x, y } = toScreen(mosque.lat, mosque.lon);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = colors.mosque;
        ctx.strokeStyle = colors.markerOutline;
        ctx.fillRect(-5, -5, 10, 10);
        ctx.strokeRect(-5, -5, 10, 10);
        ctx.restore();
      }
    }

    // Private schools left out of the poi1 score as outlined stars.
    const scoredIds = new Set(scoredPois.map((poi) => poi.id));
    const otherPois = areaPlaces.pois.filter((poi) => !scoredIds.has(poi.id));
    for (const poi of otherPois) {
      const { x, y } = toScreen(poi.lat, poi.lon);
      starPath(ctx, x, y, 8);
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors.target;
      ctx.stroke();
    }

    // The scored private schools (every one by default) as red stars.
    for (const poi of scoredPois) {
      const { x, y } = toScreen(poi.lat, poi.lon);
      drawStar(ctx, x, y, 10, colors.target);
    }

    // Names, most important first. The scored schools are always named; the
    // other private schools and the mosques next, as far as they fit (they
    // crowd together when zoomed out).
    for (const poi of scoredPois) {
      const { x, y } = toScreen(poi.lat, poi.lon);
      label(poi.name, x + 12, y + 4, colors.targetLabel, { font: `600 11px ${FONT}`, force: true });
    }
    for (const poi of otherPois) {
      const { x, y } = toScreen(poi.lat, poi.lon);
      label(poi.name, x + 10, y + 4, colors.targetLabel);
    }
    if (layers.mosques) {
      for (const mosque of areaPlaces.mosques) {
        const { x, y } = toScreen(mosque.lat, mosque.lon);
        label(mosque.name, x + 9, y + 4, colors.mosqueLabel);
      }
    }
    const labelCity = (layer: CityLayer, color: string, font: string, force = false) => {
      if (!layer.labelAt || !onScreen(layer.extent)) return;
      const topLeft = toScreen(layer.extent.maxLat, layer.extent.minLon);
      const bottomRight = toScreen(layer.extent.minLat, layer.extent.maxLon);
      if (!layer.focus && (bottomRight.x - topLeft.x < CITY_LABEL_MIN_PX.width || bottomRight.y - topLeft.y < CITY_LABEL_MIN_PX.height)) return;
      const { x, y } = toScreen(layer.labelAt[1], layer.labelAt[0]);
      label(cityName(layer.city, language), x, y, color, { font, size: 13, align: "center", force });
    };
    for (const layer of focus) labelCity(layer, colors.focusLabel, `600 13px ${FONT}`, true);
    hubLabels();
    if (pxPerKm <= PREFECTURE_LABEL_MAX_PX_PER_KM) {
      for (const prefecture of prefectures.layers) {
        if (!prefecture.labelAt) continue;
        const { x, y } = toScreen(prefecture.labelAt[1], prefecture.labelAt[0]);
        const name = language === "en" && prefecture.nameEn ? prefecture.nameEn : prefecture.name;
        label(name, x, y, colors.prefectureLabel, { font: `700 15px ${FONT}`, size: 15, align: "center" });
      }
    }
    for (const layer of neighbours) labelCity(layer, colors.cityLabel, `600 12px ${FONT}`);
    stationLabels();

    if (selectedDot) drawEmphasis(ctx, selectedDot, colors.selected, marks[selectedDot.key]);
    if (hoveredDot && hoveredDot.key !== selected) drawEmphasis(ctx, hoveredDot, colors.hovered, marks[hoveredDot.key]);
  }, [drawOrder, reference, scoredPois, cityLayers, prefectures, railStations, areaPlaces, project, toScreen, basePxPerKm, view, canvasWidth, frameShift, hovered, selected, marks, layers, newWithinDays, ringCenters, ringMetresPerMinute, language]);

  // Wheel zoom toward the cursor. Attached manually so preventDefault works
  // (React's onWheel is passive and cannot block the page from scrolling).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      autoFitted.current = true;
      const { mx: screenX, my } = canvasCoords(canvas, e.clientX, e.clientY);
      // The view transform lives in frame coordinates.
      const mx = screenX - frameShiftRef.current;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const scale = clamp(v.scale * factor, MIN_SCALE, maxScaleRef.current);
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
      const scale = clamp(v.scale * factor, MIN_SCALE, maxScale);
      const k = scale / v.scale;
      const cx = WIDTH / 2;
      const cy = HEIGHT / 2;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  };

  const fitToListings = () => setView(fitView(items, project, Math.min(locateScale * 2, maxScale)));

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
  const hoverVisible = hoverPoint && hoverPoint.x >= 0 && hoverPoint.x <= canvasWidth && hoverPoint.y >= 0 && hoverPoint.y <= HEIGHT;

  return (
    <section className={appStyles.card}>
      <h2 className={appStyles.cardTitle}>Map</h2>
      <div className={styles.wrap}>
        <canvas
          ref={canvasRef}
          className={`${styles.canvas} ${dragging ? styles.dragging : overDot ? styles.overDot : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => {
            onHover(null);
            setOverDot(false);
          }}
        />
        <button
          type="button"
          className={`${styles.areasButton} ${pickingAreas ? styles.layerOn : ""}`}
          aria-expanded={pickingAreas}
          title="Choose which areas the map shows, and the language of place names"
          onClick={() => setPickingAreas((open) => !open)}
        >
          ⚙ Areas · {areas.size}
        </button>
        {pickingAreas && (
          <AreaPicker
            cities={areaCities}
            borders={borderEdges}
            selected={areas}
            onChange={onSetAreas}
            onReset={onResetAreas}
            language={language}
            onLanguage={onSetLanguage}
            onClose={() => setPickingAreas(false)}
          />
        )}
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
              left: `clamp(4px, calc(${(hoverPoint.x / canvasWidth) * 100}% - ${HOVER_CARD_WIDTH / 2}px), calc(100% - ${HOVER_CARD_WIDTH + 4}px))`,
              top: `${(hoverPoint.y / HEIGHT) * 100}%`,
              width: HOVER_CARD_WIDTH,
              transform: hoverPoint.y < HEIGHT * 0.25 ? "translateY(18px)" : "translateY(calc(-100% - 18px))",
            }}
          />
        )}
        {selectedRow && (
          <MapListingCard
            row={selectedRow}
            distances={selectedDistances}
            targetPoiId={scoredPoiId}
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
            title="Show all the chosen areas"
            aria-label="Show all the chosen areas"
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
            {scoredPois.length > 0 && <span><i className={styles.keyStar}>★</i>Scored private school</span>}
            {reference.catalog.inCategory("poi").length > scoredPois.length && (
              <span><i className={styles.keyStar}>☆</i>Other private school</span>
            )}
            <span><i className={styles.keyMosque} />Mosque</span>
            <span><i className={styles.keyStation} />Scored station</span>
            {layers.stations && <span><i className={styles.keyRailStation} />Other station</span>}
            {prefectures.borders.length > 0 && <span><i className={styles.keyPrefecture} />Prefecture border</span>}
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
            <span style={{ width: `calc(${(scaleBar.px / canvasWidth) * 100} * 1cqw)` }} />
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
  distances,
  targetPoiId,
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
  distances: readonly ListingDistance[];
  targetPoiId: string | undefined;
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
    .sort((a, b) => b.weight - a.weight);
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
      {distances.length > 0 && (
        <ul className={styles.popupDistances} aria-label="Distances">
          {distances.map((distance) => (
            <li key={distance.key} className={distance.key === targetPoiId ? styles.distanceTarget : undefined}>
              <span className={styles.distanceLabel}>
                {distance.label}
                {distance.place && <small>{distance.place}</small>}
              </span>
              <span className={styles.distanceKm}>{formatKm(distance.distM)}</span>
              <span
                className={styles.distanceWalk}
                title={distance.advertised ? "Walk time as advertised (徒歩分)" : "Estimated walk: straight line × detour factor at walking speed"}
              >
                🚶 {Math.round(distance.walkMin)} min{distance.advertised && <small> listed</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rankedParts.length > 0 && (
        <details className={styles.popupScores}>
          <summary>Score breakdown</summary>
          <div className={styles.popupBreakdown}>
            {rankedParts.map((part) => (
              <div key={part.key} title={part.detail}>
                <span>{label(part.key)}</span>
                <span>{part.score!.toFixed(0)} <small>×w{part.weight}</small></span>
              </div>
            ))}
          </div>
        </details>
      )}
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
function fitView(
  items: readonly ScoredRow[],
  project: (lat: number, lon: number) => { x: number; y: number },
  maxFitScale: number,
): View {
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
    Math.max(MIN_SCALE, maxFitScale),
  );
  if (scale <= MIN_SCALE * 1.05) return IDENTITY;
  return { scale, tx: WIDTH / 2 - ((minX + maxX) / 2) * scale, ty: HEIGHT / 2 - ((minY + maxY) / 2) * scale };
}

/** Mouse client coords → canvas coordinate space (HEIGHT units tall, pre-DPR). */
function canvasCoords(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const unitsPerPx = HEIGHT / rect.height;
  return {
    mx: (clientX - rect.left) * unitsPerPx,
    my: (clientY - rect.top) * unitsPerPx,
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
function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number, alpha: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(cx - half, cy - half);
  ctx.lineTo(cx + half, cy + half);
  ctx.moveTo(cx + half, cy - half);
  ctx.lineTo(cx - half, cy + half);
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.75;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
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
