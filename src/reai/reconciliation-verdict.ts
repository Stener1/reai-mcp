/**
 * "Does the bank match the books?" — computed, rather than explained.
 *
 * This exists because the prose form of this answer was wrong three times in one quirk note, each
 * round fixing the claim under review and leaving an adjacent one nobody had measured:
 *
 *   1. Subtract `providerBalance` from the ledger closing balance. Wrong: `providerBalance` is the
 *      feed's CURRENT balance, not month-scoped, so July read a 485.39 shortfall against books that
 *      balanced.
 *   2. "The endpoint answers it directly — `pendingDiscrepancy` and `matchedDiscrepancy` were both
 *      0." Wrong: each subtracts postings from transactions WITHIN one bucket of the month's
 *      activity. Neither reads a balance, so both stay 0 while an opening gap passes through to the
 *      closing balances untouched.
 *   3. "If the currencies differ, use `bankInTenantCurrency` to see which side the figures are
 *      stated in." Wrong: that boolean says whether the account runs in the tenant currency. It
 *      assigns units to nothing.
 *
 * Every one of those survived because prose has no failing case. A sentence in a tool description
 * cannot be handed a foreign-currency account or a non-zero opening gap and observed to misbehave —
 * and tenant 2634, the only tenant with reconciliation data this repository may read, has neither:
 * all three of its accounts are NOK, and every reachable month has the two opening balances equal.
 * So the arithmetic lives here, where the cases that tenant cannot produce are unit tests.
 */

import type { ReconciliationView } from "../ui/reconciliation.js";

/** The four balance fields plus the flags this answer depends on. Absent from `ReconciliationView`. */
export type BalanceFacts = {
  bankCurrency?: string;
  tenantCurrency?: string;
  bankLedgerOpeningBalance?: number | null;
  bankLedgerClosingBalance?: number | null;
  actualBankMonthStartBalance?: number | null;
  actualBankDisplayedBalance?: number | null;
  /** True when the month asked for is the one in progress. */
  actualBankCurrentMonth?: boolean;
  pendingDiscrepancy?: number | null;
  matchedDiscrepancy?: number | null;
};

export type Verdict =
  /** The currencies differ, so no subtraction is defensible. Not a difference of zero. */
  | { answer: "not-comparable"; bankCurrency: string; tenantCurrency: string; why: string }
  /** A field the answer needs was absent. NOT reported as a match. */
  | { answer: "unknown"; missing: readonly string[]; why: string }
  | { answer: "matches"; closingDifference: 0; openingGap: number | null }
  | {
      answer: "differs";
      closingDifference: number;
      /** `actualBankMonthStartBalance - bankLedgerOpeningBalance`, or null when either is absent. */
      openingGap: number | null;
      /** The part of the difference that is not the opening gap. Null when the gap is unknown. */
      arisenThisMonth: number | null;
      /** True when the month is still in progress, where a gap is expected rather than a fault. */
      expected: boolean;
      why: string;
    };

/**
 * Round to øre before comparing.
 *
 * `1002.36 - 554.31` is not `448.05` in binary floating point, and a residue of 1e-13 reported as a
 * discrepancy is the same false alarm this module exists to prevent — just smaller. Two decimals is
 * the resolution the ledger itself keeps.
 */
const ore = (n: number): number => Math.round(n * 100) / 100;

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Answer the question from the response, or say why it cannot be answered.
 *
 * Order matters: comparability is settled before arithmetic, and missing fields before both. An
 * absent balance must never read as 0 — that would turn "the section was not requested" into "the
 * bank matches the books", which is the shape of wrong answer that does damage.
 */
