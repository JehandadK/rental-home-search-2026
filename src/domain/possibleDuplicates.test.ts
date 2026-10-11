import { describe, expect, it } from "vitest";
import type { EnrichedListing } from "./types";
import { isSameProperty } from "./listingDedup";
import { listingKey } from "./listingKey";
import {
  applySameDecisions,
  carryToLeads,
  findPossibleDuplicates,
  isDescriptiveName,
  isPendingPair,
  listingAdKeys,
  nameSimilarity,
  pairId,
  resolveDecisions,
  shownKey,
  type DuplicateDecision,
} from "./possibleDuplicates";

const make = (over: Partial<EnrichedListing> = {}): EnrichedListing => ({
  id: "athome-1162657225",
  name: "ベレオ ヴィラ リーブス東川口",
  address: "埼玉県川口市東川口１丁目",
  city: "Kawaguchi",
  rent: 172_000,
  layout: "2LDK",
  sizeM2: 62.17,
  builtYear: 2023,
  advertisedStation: "東川口駅",
  stationWalkMin: 7,
  url: "https://www.athome.co.jp/chintai/1162657225/",
  source: "athome",
  building: { floor: "3階" },
  geocoded: true,
  lat: 35.875,
  lon: 139.744,
  ...over,
});

/** The same room on Nifty: the automatic matcher keeps it apart (rent differs by 1.2%). */
const nifty = make({
  id: "nifty-0a1b2c",
  name: "ベレオヴィラリーブス東川口",
  address: "埼玉県川口市東川口１丁目19-16",
  rent: 170_000,
  url: "https://myhome.nifty.com/rent/saitama/kawaguchishi_ct/detail_0a1b2c/",
  source: "nifty",
});

const decision = (verdict: DuplicateDecision["verdict"], a: EnrichedListing, b: EnrichedListing): DuplicateDecision =>
  ({ verdict, a: listingAdKeys(a), b: listingAdKeys(b), decidedAt: "2026-10-11T05:00:00.000Z" });

describe("possible duplicates", () => {
  it("suggests a pair the automatic matcher keeps apart, with its evidence", () => {
    expect(isSameProperty(make(), nifty)).toBe(false);
    const [pair, ...rest] = findPossibleDuplicates([make(), nifty]);
    expect(rest).toEqual([]);
    expect(pair.keys).toEqual([listingKey(make()), listingKey(nifty)].sort());
    expect(pair.score).toBeGreaterThanOrEqual(0.85);
    expect(pair.reasons).toEqual(expect.arrayContaining(["same building name", "same 丁目", "rent ±¥2,000"]));
  });

  it("never pairs listings a unit fact separates", () => {
    expect(findPossibleDuplicates([make(), { ...nifty, city: "Soka" }])).toEqual([]);
    expect(findPossibleDuplicates([make(), { ...nifty, sizeM2: 64 }])).toEqual([]);
    expect(findPossibleDuplicates([make(), { ...nifty, layout: "3LDK" }])).toEqual([]);
    expect(findPossibleDuplicates([make(), { ...nifty, rent: 190_000 }])).toEqual([]);
    expect(findPossibleDuplicates([make(), { ...nifty, builtYear: 2019 }])).toEqual([]);
    expect(findPossibleDuplicates([make(), { ...nifty, building: { floor: "2階" } }])).toEqual([]);
    expect(findPossibleDuplicates([make(), { ...nifty, status: "sold" }])).toEqual([]);
  });

  it("needs location evidence: alike rooms in different places are different homes", () => {
    const elsewhere = { ...nifty, name: "グランドール", address: "埼玉県川口市芝５丁目", lat: 35.82, lon: 139.70 };
    expect(findPossibleDuplicates([make(), elsewhere])).toEqual([]);
  });

  it("uses the 丁目 when a portal gives a description instead of the building name", () => {
    const described = { ...nifty, name: "東川口駅より徒歩7分 築3年 3階建" };
    const [pair] = findPossibleDuplicates([make(), described]);
    expect(pair.reasons).toContain("building name not given");
    expect(pair.reasons).toContain("same 丁目");
  });

  it("scores two ads on one portal lower than the same pair across portals", () => {
    const [across] = findPossibleDuplicates([make(), nifty]);
    const [within] = findPossibleDuplicates([make(), { ...nifty, source: "athome", id: "athome-2", url: "https://www.athome.co.jp/chintai/2/" }]);
    expect(within.score).toBeLessThan(across.score);
    expect(within.reasons).toContain("both on athome");
  });

  it("recognises descriptive names and compares real ones by their characters", () => {
    expect(isDescriptiveName("越谷市 蒲生寿町（蒲生駅）")).toBe(true);
    expect(isDescriptiveName("北越谷駅より徒歩2分 築55年2ヶ月 9階建")).toBe(true);
    expect(isDescriptiveName("東武伊勢崎線 草加駅 地上2階建 新築")).toBe(true);
    expect(isDescriptiveName("アンビシア")).toBe(false);
    expect(nameSimilarity("ロイヤル越谷", "ロイヤル越谷")).toBe(1);
    expect(nameSimilarity("グレースゴンゲン", "グレース")).toBe(0.9);
    expect(nameSimilarity("アトリエール", "グランドール")).toBeLessThan(0.3);
  });
});

