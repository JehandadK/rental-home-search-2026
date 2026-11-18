/**
 * Market check: what similar homes ask, so an under-priced home stands out.
 *
 * The score's rent criteria compare a home to fixed anchors ("¥50,000 is
 * perfect"). They cannot say whether ¥98,000 is cheap *for this home*: a
 * 85 ㎡ house five minutes from a station at that rent is a find, a 40 ㎡ flat
 * is not. This module answers that from the listings themselves, in two steps:
 *
 *   1. A hedonic fit over every listing: log rent against floor area, age,
 *      station walk, rooms, building type and a broad location trend.
 *   2. The neighbours: the homes nearest on the map and closest in size and
 *      age, the most similar counting most. What they ask relative to the fit
 *      corrects it for the neighbourhood (a school district, a noisy road),
 *      and their rents scaled to this home's floor area are blended in, so
 *      the estimate stays near the evidence shown for it.
 *
 * The result is an estimate, not an appraisal. Leaving each home out of its
 * own neighbours, it lands within 7% of the asking rent for half the
 * published homes and within 23% for nine in ten. So only a clear gap is
 * called a deal, and never where a home has few neighbours to compare with.
 * A large gap can also mean a fact the ad left out (a fixed-term lease, a
 * shop let as a home, a typo), which is why the evidence is shown beside it.
 *
 * Pure and synchronous: about 200 ms for 7,000 listings, so callers run it
 * after the first paint rather than before it.
 */
import { listingKey } from "./listingKey";
import type { EnrichedListing } from "./types";

/** A nearby similar home the estimate leaned on, shown as evidence. */
export interface MarketComparable {
  key: string;
  name: string;
  rent: number;
  sizeM2: number;
  builtYear: number;
  layout: string | null;
  /** Straight-line distance from the home being estimated, metres. */
  distanceM: number;
}

export type MarketConfidence = "high" | "medium" | "low";

export interface MarketEstimate {
  /** What similar homes ask per month (management fee included), to the nearest ¥100. */
  expectedRent: number;
  /** Asking rent minus expected rent, yen. Negative: cheaper than similar homes. */
  deltaYen: number;
  /** Asking rent ÷ expected rent − 1. −0.12 is 12% under. */
  deltaRatio: number;
  /** How much nearby evidence stands behind the estimate. */
  confidence: MarketConfidence;
  /** The most similar nearby homes, nearest first. */
  comparables: MarketComparable[];
}

export type MarketVerdict = "deal" | "fair" | "pricey";

/** At or below this ratio a home is called a deal; at or above PRICEY_RATIO, pricey. */
export const DEAL_RATIO = -0.15;
export const PRICEY_RATIO = 0.2;

/** Fewer usable listings than this and no estimate is made at all. */
export const MIN_MARKET_SAMPLE = 60;

/**
 * Deal, fair or pricey. Null when there is no estimate or too little nearby
 * evidence to call it: a guess is never shown as a verdict.
 */
export function marketVerdict(estimate: MarketEstimate | undefined): MarketVerdict | null {
  if (!estimate || estimate.confidence === "low") return null;
  if (estimate.deltaRatio <= DEAL_RATIO) return "deal";
  if (estimate.deltaRatio >= PRICEY_RATIO) return "pricey";
  return "fair";
}

/** "−12%" / "+8%" / "±0%", with a true minus sign. */
export function formatMarketDelta(ratio: number): string {
  const percent = Math.round(ratio * 100);
  if (percent === 0) return "±0%";
  return `${percent < 0 ? "−" : "+"}${Math.abs(percent)}%`;
}

type Usable = EnrichedListing & { sizeM2: number; builtYear: number; lat: number; lon: number };

const usable = (listing: EnrichedListing): listing is Usable =>
  listing.rent >= 10_000 &&
  listing.sizeM2 != null && listing.sizeM2 > 0 &&
  listing.builtYear != null &&
  Number.isFinite(listing.lat) && Number.isFinite(listing.lon);

