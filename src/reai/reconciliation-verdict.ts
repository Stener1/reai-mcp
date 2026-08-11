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
 *
 * ## What this module cannot establish
 *
 * It rests on `actualBankDisplayedBalance` being the BANK's month-end figure. Nothing available proves
 * that. On every month reachable here it equalled `bankLedgerClosingBalance` exactly — including August,
 * where the feed's own `providerBalance` did not (1002.36 against 1039.70). If the field is derived from
 * booked activity rather than from the feed, then `differs` is unreachable in practice and a `matches`
 * verdict is a tautology dressed as a check: the same false reassurance as version 1 above, with the
 * opposite sign.
 *
 * That is why the tool description tells a caller to treat a reported DIFFERENCE as strong evidence and a
 * reported MATCH as weak. Nothing in the `differs` branch has ever run against real data, only against
 * the tests below. Settling it needs a tenant whose bank genuinely diverges from its books, and none is
 * reachable — which is worth knowing before trusting a green month.
 */

import type { ReconciliationView } from "../ui/reconciliation.js";

/**
 * Whether the month asked for is the one in progress.
 *
 * Three states, not a boolean. `actualBankCurrentMonth` is optional in the response, and reading an
 * absent flag as `false` would let the verdict assert "this is a closed month" from no information at
 * all — the same manufacture-a-fact-from-absence that makes an absent balance report as a match.
 *
 * "closed-month" here means only that the month is not the current one. It is NOT the accounting sense
 * of closed: `closed` and `reconciliationLocked` are separate fields on the response and this does not
 * read them.
 */
export type Timing = "month-in-progress" | "past-month" | "unknown";

