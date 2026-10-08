/** One detail fetch, all useful fields; deterministic replay over cached HTML. */
import * as cheerio from "cheerio";
import type { ListingDetailPatch } from "../../data-layer/ingestion/contracts";
import { toListingAgency } from "../shared/agency";
import { parseParking } from "../shared/parking";
import { parseLease, parseImmediate, parseGuarantorRequired, parseYenStrict, splitTags } from "../shared/parseJa";

export function parseDetail(html: string): ListingDetailPatch {
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
  // この物件を取り扱う店舗: the advertising store, its office address and licence.
  const shop = $("h2").filter((_, el) => $(el).text().includes("取り扱う店舗")).first().next(".itemcassette");
  const agencyInfo = toListingAgency({
    name: shop.find(".itemcassette-header-ttl").first().text(),
    address: shop.find(".itemcassette_matrix-cell01").first().text(),
    phone: shop.find(".itemcassette_matrix-cell04").first().text(),
    licence: shop.find(".itemcassette-header-sub").map((_, el) => $(el).text()).get().join(" "),
  });
  return {
    ...(parking ? { parking } : {}),
    ...(agencyInfo ? { agency: agencyInfo.name, agencyInfo } : {}),
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
