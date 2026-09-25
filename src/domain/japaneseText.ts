/** Full-width digits/punctuation → ASCII, shared by domain rules and source parsers. */
export function toHalfWidth(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[，、]/g, ",")
    .replace(/[／]/g, "/")
    .replace(/[　]/g, " ");
}

/** "4階/8階建" → { floor: "4階", totalFloors: 8 } · "1-2階/地上2階建" → 2 */
export function parseFloors(text: string | undefined | null): {
  floor: string | null;
  totalFloors: number | null;
} {
  if (!text) return { floor: null, totalFloors: null };
  const t = toHalfWidth(text).trim();
  const [left, right] = t.split("/");
  const total = (right ?? t).match(/(?:地上)?(\d+)\s*階建/);
  const floor = left && left !== t.split("/")[1] ? left.trim() : null;
  return {
    floor: floor && floor !== "" ? floor : null,
    totalFloors: total ? parseInt(total[1], 10) : null,
  };
}