/** Homes whose floor area is outside this range are estimated with low confidence. */
const SIZE_RANGE = [15, 130] as const;
const NEIGHBOURS = 24;
/** Evidence worth eight homes a kilometre away: below it the neighbours are trusted only partly. */
const EVIDENCE_PRIOR = 8 / 1.2 ** 2;
/** How rent grows with floor area among otherwise similar homes: 10% more space, about 7% more rent. */
const SIZE_ELASTICITY = 0.7;
/** How much of the estimate comes from the neighbours' rents read directly, at full evidence. */
const COMPS_BLEND = 0.5;
const KM_PER_DEGREE = 111.32;
/** Grid cell for the neighbour search, in degrees of latitude (about 450 m). */
const CELL_DEGREES = 0.004;
/** How far the neighbour search widens, in cells (about 9 km). */
const MAX_RINGS = 20;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const roomCount = (layout: string | null) => clamp(Number(/^(\d)/.exec(layout ?? "")?.[1] ?? 1), 1, 5);
const isHouse = (listing: EnrichedListing) =>
  /戸建|一戸建|貸家|テラスハウス/.test(listing.name) || /\d-\d+階/.test(listing.building?.floor ?? "");
const floorOf = (listing: EnrichedListing) => {
  const match = /(\d+)階/.exec(listing.building?.floor ?? "");
  return match ? Number(match[1]) : null;
};
const structureOf = (listing: EnrichedListing): "rc" | "steel" | "wood" | null => {
  const structure = listing.building?.structure ?? "";
  if (/鉄筋|RC|ＲＣ/.test(structure)) return "rc";
  if (/鉄骨|軽量/.test(structure)) return "steel";
  if (/木/.test(structure)) return "wood";
  return null;
};

/**
 * Two listings that are one offer as far as pricing goes: the same spot, year
 * and floor area, at the same rent to within 3%. Portals round and reword, so
 * names and ids cannot settle it, and an unanswered possible duplicate is
 * still two listings here.
 */
function isSameOffer(a: Usable, b: Usable, km: number): boolean {
  return km < 0.03 &&
    a.builtYear === b.builtYear &&
    Math.abs(a.sizeM2 - b.sizeM2) < 1 &&
    Math.abs(a.rent - b.rent) <= 0.03 * a.rent;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The value at which half the total weight lies on either side. */
function weightedMedian(entries: readonly { value: number; weight: number }[]): number {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, entry) => sum + entry.weight, 0) / 2;
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= half) return entry.value;
  }
  return sorted.length ? sorted[sorted.length - 1].value : 0;
}

/** Ridge least squares by Gaussian elimination with partial pivoting. */
function solve(rows: number[][], targets: number[], ridge = 1e-3): Float64Array {
  const width = rows[0].length;
  const system = Array.from({ length: width }, () => new Float64Array(width + 1));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let j = 0; j < width; j++) {
      system[j][width] += row[j] * targets[i];
      for (let k = 0; k <= j; k++) system[j][k] += row[j] * row[k];
    }
  }
  for (let j = 0; j < width; j++) {
    for (let k = 0; k < j; k++) system[k][j] = system[j][k];
    system[j][j] += ridge * rows.length;
  }
  for (let i = 0; i < width; i++) {
    let pivot = i;
    for (let r = i + 1; r < width; r++) if (Math.abs(system[r][i]) > Math.abs(system[pivot][i])) pivot = r;
    [system[i], system[pivot]] = [system[pivot], system[i]];
    for (let r = i + 1; r < width; r++) {
      const factor = system[r][i] / system[i][i];
      for (let c = i; c <= width; c++) system[r][c] -= factor * system[i][c];
    }
  }
  const weights = new Float64Array(width);
  for (let i = width - 1; i >= 0; i--) {
    let sum = system[i][width];
    for (let c = i + 1; c < width; c++) sum -= system[i][c] * weights[c];
    weights[i] = sum / system[i][i];
  }
  return weights;
}

