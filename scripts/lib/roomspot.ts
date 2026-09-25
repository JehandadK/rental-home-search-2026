/** Pure RoomSpot search-result parser and incremental merge helpers. */
import * as cheerio from "cheerio";
import type { RawListing } from "../../src/types";
import type { ListingObservationBatch } from "../../src/data-layer/contracts";
import { trackingKey } from "./lifecycle";
import { isExplicitNone, parseYen } from "./parseJa";

const norm = (value: string | null | undefined): string =>
  (value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export function roomspotKey(listing: RawListing): string {
  const id = listing.id?.match(/roomspot-(\d+)/)?.[1] ?? listing.url?.match(/\/rent\/(\d+)/)?.[1];
  return id ? `roomspot:${id}` : `property:${trackingKey(listing)}`;
}

export function roomspotMatchKeys(listing: RawListing): string[] {
  return [...new Set([
    roomspotKey(listing),
    `property:${trackingKey(listing)}`,
    `market:${norm(listing.address)}|${listing.rent}|${listing.sizeM2 ?? ""}|${norm(listing.layout)}`,
  ])];
}

export function isRoomspotOverlap(a: RawListing, b: RawListing): boolean {
  const aliases = new Set(roomspotMatchKeys(a));
  return roomspotMatchKeys(b).some((alias) => aliases.has(alias));
}

export function isFamilyLayout(layout: string | null): boolean {
  const rooms = layout?.normalize("NFKC").match(/^(\d+)/)?.[1];
  return rooms != null && Number(rooms) >= 2;
}

function parseRent(text: string): number | null {
  const normalized = text.normalize("NFKC").replace(/[\s,]/g, "");
  const man = normalized.match(/(\d+)万(\d+)?/);
  if (man) return Number(man[1]) * 10_000 + Number(man[2] ?? 0);
  return parseYen(normalized);
}

function parseMonths(text: string, baseRent: number): number | null {
  const normalized = text.normalize("NFKC").trim();
  if (isExplicitNone(normalized) || /(^|\s)0(?:\.0+)?ヶ月/.test(normalized)) return 0;
  const match = normalized.match(/([\d.]+)ヶ月/);
  if (match) return Math.round(Number(match[1]) * baseRent);
  return parseYen(normalized);
}

function parseStation(text: string): { station: string | null; walkMin: number | null } {
  const match = text.match(/([^\s]+駅)\s*徒歩(\d+)分/);
  return match ? { station: match[1], walkMin: Number(match[2]) } : { station: null, walkMin: null };
}

/** Parse all 2K+ room rows from RoomSpot's result HTML. */
export function parseRoomspotPage(html: string, city: string): RawListing[] {
  const $ = cheerio.load(html);
  const listings: RawListing[] = [];
  $("article.data").each((_, article) => {
    const building = $(article);
    const buildingName = building.find("h2").first().text().trim();
    const address = building.find(".kokoku-list-data__address").last().text().replace(/\s+/g, " ").trim();
    const traffic = building.find(".kokoku-list-data__access").last().text().replace(/\s+/g, " ").trim();
    const ageText = building.find(".kokoku-list-data__age").last().text().trim();
    const station = parseStation(traffic);
    const builtYear = Number(ageText.match(/(19\d{2}|20\d{2})年/)?.[1]) || null;

    building.find(".room_data tbody tr").each((_, row) => {
      const tr = $(row);
      const href = tr.find('a[href*="/rent/"]').first().attr("href");
      const id = href?.match(/\/rent\/(\d+)/)?.[1];
      const layoutText = tr.find(".kokoku-list-condition__layout").text().replace(/\s+/g, " ").trim();
      const layout = layoutText.match(/(\d+(?:S?LDK|SDK|SLDK|DK|LDK|K))/i)?.[1] ?? null;
      if (!id || !href || !buildingName || !address || !isFamilyLayout(layout)) return;
      const size = layoutText.match(/([\d.]+)㎡/);
      const priceCell = tr.find(".kokoku-list-condition__price");
      const baseRent = parseRent(priceCell.find("strong").text());
      if (baseRent == null) return;
      // The PC span is the canonical admin fee; avoid counting hidden mobile duplicate text.
      const adminFee = parseYen(priceCell.find("span.pc").first().text()) ?? 0;
      const moveIn = tr.find(".kokoku-list-condition__deposit").text().replace(/\s+/g, " ");
      const depositText = moveIn.match(/敷金\s*([^/]+?)(?=礼金|\/|$)/)?.[1]?.trim() ?? "";
      const keyText = moveIn.match(/礼金\s*([^/]+?)$/)?.[1]?.trim() ?? "";
      const floor = tr.find(".kokoku-list-condition__floor").text().trim() || null;

      listings.push({
        id: `roomspot-${id}`,
        name: `${buildingName}${floor ? ` ${floor}` : ""}`,
        address: address.startsWith("埼玉県") ? address : `埼玉県${address}`,
        city,
        rent: baseRent + adminFee,
        layout,
        sizeM2: size ? Number(size[1]) : null,
        builtYear,
        depositYen: parseMonths(depositText, baseRent),
        keyMoneyYen: parseMonths(keyText, baseRent),
        advertisedStation: station.station,
        stationWalkMin: station.walkMin,
        url: new URL(href, "https://www.roomspot.net").href,
        source: "roomspot",
        notes: `${ageText}${floor ? `・${floor}` : ""}・管理費${adminFee.toLocaleString()}円`,
        costs: {
          adminFeeYen: adminFee,
          depositYen: parseMonths(depositText, baseRent),
          keyMoneyYen: parseMonths(keyText, baseRent),
        },
        building: { floor },
      });
    });
  });
  return listings;
}

export function roomspotObservationBatch(input: {
  previous: readonly RawListing[];
  current: readonly RawListing[];
  expectedRevision: string | null;
  observedAt: string;
  observedAtByKey: Readonly<Record<string, string>>;
  provenance: Readonly<Record<string, unknown>>;
  completeness?: "incremental" | "complete";
}): ListingObservationBatch {
  const currentIds = new Set(input.current.map((listing) => listing.id).filter((id): id is string => Boolean(id)));
  const currentAliases = new Set(input.current.flatMap(roomspotMatchKeys));
  const retirements = input.previous
    .filter((listing) =>
      listing.id && !currentIds.has(listing.id) && roomspotMatchKeys(listing).some((key) => currentAliases.has(key)),
    )
    .map((listing) => ({
      id: listing.id!,
      effectiveAt: input.observedAt,
      reason: "Superseded by a newer RoomSpot advertisement with matching unit aliases",
    }));

  return {
    source: "roomspot",
    expectedRevision: input.expectedRevision,
    observedAt: input.observedAt,
    completeness: input.completeness ?? "incremental",
    observations: input.current.map((listing) => {
      if (!listing.id) throw new Error(`RoomSpot listing has no stable source ID: ${listing.name}`);
      return {
        source: "roomspot",
        sourceListingId: listing.id,
        observedAt: input.observedAtByKey[trackingKey(listing)] ?? input.observedAt,
        listing,
      };
    }),
    retirements,
    provenance: input.provenance,
  };
}

export function mergeRoomspotIncremental(
  existing: readonly RawListing[],
  discovered: readonly RawListing[],
): { listings: RawListing[]; added: number; updated: number; overlaps: number } {
  const byAlias = new Map<string, RawListing>();
  for (const listing of existing) for (const alias of roomspotMatchKeys(listing)) if (!byAlias.has(alias)) byAlias.set(alias, listing);
  const used = new Set<RawListing>();
  const seen = new Set<string>();
  const listings: RawListing[] = [];
  let added = 0, updated = 0, overlaps = 0;
  for (const fresh of discovered) {
    const aliases = roomspotMatchKeys(fresh);
    if (aliases.some((alias) => seen.has(alias))) { overlaps++; continue; }
    const prior = aliases.map((alias) => byAlias.get(alias)).find(Boolean);
    aliases.forEach((alias) => seen.add(alias));
    if (prior) { used.add(prior); overlaps++; updated++; listings.push({ ...prior, ...fresh }); }
    else { added++; listings.push(fresh); }
  }
  for (const prior of existing) {
    if (used.has(prior) || roomspotMatchKeys(prior).some((alias) => seen.has(alias))) continue;
    roomspotMatchKeys(prior).forEach((alias) => seen.add(alias)); listings.push(prior);
  }
  return { listings, added, updated, overlaps };
}
