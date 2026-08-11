import { test } from "node:test";
import assert from "node:assert/strict";
import { bankMatchesBooks, verdictLine } from "../dist/reai/reconciliation-verdict.js";

/**
 * The cases tenant 2634 cannot produce.
 *
 * Every wrong version of this answer — three of them, all shipped as prose in a tool description and a
 * quirk note — was wrong about a configuration the only readable tenant does not have: a foreign-currency
 * bank account, or a month whose two opening balances differ. Both are representable in the response and
 * neither exists in reachable data, so live verification would have confirmed the wrong answer forever.
 *
 * That is what this file is for. The live check in `scripts/smoke.mjs` can only assert the homogeneous
 * case; these are the ones that mattered.
 */

/** A month that balances, in one currency. Cases below override only what they are about. */
const BALANCED = {
  bankCurrency: "NOK",
  tenantCurrency: "NOK",
  bankLedgerOpeningBalance: 554.31,
  bankLedgerClosingBalance: 1002.36,
  actualBankMonthStartBalance: 554.31,
  actualBankDisplayedBalance: 1002.36,
  actualBankCurrentMonth: false,
  pendingDiscrepancy: 0,
  matchedDiscrepancy: 0,
};

test("a month that balances is a match", () => {
  const v = bankMatchesBooks(BALANCED);
  assert.equal(v.answer, "matches");
  assert.equal(v.closingDifference, 0);
  assert.equal(v.openingGap, 0);
  assert.equal(v.currency, "NOK");
  assert.match(verdictLine(v), /matches the books/);
});

test("a gap that was cleared during the month is said to have been cleared", () => {
  // Closing balances agree while the openings did not. Reporting a bare match here hides that the
  // month contained a correction, which is the mirror of reporting a correction as a new discrepancy.
  const v = bankMatchesBooks({ ...BALANCED, actualBankMonthStartBalance: 654.31 });
  assert.equal(v.answer, "matches");
  assert.equal(v.openingGap, 100);
  assert.match(v.why, /resolved during the month/);
});

test("differing currencies are not comparable, whatever the balances would subtract to", () => {
  // The balances here differ by 448.05. A version that compared first and checked currency second
  // would report that as a discrepancy; it is the size of an exchange rate, not a bookkeeping error.
  const v = bankMatchesBooks({
    ...BALANCED,
    bankCurrency: "USD",
    actualBankDisplayedBalance: 554.31,
  });
  assert.equal(v.answer, "not-comparable");
  assert.equal(v.bankCurrency, "USD");
  assert.equal(v.tenantCurrency, "NOK");
  // Specifically NOT reported as a difference of any size.
  assert.equal("closingDifference" in v, false);
  assert.match(v.why, /currencyAmount/);
  assert.match(v.why, /`bankInTenantCurrency` does not settle it/);
});

test("the same account is comparable once the books share its currency", () => {
  // Or the check above would pass for a module that says "not-comparable" unconditionally.
  const v = bankMatchesBooks({ ...BALANCED, bankCurrency: "USD", tenantCurrency: "USD" });
  assert.equal(v.answer, "matches");
});

test("an opening gap survives zero discrepancy buckets", () => {
  // THE CASE THAT WAS WRONG. Both discrepancy fields are 0 — the month's transactions and postings
  // agree — and the bank is still 100 ahead of the books because it already was on the first of the
  // month. An answer taken from the buckets certifies this as reconciled.
  const v = bankMatchesBooks({
    ...BALANCED,
    actualBankMonthStartBalance: 654.31,
    actualBankDisplayedBalance: 1102.36,
    pendingDiscrepancy: 0,
    matchedDiscrepancy: 0,
  });
  assert.equal(v.answer, "differs");
  assert.equal(v.closingDifference, 100);
  assert.equal(v.openingGap, 100);
  assert.equal(v.gapChangeThisMonth, 0);
  assert.match(v.why, /carried in/);
  assert.match(v.why, /Looking only at this month will find no cause/);
});

test("a gap created this month is attributed to this month", () => {
  const v = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 1102.36 });
  assert.equal(v.answer, "differs");
  assert.equal(v.closingDifference, 100);
  assert.equal(v.openingGap, 0);
  assert.equal(v.gapChangeThisMonth, 100);
  assert.match(v.why, /whole difference arose this month/);
});

test("a difference that is part carried in and part new is split", () => {
  const v = bankMatchesBooks({
    ...BALANCED,
    actualBankMonthStartBalance: 594.31, // 40 ahead at the start
    actualBankDisplayedBalance: 1102.36, // 100 ahead at the end
  });
  assert.equal(v.closingDifference, 100);
  assert.equal(v.openingGap, 40);
  assert.equal(v.gapChangeThisMonth, 60);
  assert.match(v.why, /differed by 40 NOK, so that much was carried in/);
  assert.match(v.why, /WIDENED by 60 NOK/);
});