const dot = (weights: Float64Array, row: number[]) => {
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += row[i] * weights[i];
  return sum;
};

/**
 * Estimate the market rent of every listing that states its size, age and
 * location, keyed by listingKey. Pass every listing held, not a filtered set:
 * the estimate should not change with the filters.
 */
export function estimateMarketRents(
  listings: readonly EnrichedListing[],
  now: Date = new Date(),
): Map<string, MarketEstimate> {
  const estimates = new Map<string, MarketEstimate>();
  const sample = listings.filter(usable);
  if (sample.length < MIN_MARKET_SAMPLE) return estimates;

  const year = now.getFullYear();
  const meanLat = sample.reduce((sum, listing) => sum + listing.lat, 0) / sample.length;
  const meanLon = sample.reduce((sum, listing) => sum + listing.lon, 0) / sample.length;
  const lonKm = KM_PER_DEGREE * Math.cos((meanLat * Math.PI) / 180);
  const walks = sample.flatMap((listing) => (listing.stationWalkMin == null ? [] : [listing.stationWalkMin]));
  const typicalWalk = walks.length ? median(walks) : 10;

  const features = (listing: Usable): number[] => {
    const logSize = Math.log(clamp(listing.sizeM2, SIZE_RANGE[0], SIZE_RANGE[1]));
    const age = clamp(year - listing.builtYear, 0, 50) / 10;
    const structure = structureOf(listing);
    const floor = floorOf(listing);
    // Tens of kilometres from the middle of the listings: a broad location trend.
    const east = ((listing.lon - meanLon) * lonKm) / 10;
    const north = ((listing.lat - meanLat) * KM_PER_DEGREE) / 10;
    return [
      1,
      logSize, logSize * logSize,
      age, age * age,
      clamp(listing.stationWalkMin ?? typicalWalk, 0, 30) / 10,
      listing.stationWalkMin == null ? 1 : 0,
      roomCount(listing.layout),
      /LDK/.test(listing.layout ?? "") ? 1 : 0,
      isHouse(listing) ? 1 : 0,
      structure === "rc" ? 1 : 0, structure === "steel" ? 1 : 0, structure === "wood" ? 1 : 0,
      floor == null ? 0 : clamp(floor, 1, 15) / 10,
      floor === 1 ? 1 : 0,
      east, north, east * east, north * north, east * north,
    ];
  };

  const rows = sample.map(features);
  const logRents = sample.map((listing) => Math.log(listing.rent));

  // Fit, then refit twice without the homes furthest from the fit: a typo or
  // a shop let as a home should not move what a normal home is expected to ask.
  let weights = solve(rows, logRents);
  for (let pass = 0; pass < 2; pass++) {
    const residuals = rows.map((row, i) => logRents[i] - dot(weights, row));
    const spread = Math.sqrt(residuals.reduce((sum, residual) => sum + residual * residual, 0) / residuals.length);
    const kept = residuals.map((residual) => Math.abs(residual) < 2.5 * spread);
    if (kept.filter(Boolean).length < MIN_MARKET_SAMPLE) break;
    weights = solve(rows.filter((_, i) => kept[i]), logRents.filter((_, i) => kept[i]));
  }
  const base = rows.map((row) => dot(weights, row));
  const residuals = base.map((value, i) => logRents[i] - value);

  // Neighbour search over a grid of ~450 m cells.
  const cellOf = (listing: Usable) =>
    [Math.floor(listing.lat / CELL_DEGREES), Math.floor((listing.lon * lonKm) / KM_PER_DEGREE / CELL_DEGREES)] as const;
  const cellId = (row: number, column: number) => row * 100_000 + column;
  const grid = new Map<number, number[]>();
  sample.forEach((listing, i) => {
    const id = cellId(...cellOf(listing));
    const cell = grid.get(id);
    if (cell) cell.push(i);
    else grid.set(id, [i]);
  });
  const ages = sample.map((listing) => year - listing.builtYear);

  sample.forEach((listing, i) => {
    const [row, column] = cellOf(listing);
    const nearby: number[] = [];
    // Widen ring by ring until there are enough homes; one more ring then
    // makes sure none nearer was missed across a cell edge.
    let enoughAt: number | null = null;
    for (let ring = 0; ring <= MAX_RINGS; ring++) {
      for (let r = row - ring; r <= row + ring; r++) {
        const edge = Math.abs(r - row) === ring;
        for (let c = column - ring; c <= column + ring; c += edge ? 1 : Math.max(1, 2 * ring)) {
          const cell = grid.get(cellId(r, c));
          if (cell) for (const j of cell) if (j !== i) nearby.push(j);
        }
      }
      if (enoughAt != null && ring > enoughAt) break;
      if (enoughAt == null && nearby.length >= NEIGHBOURS) enoughAt = ring;
    }

    // "Near" means close on the map, in size and in age: 10 ㎡ or 20 years
    // count like 200 m. The same flat next door is the best evidence there is.
    const ranked = nearby
      .flatMap((j) => {
        const other = sample[j];
        const km = Math.hypot((listing.lat - other.lat) * KM_PER_DEGREE, (listing.lon - other.lon) * lonKm);
        // The same room on another portal, or its twin next door at the same
        // rent, would only confirm the asking rent: three copies of a deal
        // made it read as fair, with itself as the evidence.
        if (isSameOffer(listing, other, km)) return [];
        return [{ j, km, similarity: km + 0.02 * Math.abs(other.sizeM2 - listing.sizeM2) + 0.01 * Math.abs(ages[j] - ages[i]) }];
      })
      .sort((a, b) => a.similarity - b.similarity)
      .slice(0, NEIGHBOURS);

    // What the neighbours ask relative to the fit, the most similar counting
    // most, leaned on in proportion to how much similar evidence there is.
    const weighted = ranked.map(({ j, similarity }) => ({ value: residuals[j], weight: 1 / (0.2 + similarity) ** 2 }));
    const evidence = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    const shrink = evidence / (evidence + EVIDENCE_PRIOR);
    const fitted = base[i] + shrink * weightedMedian(weighted);
    // The same neighbours read directly: their rents, scaled to this home's
    // floor area. Blending the two keeps the estimate near what the homes
    // shown as evidence actually ask, where the fit alone can drift (a new
    // build among old ones, a house among flats).
    const direct = weightedMedian(ranked.map(({ j, similarity }) => ({
      value: logRents[j] + SIZE_ELASTICITY * Math.log(listing.sizeM2 / sample[j].sizeM2),
      weight: 1 / (0.2 + similarity) ** 2,
    })));
    const blended = ranked.length ? (1 - COMPS_BLEND * shrink) * fitted + COMPS_BLEND * shrink * direct : fitted;
    const expectedRent = Math.round(Math.exp(blended) / 100) * 100;

    const reach = ranked.length ? ranked[ranked.length - 1].km : Infinity;
    const outsideRange = listing.sizeM2 < SIZE_RANGE[0] || listing.sizeM2 > SIZE_RANGE[1];
    const confidence: MarketConfidence =
      outsideRange || ranked.length < 8 || reach > 3 ? "low" : ranked.length >= NEIGHBOURS && reach <= 1.5 ? "high" : "medium";

    const comparables = ranked
      .filter(({ j }) => Math.abs(sample[j].sizeM2 - listing.sizeM2) <= 0.3 * listing.sizeM2)
      .slice(0, 4)
      .map(({ j, km }): MarketComparable => ({
        key: listingKey(sample[j]),
        name: sample[j].name,
        rent: sample[j].rent,
        sizeM2: sample[j].sizeM2,
        builtYear: sample[j].builtYear,
        layout: sample[j].layout,
        distanceM: Math.round(km * 1000),
      }));

    estimates.set(listingKey(listing), {
      expectedRent,
      deltaYen: listing.rent - expectedRent,
      deltaRatio: listing.rent / expectedRent - 1,
      confidence,
      comparables,
    });
  });

  return estimates;
}