export type Verdict =
  /** The currencies differ, so no subtraction is defensible. Not a difference of zero. */
  | { answer: "not-comparable"; bankCurrency: string; tenantCurrency: string; why: string }
  /** A field the answer needs was absent. NOT reported as a match. */
  | { answer: "unknown"; missing: readonly string[]; why: string }
  | { answer: "matches"; currency: string; closingDifference: 0; openingGap: number | null; why: string }
  | {
      answer: "differs";
      /** The currency BOTH sides are in — equal by the time this branch is reached. */
      currency: string;
      closingDifference: number;
      /** `actualBankMonthStartBalance - bankLedgerOpeningBalance`, or null when either is absent. */
      openingGap: number | null;
      /**
       * `closingDifference - openingGap`: the SIGNED change in the gap over the month. Negative means
       * the gap shrank, which is a correction and not a new discrepancy — naming this `arisen` was how
       * an earlier version came to report "-60 arose this month".
       */
      gapChangeThisMonth: number | null;
      timing: Timing;
      /**
       * True only when the month is in progress AND nothing was carried in.
       *
       * An in-progress month excuses a gap that arose WITHIN it — the feed holds movements not yet
       * booked. It cannot excuse one that predates the month, so a non-zero `openingGap` is never
       * expected, and an unknown gap or unknown timing is not established as expected either.
       */
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
export function bankMatchesBooks(view: ReconciliationView): Verdict {
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

  // WHY the field is unusable, not merely that it is. The first version wrote one sentence for every
  // case — "… is absent. The summary section carries these, so an `include` that omits it produces
  // exactly this. An absent balance is not zero." — which called `bankCurrency` a balance, and told a
  // caller holding `"1002.36"` as a STRING that the field was absent while the JSON right below showed
  // it present with a value. Both the stated cause and the suggested remedy were wrong, and re-requesting
  // with `include:["summary"]` would never fix either.
  const problems: Array<{ field: string; kind: "absent" | "not-a-number" | "blank" }> = [];
  const balance = (field: string, raw: unknown, parsed: number | undefined): void => {
    if (parsed !== undefined) return;
    problems.push({ field, kind: raw === undefined || raw === null ? "absent" : "not-a-number" });
  };
  balance("bankLedgerClosingBalance", view.bankLedgerClosingBalance, closing);
  balance("actualBankDisplayedBalance", view.actualBankDisplayedBalance, displayed);
  if (bankCurrency === "") {
    problems.push({ field: "bankCurrency", kind: view.bankCurrency === undefined ? "absent" : "blank" });
  }
  if (tenantCurrency === "") {
    problems.push({ field: "tenantCurrency", kind: view.tenantCurrency === undefined ? "absent" : "blank" });
  }

  if (closing === undefined || displayed === undefined || problems.length > 0) {
    const named = (kind: (typeof problems)[number]["kind"]): string[] =>
      problems.filter((p) => p.kind === kind).map((p) => p.field);
    const clauses: string[] = [];
    // Split by whether the absent field is a BALANCE, because only the balance clause can honestly
    // offer the `include` remedy and only balances can be mistaken for zero.
    const BALANCES = new Set(["bankLedgerClosingBalance", "actualBankDisplayedBalance"]);
    const absentBalances = named("absent").filter((f) => BALANCES.has(f));
    const absentOther = named("absent").filter((f) => !BALANCES.has(f));
    if (absentBalances.length > 0) {
      clauses.push(
        `${absentBalances.join(", ")} ${absentBalances.length === 1 ? "is" : "are"} absent — the summary ` +
          "section carries them, so an `include` that omits it produces exactly this, and an absent " +
          "balance is not zero",
      );
    }
    if (absentOther.length > 0) {
      clauses.push(`${absentOther.join(", ")} ${absentOther.length === 1 ? "is" : "are"} absent`);
    }
    const notNumbers = named("not-a-number");
    if (notNumbers.length > 0) {
      clauses.push(
        `${notNumbers.join(", ")} ${notNumbers.length === 1 ? "is" : "are"} present but not ` +
          "finite number(s) — a decimal delivered as a string, or NaN, so re-requesting will not help",
      );
    }
    const blank = named("blank");
    if (blank.length > 0) {
      clauses.push(
        `${blank.join(", ")} came back empty, which is the schema's own declared default rather than ` +
          "an `include` artefact — without a currency there is no way to know the two sides are comparable",
      );
    }
    return {
      answer: "unknown",
      missing: problems.map((p) => p.field),
      why: `Cannot answer: ${clauses.join("; ")}.`,
    };
  }

  const openingBank = finite(view.actualBankMonthStartBalance);
  const openingLedger = finite(view.bankLedgerOpeningBalance);
  const openingGap =
    openingBank === undefined || openingLedger === undefined ? null : ore(openingBank - openingLedger);

  // Both sides are in this currency by now, so every amount below can be labelled with it. Reporting a
  // bare number is only safe on a NOK tenant, and "by 100" reads as kroner on a EUR/EUR account.
  const currency = bankCurrency;
  const closingDifference = ore(displayed - closing);
  if (closingDifference === 0) {
    return {
      answer: "matches",
      currency,
      closingDifference: 0,
      openingGap,
      why:
        "actualBankDisplayedBalance equals bankLedgerClosingBalance." +
        (openingGap === null || openingGap === 0
          ? ""
          : ` The two openings differed by ${Math.abs(openingGap)} ${currency}, so that gap was resolved` +
            " during the month rather than never existing."),
    };
  }

  const timing: Timing =
    view.actualBankCurrentMonth === true
      ? "month-in-progress"
      : view.actualBankCurrentMonth === false
        ? "past-month"
        : "unknown";
  const gapChangeThisMonth = openingGap === null ? null : ore(closingDifference - openingGap);
  return {
    answer: "differs",
    currency,
    closingDifference,
    openingGap,
    gapChangeThisMonth,
    timing,
    // Only an in-progress month with nothing carried in. See the field's own note.
    expected: timing === "month-in-progress" && openingGap === 0,
    why: explainDifference({ currency, closingDifference, openingGap, gapChangeThisMonth, timing }),
  };
}

/**
 * Say where the difference came from, and what the timing does and does not excuse.
 *
 * The split is the whole point: a gap carried in from an earlier month is a different problem from one
 * created this month, and the discrepancy fields cannot tell them apart because they only ever look at
 * this month's activity.
 *
 * Direction is described from the two MAGNITUDES rather than from the sign of the change, because the
 * gap can cross zero — bank ahead at the start and behind at the end — and there is no honest way to
 * call that "grew" or "shrank". Interpolating the signed number instead produced "-60 arose this
 * month" for a gap that was partly CORRECTED, which sends a reader looking for a cause that is really
 * a fix.
 */
function explainDifference(v: {
  currency: string;
  closingDifference: number;
  openingGap: number | null;
  gapChangeThisMonth: number | null;
  timing: Timing;
}): string {
  const amount = (n: number): string => `${Math.abs(n)} ${v.currency}`;
  const head =
    `The bank shows ${v.closingDifference > 0 ? "more" : "less"} than the books by ` +
    `${amount(v.closingDifference)} (actualBankDisplayedBalance minus bankLedgerClosingBalance).`;

  const attribution = ((): string => {
    if (v.openingGap === null) {
      return (
        " The opening balances were not both present, so this cannot be split into what was carried in" +
        " and what changed this month."
      );
    }
    if (v.openingGap === 0) return " The two opening balances agree, so the whole difference arose this month.";
    if (v.gapChangeThisMonth === 0) {
      return (
        ` The entire difference was carried in: the openings already differed by ${amount(v.openingGap)},` +
        " and nothing this month changed it. Looking only at this month will find no cause."
      );
    }
    const before = Math.abs(v.openingGap);
    const after = Math.abs(v.closingDifference);
    const carried = ` The openings already differed by ${amount(v.openingGap)}, so that much was carried in.`;
    if (after > before) return `${carried} It then WIDENED by ${amount(after - before)} during the month.`;
    if (after < before) {
      return (
        `${carried} ${amount(before - after)} of it was RESOLVED during the month — that part is a` +
        " correction, not a new discrepancy."
      );
    }
    return (
      `${carried} It is the same size at the end but on the OTHER side, so the month both cleared it and` +
      " opened an equal one in the opposite direction."
    );
  })();

  const timing = ((): string => {
    switch (v.timing) {
      case "unknown":
        return (
          " actualBankCurrentMonth was not in the response, so whether this month is still in progress is" +
          " unknown — and with it whether a gap is expected here. Do not assume the month is closed."
        );
      case "month-in-progress":
        return v.openingGap === 0 || v.openingGap === null
          ? " actualBankCurrentMonth is true, so the month is still in progress: the feed normally holds" +
              " movements not yet booked and a gap here is not yet a fault."
          : " actualBankCurrentMonth is true, so the month is still in progress — which can explain a gap" +
              ` that arose WITHIN it, but not the ${amount(v.openingGap)} carried in from before it. That` +
              " part needs explaining whatever the feed does next.";
      case "past-month":
        // NOT "a closed month": `closed` and `reconciliationLocked` are separate fields and this does not
        // read them, so calling a merely-past month closed asserts a period lock that may not exist.
        return (
          " actualBankCurrentMonth is false, so the month is over: the feed has no further movements to" +
          " book here and the gap is a real one to explain."
        );
    }
  })();

  return head + attribution + timing;
}

/** One line for a tool note, or null when the verdict adds nothing an agent could act on. */
export function verdictLine(verdict: Verdict): string {
  switch (verdict.answer) {
    case "matches":
      return `The bank matches the books for this month. ${verdict.why}`;
    case "not-comparable":
      return `Bank/books comparison unavailable: ${verdict.why}`;
    case "unknown":
      return verdict.why;
    case "differs":
      return verdict.why;
  }
}