test("a gap that shrank is reported as a correction, not as a negative arrival", () => {
  // Opening gap 100, closing 40. The signed change is -60, and interpolating that produced
  // "-60 arose this month" — a fix described as a new fault, sending the reader after the wrong cause.
  const v = bankMatchesBooks({
    ...BALANCED,
    actualBankMonthStartBalance: 654.31, // 100 ahead at the start
    actualBankDisplayedBalance: 1042.36, // 40 ahead at the end
  });
  assert.equal(v.closingDifference, 40);
  assert.equal(v.openingGap, 100);
  assert.equal(v.gapChangeThisMonth, -60);
  assert.match(v.why, /60 NOK of it was RESOLVED during the month/);
  assert.match(v.why, /correction, not a new discrepancy/);
  assert.doesNotMatch(v.why, /-60/, "a negative amount must never be interpolated as an arrival");
  assert.doesNotMatch(v.why, /-60 arose/);
});

test("a gap that crossed zero is not called grown or shrunk", () => {
  // 100 ahead at the start, 100 BEHIND at the end. Same magnitude, opposite side: neither "widened"
  // nor "resolved" is true, and the signed change (-200) describes nothing a reader would recognise.
  const v = bankMatchesBooks({
    ...BALANCED,
    actualBankMonthStartBalance: 654.31,
    actualBankDisplayedBalance: 902.36,
  });
  assert.equal(v.openingGap, 100);
  assert.equal(v.closingDifference, -100);
  assert.equal(v.gapChangeThisMonth, -200);
  assert.match(v.why, /same size at the end but on the OTHER side/);
  assert.doesNotMatch(v.why, /WIDENED|RESOLVED/);
});

test("amounts carry the currency, so a EUR account does not read as kroner", () => {
  // Both sides EUR is comparable — and every figure in the answer is then euros. A bare "by 100"
  // is only unambiguous on the NOK tenant this repository can read.
  const v = bankMatchesBooks({
    ...BALANCED,
    bankCurrency: "EUR",
    tenantCurrency: "EUR",
    actualBankMonthStartBalance: 594.31,
    actualBankDisplayedBalance: 1102.36,
  });
  assert.equal(v.answer, "differs");
  assert.equal(v.currency, "EUR");
  assert.match(v.why, /by 100 EUR/);
  assert.match(v.why, /40 EUR/);
  assert.match(v.why, /60 EUR/);
  assert.doesNotMatch(v.why, /NOK/);
  // And no amount is left bare: every number in the explanation is followed by its currency. The count
  // is asserted first, or a regex that matched nothing would satisfy the loop by never running it.
  const amounts = [...v.why.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)];
  assert.equal(amounts.length, 3, `expected the three figures 100/40/60, found ${amounts.map((m) => m[0]).join(",")}`);
  for (const m of amounts) {
    const after = v.why.slice(m.index + m[0].length, m.index + m[0].length + 4);
    assert.match(after, /^ EUR/, `amount ${m[0]} was not labelled with a currency`);
  }
});

test("the direction of the difference is stated, not just its size", () => {
  const ahead = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 1102.36 });
  const behind = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 902.36 });
  assert.match(ahead.why, /bank shows more than the books by 100/);
  assert.match(behind.why, /bank shows less than the books by 100/);
  assert.equal(behind.closingDifference, -100);
});

test("the current month marks a gap expected; a closed month does not", () => {
  const current = bankMatchesBooks({
    ...BALANCED,
    actualBankDisplayedBalance: 1102.36,
    actualBankCurrentMonth: true,
  });
  assert.equal(current.timing, "month-in-progress");
  assert.equal(current.expected, true);
  assert.match(current.why, /still in progress/);

  const closed = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 1102.36 });
  assert.equal(closed.timing, "past-month");
  assert.equal(closed.expected, false);
  assert.match(closed.why, /the month is over/);
  assert.doesNotMatch(closed.why, /closed month/, "a past month is not necessarily a CLOSED period — `closed` is its own field");
});

test("an in-progress month does not excuse a gap that predates it", () => {
  // The whole difference was carried in and the month happens to be open. Feed movements that have
  // not been booked yet cannot explain a discrepancy that already existed on the first of the month,
  // so calling the verdict "expected" tells the caller to wait for something that will never arrive.
  const v = bankMatchesBooks({
    ...BALANCED,
    actualBankMonthStartBalance: 654.31,
    actualBankDisplayedBalance: 1102.36,
    actualBankCurrentMonth: true,
  });
  assert.equal(v.timing, "month-in-progress");
  assert.equal(v.gapChangeThisMonth, 0);
  assert.equal(v.expected, false, "a carried-in gap is never expected, whatever the month");
  assert.match(v.why, /not the 100 NOK carried in from before it/);
  assert.match(v.why, /needs explaining whatever the feed does next/);
});

