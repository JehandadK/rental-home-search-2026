import { describe, expect, it } from "vitest";
import {
  isExplicitNone,
  parseDepositKeyMoney,
  parseFloors,
  parseGuarantorRequired,
  parseImmediate,
  parseLease,
  parseYen,
  parseYenStrict,
  splitTags,
  sumMonthlyExtras,
  sumOneOffFees,
} from "./parseJa";

describe("parseYen", () => {
  it("reads 万円 amounts", () => {
    expect(parseYen("8.5万円")).toBe(85_000);
    expect(parseYen("22.2万円")).toBe(222_000);
  });

  it("reads plain yen with separators", () => {
    expect(parseYen("3,500円")).toBe(3_500);
    expect(parseYen("敷地内7700円")).toBe(7_700);
  });

  it("handles full-width digits", () => {
    expect(parseYen("２５，０００円")).toBe(25_000);
  });

  it("distinguishes explicit none from unknown", () => {
    expect(parseYen("－")).toBe(0);
    expect(parseYen("なし")).toBe(0);
    expect(parseYen("")).toBeNull();
    expect(parseYen(null)).toBeNull();
    expect(parseYen("要相談")).toBeNull();
  });

  it("treats －円 as an explicit zero", () => {
    expect(parseYen("－円")).toBe(0);
  });

  it("reads 'included free' wording as zero cost", () => {
    expect(parseYen("付無料/屋根付駐")).toBe(0);
    expect(parseYen("賃料に含む")).toBe(0);
  });

  it("still prefers a stated amount over free wording", () => {
    expect(parseYen("敷地内7700円")).toBe(7_700);
  });
});

describe("parseYenStrict", () => {
  it("treats a dash as unknown rather than zero", () => {
    expect(parseYenStrict("－")).toBeNull();
    expect(parseYenStrict("なし")).toBeNull();
  });

  it("still reads real amounts", () => {
    expect(parseYenStrict("1ヶ月分 8.5万円")).toBe(85_000);
  });
});

describe("parseDepositKeyMoney", () => {
  it("splits both sides", () => {
    expect(parseDepositKeyMoney("8.5万円 / 8.5万円")).toEqual({
      depositYen: 85_000,
      keyMoneyYen: 85_000,
    });
  });

  it("treats － as an explicit zero per side", () => {
    expect(parseDepositKeyMoney("－円 / 22.2万円")).toEqual({
      depositYen: 0,
      keyMoneyYen: 222_000,
    });
  });

  it("returns nulls when absent", () => {
    expect(parseDepositKeyMoney(undefined)).toEqual({ depositYen: null, keyMoneyYen: null });
  });
});

describe("parseLease", () => {
  it("detects fixed-term leases and their length", () => {
    expect(parseLease("定期借家 2年")).toEqual({ leaseType: "fixed-term", leaseMonths: 24 });
    expect(parseLease("・定期借家契約２年")).toEqual({ leaseType: "fixed-term", leaseMonths: 24 });
  });

  it("treats a plain term as a regular lease", () => {
    expect(parseLease("2年")).toEqual({ leaseType: "regular", leaseMonths: 24 });
  });

  it("returns nulls for － or empty", () => {
    expect(parseLease("")).toEqual({ leaseType: null, leaseMonths: null });
  });
});

describe("parseFloors", () => {
  it("reads unit floor and building height", () => {
    expect(parseFloors("4階/8階建")).toEqual({ floor: "4階", totalFloors: 8 });
  });

  it("handles ranges and 地上 prefix", () => {
    expect(parseFloors("1-2階/地上2階建")).toEqual({ floor: "1-2階", totalFloors: 2 });
  });

  it("handles 3階/3階建", () => {
    expect(parseFloors("3階/3階建")).toEqual({ floor: "3階", totalFloors: 3 });
  });
});

describe("sumOneOffFees", () => {
  it("sums signing charges while ignoring monthly ones", () => {
    const text =
      "退去時クリーニング費用￥90000が契約時必要。貸主インボイス登録あり/更新事務手数料22000円/ruumサポート費用（月額）1980円/鍵セット費3300円";
    // Move-out cleaning ¥90,000 + key set ¥3,300; the ¥22,000 renewal fee is
    // paid at 更新, not on moving in.
    expect(sumOneOffFees(text)).toBe(93_300);
  });

  it("keeps full-width thousands separators inside amounts", () => {
    // Parser 1 split on "，" and stored ¥500 for this key exchange and ¥320 of the
    // monthly support fee as a one-off charge.
    const text = "◆トラブルサポート24月額1，320円（税込）　◆鍵交換代27，500円（税込）　◆消臭・除菌17，600円（税込）";
    expect(sumOneOffFees(text)).toBe(45_100);
    expect(sumMonthlyExtras(text)).toBe(1_320);
  });

  it("returns null when nothing is stated", () => {
    expect(sumOneOffFees("－")).toBeNull();
    expect(sumOneOffFees("・定期借家契約２年")).toBeNull();
  });
});

describe("sumMonthlyExtras", () => {
  it("picks up monthly-marked yen amounts", () => {
    const text = "ruumサポート費用（月額）1980円/鍵セット費3300円";
    expect(sumMonthlyExtras(text)).toBe(1_980);
  });

  it("ignores percentage-based guarantor fees", () => {
    expect(sumMonthlyExtras("月額保証料賃料等総額の１.１％")).toBeNull();
  });
});

describe("parseGuarantorRequired", () => {
  it("detects mandatory guarantor companies", () => {
    expect(parseGuarantorRequired("必加入備考:保証会社利用必 初回保証料…")).toBe(true);
  });

  it("detects when none is needed", () => {
    expect(parseGuarantorRequired("不要")).toBe(false);
    expect(parseGuarantorRequired("")).toBeNull();
  });
});

describe("splitTags", () => {
  it("splits amenity lists", () => {
    expect(splitTags("バストイレ別、バルコニー、エアコン")).toEqual([
      "バストイレ別",
      "バルコニー",
      "エアコン",
    ]);
  });

  it("splits condition lists on slashes", () => {
    expect(splitTags("二人入居可/子供可/事務所利用不可")).toEqual([
      "二人入居可",
      "子供可",
      "事務所利用不可",
    ]);
  });

  it("returns null for empty markers", () => {
    expect(splitTags("－")).toBeNull();
  });
});

describe("parseImmediate", () => {
  it("recognises 即", () => {
    expect(parseImmediate("即")).toBe(true);
  });

  it("treats a dated availability as not immediate", () => {
    expect(parseImmediate("'26年10月中旬")).toBe(false);
  });
});

describe("isExplicitNone", () => {
  it("only matches standalone none markers", () => {
    expect(isExplicitNone("－")).toBe(true);
    expect(isExplicitNone("8.5万円")).toBe(false);
  });
});
