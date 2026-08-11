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
  assert.match(verdictLine(v), /matches the books/);
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
  assert.match(v.why, /bankInTenantCurrency does not settle it|`bankInTenantCurrency` does not settle it/);
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
  assert.equal(v.arisenThisMonth, 0);
  assert.match(v.why, /carried in/);
  assert.match(v.why, /Looking only at this month will find no cause/);
});

test("a gap created this month is attributed to this month", () => {
  const v = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 1102.36 });
  assert.equal(v.answer, "differs");
  assert.equal(v.closingDifference, 100);
  assert.equal(v.openingGap, 0);
  assert.equal(v.arisenThisMonth, 100);
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
  assert.equal(v.arisenThisMonth, 60);
  assert.match(v.why, /40 was carried in/);
  assert.match(v.why, /60/);
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
  assert.equal(current.expected, true);
  assert.match(current.why, /still in progress/);

  const closed = bankMatchesBooks({ ...BALANCED, actualBankDisplayedBalance: 1102.36 });
  assert.equal(closed.expected, false);
  assert.match(closed.why, /closed month/);
});

test("an absent balance is unknown, never a match", () => {
  // The failure that would do damage: `include: ["pending_transactions"]` omits the summary, so all
  // four balance fields are absent. Treating absent as 0 makes every such call say the books balance.
  const noSummary = bankMatchesBooks({ bankCurrency: "NOK", tenantCurrency: "NOK" });
  assert.equal(noSummary.answer, "unknown");
  assert.deepEqual(noSummary.missing, ["bankLedgerClosingBalance", "actualBankDisplayedBalance"]);
  assert.match(noSummary.why, /absent balance is not zero/);

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
  assert.equal(v.arisenThisMonth, null);
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