test("an absent current-month flag is unknown timing, not a closed month", () => {
  // The flag is optional in the response. Reading absent as false makes the note assert
  // "actualBankCurrentMonth is false, so this is a closed month" from no information at all — the
  // same manufacture-from-absence that makes a missing balance read as a match.
  const v = bankMatchesBooks({
    ...BALANCED,
    actualBankDisplayedBalance: 1102.36,
    actualBankCurrentMonth: undefined,
  });
  assert.equal(v.timing, "unknown");
  assert.equal(v.expected, false, "unknown timing does not establish that a gap is expected");
  assert.match(v.why, /was not in the response/);
  assert.doesNotMatch(v.why, /the month is over/);
  assert.doesNotMatch(v.why, /is false/);

  // null is what a JSON null deserialises to and must read the same as absent.
  assert.equal(bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 1102.36, actualBankCurrentMonth: null }).timing, "unknown");
});

test("an absent balance is unknown, never a match", () => {
  // The failure that would do damage: `include: ["pending_transactions"]` omits the summary, so all
  // four balance fields are absent. Treating absent as 0 makes every such call say the books balance.
  const noSummary = bankMatchesBooks({ bankCurrency: "NOK", tenantCurrency: "NOK" });
  assert.equal(noSummary.answer, "unknown");
  assert.deepEqual(noSummary.missing, ["bankLedgerClosingBalance", "actualBankDisplayedBalance"]);
  assert.match(noSummary.why, /absent balance is not zero/);
  assert.match(noSummary.why, /include/, "the remedy is right for this case and must be stated");

  // And one field short of an answer is still not an answer, even when the other side is a real 0.
  const half = bankMatchesBooks({ ...BALANCED, bankLedgerClosingBalance: undefined, actualBankDisplayedBalance: 0 });
  assert.equal(half.answer, "unknown");
  assert.deepEqual(half.missing, ["bankLedgerClosingBalance"]);

  // null is what the API sends for an unset decimal, and it must read the same as absent.
  const nulled = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: null });
  assert.equal(nulled.answer, "unknown");
});

test("a missing currency is unknown, not assumed to match the other", () => {
  // Assuming equality here would re-enable the subtraction the currency guard exists to refuse.
  const v = bankMatchesBooks({ ...BALANCED, bankCurrency: undefined });
  assert.equal(v.answer, "unknown");
  assert.deepEqual(v.missing, ["bankCurrency"]);
  // And it must not be described as a balance, nor blamed on `include`.
  assert.doesNotMatch(v.why, /absent balance is not zero/);
});

test("the reason a field is unusable is stated correctly, per field", () => {
  // One sentence for every case called bankCurrency a balance, and told a caller holding a
  // string-typed decimal that the field was absent while the JSON below showed it present.
  const asString = bankMatchesBooks({ ...BALANCED, bankLedgerClosingBalance: "1002.36" });
  assert.equal(asString.answer, "unknown", "a non-numeric balance must not be compared");
  assert.match(asString.why, /present but not finite number/);
  assert.match(asString.why, /re-requesting will not help/);
  assert.doesNotMatch(asString.why, /is absent/, "the field is present; saying otherwise sends the caller nowhere");

  const nan = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: Number.NaN });
  assert.equal(nan.answer, "unknown");
  assert.match(nan.why, /present but not finite number/);

  // The schema's declared default for the currencies is "", which is not an `include` artefact.
  const blank = bankMatchesBooks({ ...BALANCED, bankCurrency: "" });
  assert.equal(blank.answer, "unknown");
  assert.match(blank.why, /came back empty/);
  assert.match(blank.why, /schema's own declared default/);
  assert.doesNotMatch(blank.why, /`include` that omits it/, "an empty currency is not an include artefact");
  assert.doesNotMatch(blank.why, /absent balance is not zero/);

  // Several kinds at once are each described in their own clause.
  const mixed = bankMatchesBooks({ ...BALANCED, bankLedgerClosingBalance: undefined, actualBankDisplayedBalance: "1" });
  assert.match(mixed.why, /bankLedgerClosingBalance is absent/);
  assert.match(mixed.why, /actualBankDisplayedBalance is present but not/);
});

test("the openings being unknown does not block the answer, only the attribution", () => {
  const v = bankMatchesBooks({
    ...BALANCED,
    actualBankDisplayedBalance: 1102.36,
    actualBankMonthStartBalance: undefined,
  });
  assert.equal(v.answer, "differs");
  assert.equal(v.closingDifference, 100);
  assert.equal(v.openingGap, null);
  assert.equal(v.gapChangeThisMonth, null);
  assert.match(v.why, /cannot be split/);
});

test("floating-point residue is not a discrepancy", () => {
  // 0.1 + 0.2 is 0.30000000000000004. Reported raw, that is a difference of 4e-17 — a false alarm of
  // exactly the kind this module exists to prevent, differing from the providerBalance one only in size.
  const v = bankMatchesBooks({
    ...BALANCED,
    bankLedgerClosingBalance: 0.3,
    actualBankDisplayedBalance: 0.1 + 0.2,
    bankLedgerOpeningBalance: 0,
    actualBankMonthStartBalance: 0,
  });
  assert.equal(v.answer, "matches");

  // But a real øre still counts. Rounding must not swallow the smallest amount the ledger keeps.
  const ore = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 1002.37 });
  assert.equal(ore.answer, "differs");
  assert.equal(ore.closingDifference, 0.01);
});