describe("duplicate decisions", () => {
  const answers = (...list: DuplicateDecision[]) =>
    Object.fromEntries(list.map((answer, i) => [`d${i}`, { ...answer, decidedAt: `2026-10-11T05:0${i}:00.000Z` }]));

  it("finds each answer's listings by their ads, after a listing id changes", () => {
    const renamed = { ...nifty, id: "nifty-renamed" };
    const resolved = resolveDecisions([make(), renamed], answers(decision("same", make(), nifty)));
    expect(resolved.sides.get("d0")).toEqual([listingKey(make()), listingKey(renamed)]);
    expect(resolved.byPair.get(pairId(listingKey(make()), listingKey(renamed)))?.decision.verdict).toBe("same");
  });

  it("never sends an answer to another room that shares a SUUMO page", () => {
    const room = (bc: string, over: Partial<EnrichedListing> = {}) => make({
      id: `suumo-${bc}`, source: "suumo", url: `https://suumo.jp/chintai/jnc_000103872332/?bc=${bc}`, ...over,
    });
    const [x, w] = [room("100"), room("200", { sizeM2: 55 })];
    expect(listingAdKeys(x)).not.toEqual(listingAdKeys(w));
    // An answer saved with only the shared jnc page (no bc) is ambiguous: it resolves to neither room.
    const ambiguous: DuplicateDecision = { verdict: "same", a: ["suumo|jnc_000103872332"], b: listingAdKeys(nifty), decidedAt: "2026-10-11" };
    const resolved = resolveDecisions([x, w, nifty], { d: ambiguous });
    expect(resolved.sides.get("d")).toEqual([undefined, listingKey(nifty)]);
    expect(resolved.leadOf.size).toBe(0);
  });

  it("shows homes confirmed as one as a single listing carrying both portals' ads", () => {
    const other = make({ id: "athome-9", name: "別の家", url: "https://www.athome.co.jp/chintai/9/", sizeM2: 40 });
    const input = [make(), nifty, other];
    const resolved = resolveDecisions(input, answers(decision("same", make(), nifty)));
    const shown = applySameDecisions(input, resolved);
    expect(shown).toHaveLength(2);
    expect(shown[0].sourceListings?.map((reference) => reference.source).sort()).toEqual(["athome", "nifty"]);
    expect(shownKey(resolved, listingKey(nifty))).toBe(shownKey(resolved, listingKey(make())));
    expect(shown[1]).toBe(other);
  });

  it("returns the very same array when no answer merges anything", () => {
    const input = [make(), nifty];
    expect(applySameDecisions(input, resolveDecisions(input, {}))).toBe(input);
    expect(applySameDecisions(input, resolveDecisions(input, answers(decision("different", make(), nifty))))).toBe(input);
  });

  it("joins chains of answers into one home, and stops asking about pairs already joined", () => {
    const third = make({ id: "roomspot-5", source: "roomspot", url: "https://www.roomspot.net/rent/5", name: "ベレオヴィラリーブス東川口 3階" });
    const input = [make(), nifty, third];
    const resolved = resolveDecisions(input, answers(decision("same", make(), nifty), decision("same", nifty, third)));
    const shown = applySameDecisions(input, resolved);
    expect(shown).toHaveLength(1);
    expect(shown[0].sourceListings).toHaveLength(3);
    const keys = [listingKey(make()), listingKey(third)].sort() as [string, string];
    expect(isPendingPair({ keys, score: 0.9, reasons: [] }, resolved)).toBe(false);
  });

  it("will not merge across a 'Different' answer, and reports the blocked 'same' answer", () => {
    const third = make({ id: "roomspot-5", source: "roomspot", url: "https://www.roomspot.net/rent/5" });
    const input = [make(), nifty, third];
    const resolved = resolveDecisions(input, answers(
      decision("same", make(), nifty),
      decision("different", make(), third),
      decision("same", nifty, third),
    ));
    expect(resolved.conflicts).toEqual(new Set(["d2"]));
    expect(applySameDecisions(input, resolved)).toHaveLength(2);
  });

  it("leads with an active listing and keeps the group's whole sighting history", () => {
    const sold = make({ status: "sold", firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-20T00:00:00Z" });
    const active = { ...nifty, firstSeenAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-11T00:00:00Z" };
    const resolved = resolveDecisions([sold, active], answers(decision("same", sold, active)));
    const [shown] = applySameDecisions([sold, active], resolved);
    expect(shown.status).toBeUndefined();
    expect(shown.firstSeenAt).toBe("2026-09-01T00:00:00Z");
    expect(shown.lastSeenAt).toBe("2026-10-11T00:00:00Z");
  });

  it("shows an absorbed listing's saved mark on the merged home unless the home has its own", () => {
    const leadOf = new Map([["a", "a"], ["b", "a"]]);
    expect(carryToLeads({ b: "candidate" }, leadOf)).toEqual({ b: "candidate", a: "candidate" });
    expect(carryToLeads({ a: "ruled-out", b: "candidate" }, leadOf)).toEqual({ a: "ruled-out", b: "candidate" });
    const untouched = { c: "candidate" };
    expect(carryToLeads(untouched, leadOf)).toBe(untouched);
  });

  it("compares a listing once even when two rows share its key", () => {
    expect(findPossibleDuplicates([make(), nifty, { ...nifty }])).toHaveLength(1);
  });
});
