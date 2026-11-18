/**
 * Pictograms for the map's reference places, drawn on a 16 × 16 grid.
 *
 * One path per icon, filled with the even-odd rule so windows and doors are
 * holes. The canvas draws them as white glyphs on a coloured rounded square
 * (`drawIconBadge`), so a place never reads as a listing, which is a round
 * dot; the layer chips and the legend show the same badge as inline SVG.
 */
export type MapIconName = "school" | "kindergarten" | "shop" | "mosque" | "carAuction";

export const MAP_ICON_PATHS: Record<MapIconName, string> = {
  // A schoolhouse: flag, pitched roof, two windows and a door.
  school:
    "M7.4 .6h1.2v.5H12v2.5H8.6v.9l6.2 3.7v1.3H13.4V15H9.6v-3H6.4v3H2.6V9.5H1.2V8.2l6.2-3.7z"
    + "M3.9 10.6h1.8v1.6H3.9zM10.3 10.6h1.8v1.6h-1.8z",
  // A tulip, the usual mark of a Japanese kindergarten.
  kindergarten:
    "M8 1c1 .9 1.6 1.8 1.8 2.6.6-.6 1.4-.9 2.3-1 0 3.5-1.5 5.8-4.1 5.8S3.9 6.1 3.9 2.6c.9.1 1.7.4 2.3 1C6.4 2.8 7 1.9 8 1z"
    + "M7.4 8.2h1.2V15H7.4z"
    + "M7.4 13.4c-2 0-3.6-1.3-4.2-3.7 2.1 0 3.6 1 4.2 2.6zM8.6 13.4c2 0 3.6-1.3 4.2-3.7-2.1 0-3.6 1-4.2 2.6z",
  // A shopping cart.
  shop:
    "M.8 2h2.6l.5 2H15l-1.7 6.4H5.3L3 3.4H.8zM5.9 12.1a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9z"
    + "M12 12.1a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9z",
  // A domed prayer hall with a finial and an arched door.
  mosque:
    "M7.6.8h.8v2.3c2.4 1.5 3.7 3 3.9 4.9h1.2V15h-4v-2.6a1.5 1.5 0 0 0-3 0V15h-4V8h1.2c.2-1.9 1.5-3.4 3.9-4.9z",
  // A car seen from the front.
  carAuction:
    "M2.2 8l1.6-3.7c.2-.5.7-.8 1.2-.8h6c.5 0 1 .3 1.2.8L13.8 8c.7.2 1.2.9 1.2 1.6v3.2h-1.4V14h-2.2v-1.2H4.6V14H2.4v-1.2H1V9.6C1 8.9 1.5 8.2 2.2 8z"
    + "M4.3 7.8l1-2.4h5.4l1 2.4zM3 9.5h2.1v1.3H3zM10.9 9.5H13v1.3h-2.1z",
};

const paths = new Map<MapIconName, Path2D>();

/**
 * A rounded square of `size` pixels centred on (x, y), filled with `color`
 * and outlined, with the icon in white. `hollow` swaps the two colours, for
 * a place of the layer that the score leaves out.
 */
export function drawIconBadge(
  ctx: CanvasRenderingContext2D,
  icon: MapIconName,
  x: number,
  y: number,
  size: number,
  color: string,
  outline: string,
  hollow = false,
): void {
  let path = paths.get(icon);
  if (!path) {
    path = new Path2D(MAP_ICON_PATHS[icon]);
    paths.set(icon, path);
  }
  const half = size / 2;
  const radius = size * 0.28;
  ctx.beginPath();
  ctx.roundRect(x - half, y - half, size, size, radius);
  ctx.fillStyle = hollow ? outline : color;
  ctx.fill();
  ctx.lineWidth = hollow ? 1.5 : 1;
  ctx.strokeStyle = hollow ? color : outline;
  ctx.stroke();
  ctx.lineWidth = 1;
  // The glyph fills the badge but for a margin.
  const scale = (size * 0.72) / 16;
  ctx.save();
  ctx.translate(x - 8 * scale, y - 8 * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = hollow ? color : outline;
  ctx.fill(path, "evenodd");
  ctx.restore();
}

/** The same badge as inline SVG, for layer chips and the legend. `color` is any CSS colour, a custom property included. */
export function MapIconBadge({ icon, color, size = 12 }: { icon: MapIconName; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true" style={{ flex: "none" }}>
      <rect x="0.5" y="0.5" width="21" height="21" rx="6" fill={color} />
      <path d={MAP_ICON_PATHS[icon]} transform="translate(3 3)" fill="var(--rs-map-marker-outline)" fillRule="evenodd" />
    </svg>
  );
}
