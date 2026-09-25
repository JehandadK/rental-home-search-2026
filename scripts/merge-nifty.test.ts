import { describe, expect, it } from "vitest";
import { normaliseStationName, parseStation, parseStationDistance } from "./merge-nifty";
import { parseDepositKeyMoney } from "./lib/parseJa";

describe("Nifty move-in text", () => {
  it("keeps explicit 無 / 無 as zero even when UI text follows", () => {
    const firstLine = "無 / 無\n質問\n初期費用を教えてほしい".split("\n")[0];
    expect(parseDepositKeyMoney(firstLine)).toEqual({ depositYen: 0, keyMoneyYen: 0 });
  });
});

describe("normaliseStationName", () => {
  it("drops the railway line prefix", () => {
    expect(normaliseStationName("東武伊勢崎線/新田駅")).toBe("新田駅");
  });

  it("drops ニフティ's 利用可能駅 boilerplate", () => {
    expect(normaliseStationName("利用可能駅（ニフティ不動産調べ）谷塚駅")).toBe("谷塚駅");
  });

  it("keeps parenthesised station names intact", () => {
    expect(normaliseStationName("利用可能駅（ニフティ不動産調べ）獨協大学前（草加松原）駅")).toBe(
      "獨協大学前（草加松原）駅",
    );
  });

  it("leaves a bare name unchanged", () => {
    expect(normaliseStationName("草加駅")).toBe("草加駅");
  });
});

describe("parseStationDistance", () => {
  it("converts station kilometres to conventional walking minutes", () => {
    expect(parseStationDistance("東武伊勢崎線 草加駅 3.6km")).toEqual({
      station: "草加駅",
      walkMin: 45,
    });
  });
});

describe("parseStation", () => {
  it("reads station and walk minutes from an agency line", () => {
    expect(parseStation("東武伊勢崎線/新田駅 歩7分")).toEqual({ station: "新田駅", walkMin: 7 });
  });

  it("reads them from a ニフティ reference line", () => {
    expect(parseStation("利用可能駅（ニフティ不動産調べ）谷塚駅 歩15分")).toEqual({
      station: "谷塚駅",
      walkMin: 15,
    });
  });

  it("returns empty when no walk time is given", () => {
    expect(parseStation("新田駅")).toEqual({});
  });
});