export function bankMatchesBooks(view: BalanceFacts & Partial<ReconciliationView>): Verdict {
  const bankCurrency = typeof view.bankCurrency === "string" ? view.bankCurrency : "";
  const tenantCurrency = typeof view.tenantCurrency === "string" ? view.tenantCurrency : "";

  // Both present and different is the only case that is positively not comparable. One missing is
  // missing information, which the next check reports as such rather than assuming they agree.
  if (bankCurrency !== "" && tenantCurrency !== "" && bankCurrency !== tenantCurrency) {
    return {
      answer: "not-comparable",
      bankCurrency,
      tenantCurrency,
      why:
        `The bank account is in ${bankCurrency} and the books are in ${tenantCurrency}. Postings carry ` +
        "both `amount` and `currencyAmount`, and the OpenAPI document describes neither, so which figure " +
        "is the bank side is not established — subtracting them would manufacture a difference the size " +
        "of the exchange rate. `bankInTenantCurrency` does not settle it either: it says whether the " +
        "account runs in the tenant currency, not which field is in which. Report the balances side by " +
        "side and say no comparison is available.",
    };
  }

  const closing = finite(view.bankLedgerClosingBalance);
  const displayed = finite(view.actualBankDisplayedBalance);
  const missing: string[] = [];
  if (closing === undefined) missing.push("bankLedgerClosingBalance");
  if (displayed === undefined) missing.push("actualBankDisplayedBalance");
  if (bankCurrency === "") missing.push("bankCurrency");
  if (tenantCurrency === "") missing.push("tenantCurrency");
  if (closing === undefined || displayed === undefined || missing.length > 0) {
    return {
      answer: "unknown",
      missing,
      why:
        `Cannot answer: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} absent. The summary ` +
        "section carries these, so an `include` that omits it produces exactly this. An absent balance is " +
        "not zero.",
    };
  }

  const openingBank = finite(view.actualBankMonthStartBalance);
  const openingLedger = finite(view.bankLedgerOpeningBalance);
  const openingGap =
    openingBank === undefined || openingLedger === undefined ? null : ore(openingBank - openingLedger);

  const closingDifference = ore(displayed - closing);
  if (closingDifference === 0) return { answer: "matches", closingDifference: 0, openingGap };

  const expected = view.actualBankCurrentMonth === true;
  const arisenThisMonth = openingGap === null ? null : ore(closingDifference - openingGap);
  return {
    answer: "differs",
    closingDifference,
    openingGap,
    arisenThisMonth,
    expected,
    why: explainDifference(closingDifference, openingGap, arisenThisMonth, expected),
  };
}

/**
 * Say where the difference came from.
 *
 * The split is the whole point. A gap carried in from an earlier month is a different problem from
 * one created this month, and the discrepancy fields cannot tell them apart because they only ever
 * look at this month's activity.
 */
function explainDifference(
  difference: number,
  openingGap: number | null,
  arisenThisMonth: number | null,
  expected: boolean,
): string {
  const head =
    `The bank shows ${difference > 0 ? "more" : "less"} than the books by ${Math.abs(difference)} ` +
    "(actualBankDisplayedBalance minus bankLedgerClosingBalance).";

  const attribution =
    openingGap === null
      ? " The opening balances were not both present, so this cannot be split into what was carried in" +
        " and what arose this month."
      : openingGap === 0
        ? " The two opening balances agree, so the whole difference arose this month."
        : arisenThisMonth === 0
          ? ` The entire difference was carried in: the openings already differed by ${openingGap}, and` +
            " nothing this month changed it. Looking only at this month will find no cause."
          : ` Of that, ${openingGap} was carried in (the openings already differed) and ${arisenThisMonth}` +
            " arose this month.";

  const timing = expected
    ? " actualBankCurrentMonth is true, so the month is still in progress: the feed normally holds" +
      " movements not yet booked and a gap here is not yet a fault."
    : " actualBankCurrentMonth is false, so this is a closed month and the gap is a real one to explain.";

  return head + attribution + timing;
}

/** One line for a tool note, or null when the verdict adds nothing an agent could act on. */
export function verdictLine(verdict: Verdict): string {
  switch (verdict.answer) {
    case "matches":
      return "The bank matches the books for this month (actualBankDisplayedBalance equals bankLedgerClosingBalance).";
    case "not-comparable":
      return `Bank/books comparison unavailable: ${verdict.why}`;
    case "unknown":
      return verdict.why;
    case "differs":
      return verdict.why;
  }
}
