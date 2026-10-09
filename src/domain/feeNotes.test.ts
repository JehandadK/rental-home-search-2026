import { describe, expect, it } from "vitest";
import { parseFeeNotes, sumFees } from "./feeNotes";

const labels = (items: { label: string; yen: number }[]) => items.map(({ label, yen }) => `${label}:${yen}`);

describe("parseFeeNotes", () => {
  it("keeps full-width thousands separators inside amounts", () => {
    const fees = parseFeeNotes("◆保証会社加入　◆トラブルサポート24月額1，320円（税込）　◆鍵交換代27，500円（税込）　◆消臭・除菌17，600円（税込）");
    expect(labels(fees.signing)).toEqual(["鍵交換代:27500", "消臭・除菌:17600"]);
    expect(labels(fees.monthly)).toEqual(["トラブルサポート24:1320"]);
  });

  it("separates cleaning, signing and monthly charges in one run-on note", () => {
    const fees = parseFeeNotes(
      "※退去時クリーニング費用【82500円（税込）】保証会社初回50％月額保証料1000円（※賃料クレジット払い時、初回80％月額1％最低保証料880円）　　"
      + "鍵交換費用33000円～(税込)　入居安心サポート（2200円(税込)/月）抗菌施工代16500円(税込)　防災セット22000円(税込)",
    );
    expect(fees.cleaningYen).toBe(82_500);
    expect(labels(fees.signing)).toEqual(["鍵交換費用:33000", "抗菌施工代:16500", "防災セット:22000"]);
    // The 880円 minimum is an alternative rate, not a charge you will pay.
    expect(labels(fees.monthly)).toEqual(["保証会社初回50%月額保証料:1000", "入居安心サポート:2200"]);
  });

  it("leaves out renewal, penalty, conditional and already-modelled charges", () => {
    const fees = parseFeeNotes(
      "24時間サポート1100円(月額)　更新事務手数料22000円　1年未満の解約の場合、違約金50000円。"
      + "飼育時、賃料＋3000円。鍵交換代任意、22000円。火災保険20000円。仲介手数料88000円。",
    );
    expect(fees.signing).toEqual([]);
    expect(labels(fees.monthly)).toEqual(["24時間サポート:1100"]);
  });

  it("reads a stated 'no cleaning fee' as zero, and a bare amount from the clause before it", () => {
    expect(parseFeeNotes("※退去時クリーニング費用不要（故意過失を除く）").cleaningYen).toBe(0);
    const perArea = parseFeeNotes("清掃代：20平方メートル以上+1375円/平方メートル、39600円(退去時)。　エアコン清掃代：16500円/台(退去時)。");
    expect(perArea.cleaningYen).toBe(39_600 + 16_500);
    expect(perArea.signing).toEqual([]);
  });

  it("handles ¥-prefixed and 万円 amounts, and labels after a colon", () => {
    const fees = parseFeeNotes("退去時クリーニング費用￥90000が契約時必要。/更新事務手数料22000円/ruumサポート費用（月額）1980円/鍵セット費3300円・鍵交換代：あり1.65万円");
    expect(fees.cleaningYen).toBe(90_000);
    expect(labels(fees.signing)).toEqual(["鍵セット費:3300", "鍵交換代:16500"]);
    expect(sumFees(fees.monthly)).toBe(1_980);
  });

  it("knows when a note has no amounts at all", () => {
    expect(parseFeeNotes("即入居可、備考：[物件コード]016201-10688c").hasAmounts).toBe(false);
    expect(parseFeeNotes(null).hasAmounts).toBe(false);
    expect(parseFeeNotes("角部屋 町会費200円(月額)").hasAmounts).toBe(true);
  });
});
