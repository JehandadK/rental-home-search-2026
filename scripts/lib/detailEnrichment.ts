/** One detail fetch, all useful fields; deterministic replay over cached HTML. */
import * as cheerio from "cheerio";
import type { RawListing } from "../../src/types";
import { parseParking } from "./parking";
import { parseLease, parseImmediate, parseGuarantorRequired, parseYenStrict, splitTags } from "./parseJa";

export function parseDetail(html: string): Partial<RawListing> {
  const $ = cheerio.load(html);
  const kv: Record<string, string> = {};
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  $("th,dt").each((_, el) => {
    const value = $(el).next("td,dd");
    const key = clean($(el).text());
    if (key && value.length) kv[key] = clean(value.text());
  });
  if (!("駐車場" in kv) && !("間取り" in kv) && !("契約期間" in kv)) throw new Error("Unrecognized detail page (not an empty listing)");
  const parking = kv["駐車場"] == null ? undefined : parseParking(kv["駐車場"]);
  const features = $(".inline_list li").map((_, el) => clean($(el).text())).get().filter(Boolean);
  const available = kv["入居"] ?? kv["入居可能時期"];
  return {
    ...(parking ? { parking } : {}),
    sourceDetails: kv,
    costs: {
      ...(parking ? { parking, parkingYen: parking.monthlyYen } : {}),
      renewalFeeYen: parseYenStrict(kv["更新料"]),
      cleaningFeeYen: parseYenStrict(kv["清掃費"] ?? kv["クリーニング費"]),
      guarantorRequired: parseGuarantorRequired(kv["保証会社"]),
      feeNotes: [kv["ほか初期費用"], kv["ほか諸費用"], kv["その他費用"]].filter(Boolean).join(" / ") || null,
    },
    tenancy: { ...parseLease(kv["契約期間"]), availableFrom: available ?? null, immediateMoveIn: parseImmediate(available) },
    building: { structure: kv["構造"] ?? kv["建物構造"] ?? null,
      features: [...new Set([...features, ...(splitTags(kv["設備"]) ?? [])])], conditions: splitTags(kv["条件"] ?? kv["条件等"]) },
  };
}
const defined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, v]) => v != null && (!Array.isArray(v) || v.length > 0))) as Partial<T>;
export function applyDetail(listing: RawListing, detail: Partial<RawListing>): RawListing {
  return { ...listing, ...defined(detail),
    costs: { ...listing.costs, ...defined(detail.costs ?? {}) },
    tenancy: { ...listing.tenancy, ...defined(detail.tenancy ?? {}) },
    building: { ...listing.building, ...defined(detail.building ?? {}) },
  };
}
