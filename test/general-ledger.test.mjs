import { test } from "node:test";
import assert from "node:assert/strict";
import { allTools } from "../dist/server.js";

/**
 * The general ledger answers about EVERY account with activity, or names one account and answers in full.
 *
 * Measured on tenant 2634 — 160 postings across 10 accounts, about as little data as an active company can have:
 * the API returns 45,805 characters and the 24,000-character result cap left `accounts shows 2 of 10`. The most
 * fundamental question in accounting came back with a fifth of the ledger, and nothing in the answer said which
 * accounts were missing. On a real set of books the fraction is smaller.
 *
 * The aggregate was already in the response — every account carries openingBalance and closingBalance, and the
 * bulk is the per-account postings arrays. So the fix is to drop those and keep a count, which answers what the
 * question usually means while the detail stays one filtered call away.
 */

const tool = allTools.find((t) => t.name === "reai_general_ledger");

/** A ledger far too large to fit, so the assertions below are about the property and not about a small fixture. */
function hugeLedger(accountCount = 40, postingsPer = 200) {
  return {
    totalAmount: 0,
    accounts: Array.from({ length: accountCount }, (_, i) => ({
      accountNumber: String(1000 + i * 10),
      accountName: `Account number ${1000 + i * 10} with a realistically long Norwegian name`,
      openingBalance: i * 100,
      closingBalance: i * 100 + 50,
      postings: Array.from({ length: postingsPer }, (_, p) => ({
        id: i * 1000 + p,
        voucherNumber: `MV${p}-2026`,
        postingDate: "2026-07-01",
        description: "A posting description of the kind this API actually returns, at length",
        amount: 10.5,
      })),
    })),
  };
}

const run = async (args, data) => {
  const res = await tool.handler(
    { tenantId: 2634, ...args },
    {
      client: { request: async () => ({ data, status: 200 }), deepLink: () => "link" },
      config: { boundTenantId: undefined, defaultTenantId: 2634, tenantId: 2634, writeMode: "read-only" },
      session: {},
    },
  );
  return (res.content ?? []).map((c) => c.text).join("\n");
};

test("every account with activity is reported, however large the ledger", async () => {
  const ledger = hugeLedger();
  const raw = JSON.stringify(ledger);
  assert.ok(raw.length > 24_000, `the fixture must not fit: it is only ${raw.length} chars`);

  const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31" }, ledger);

  assert.doesNotMatch(text, /truncat/i, "the summarised ledger should not need truncating");
  // Every account, by number, not merely the right count.
  for (const account of ledger.accounts) {
    assert.ok(text.includes(`"${account.accountNumber}"`), `account ${account.accountNumber} is missing`);
  }
  // Balances are the answer, so they must be present and complete.
  assert.match(text, /"openingBalance"/);
  assert.match(text, /"closingBalance"/);
  // The postings are not, and the note has to say so rather than leaving it to be inferred.
  assert.doesNotMatch(text, /"voucherNumber"/, "individual postings leaked into the summary");
  assert.match(text, /individual postings are NOT included/i);
  assert.match(text, /accountNumber, or reai_list_postings/, "the route to the detail must be named");

  // The counts must be real, not decorative: 40 accounts x 200 postings.
  assert.match(text, /40 account\(s\) with activity/);
  assert.match(text, /8000 posting\(s\) in total/);
});

test("naming one account returns it whole, postings included", async () => {
  // A caller who names an account has asked about that account: the response is bounded and the postings are
  // the point. This is the escape hatch that makes the summary above safe rather than lossy.
  const single = {
    totalAmount: 0,
    accounts: [
      {
        accountNumber: "4300",
        accountName: "Varer for videresalg",
        openingBalance: 0,
        closingBalance: 3095.8,
        postings: [{ id: 1, voucherNumber: "MV4-2026", amount: 3095.8 }],
      },
    ],
  };
  const text = await run({ accountNumber: "4300", startDate: "2025-01-01", endDate: "2026-12-31" }, single);
  assert.match(text, /"voucherNumber"/, "the postings must be present when one account is named");
  assert.doesNotMatch(text, /individual postings are NOT included/i);
});

test("an account without a countable posting list is named, not counted as zero", async () => {
  // Two distinct anomalies, both reported. `postings` present but not a list was the first; `postings` ABSENT was
  // originally treated as ordinary, and review was right that it is not — this endpoint returns only accounts
  // WITH ACTIVITY, so an account arriving without a list has an UNKNOWN count, not a zero one. Adding zero and
  // then stating a concrete total is the silent-absence lie in miniature.
  const ledger = {
    totalAmount: 0,
    accounts: [
      { accountNumber: "1920", accountName: "Bank", openingBalance: 0, closingBalance: 10, postings: [{ id: 1 }] },
      { accountNumber: "4300", accountName: "Varer", openingBalance: 0, closingBalance: 20, postings: "oops" },
      { accountNumber: "3000", accountName: "Salg", openingBalance: 0, closingBalance: 30 },
    ],
  };
  const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31" }, ledger);

  // Scoped to the NOTE: every account number appears in the summary regardless, so an unscoped regex here would
  // pass or fail for the wrong reason. That trap has bitten four times in this repo.
  const note = /NOTE: [^]*?excludes them\./.exec(text)?.[0] ?? "";
  assert.ok(note, "the shape note is missing, so these assertions would be vacuous");
  assert.match(note, /2 account\(s\) did not return a list of postings/);
  assert.match(note, /4300/, "the non-array account must be named");
  assert.match(note, /3000/, "the account with no postings field must be named too");
  assert.match(note, /UNKNOWN rather than zero/);
  // Only the one real array is counted.
  assert.match(text, /1 posting\(s\) in total/);
});

test("the summary never claims completeness over a shortened list", async () => {
  // The defect this change exists to fix, at a higher account count: the full summary runs about 164 characters
  // per account, so it crossed the 24,000-character cap at roughly 146 accounts — reachable for a full Norwegian
  // NS 4102 chart. Claiming "balances per account are complete" while ok() shortens the array underneath is worse
  // than the original truncation, because the note then contradicts the payload.
  //
  // The invariant is one-directional on purpose: it must never claim completeness over a shortened list. The
  // reverse — saying "shortened" over a list that fits — happens in a narrow band near the cap because the note's
  // own length is reserved conservatively, and that direction only costs a caller an unnecessary narrowing.
  for (const count of [10, 150, 300, 800, 1200, 2000]) {
    const ledger = {
      totalAmount: 0,
      accounts: Array.from({ length: count }, (_, i) => ({
        accountNumber: String(1000 + i),
        accountName: `Account ${1000 + i} with a realistically long Norwegian name`,
        openingBalance: i * 100,
        closingBalance: i * 100 + 50,
        postings: [{ id: i }],
      })),
    };
    const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31" }, ledger);
    const shortened = /truncat/i.test(text);
    const claimsComplete = /Balances per account are complete/.test(text);
    assert.ok(
      !(shortened && claimsComplete),
      `${count} accounts: the list was shortened AND the note claimed every balance is complete`,
    );
    // The account COUNT is always the true one, whatever was shown.
    assert.match(text, new RegExp(`${count} account\\(s\\) with activity`), `${count}: wrong account count`);
  }
});

test("a chart of accounts larger than any real one still fits", async () => {
  // 800 accounts is beyond a full NS 4102 chart with sub-accounts, and must come back whole. The compact form is
  // pipe-delimited STRINGS rather than tuples for this reason: ok() serialises indented, so a four-element array
  // costs five lines where a string costs one — measured at 400 accounts, 24,192 characters as tuples against
  // 10,192 as strings.
  const ledger = {
    totalAmount: 0,
    accounts: Array.from({ length: 800 }, (_, i) => ({
      accountNumber: String(1000 + i),
      accountName: `Account ${1000 + i} with a realistically long Norwegian name`,
      openingBalance: i * 100,
      closingBalance: i * 100 + 50,
      postings: [{ id: i }],
    })),
  };
  const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31" }, ledger);
  assert.doesNotMatch(text, /truncat/i, "800 accounts should fit in the compact form");
  assert.match(text, /800 account\(s\) with activity/);
  assert.match(text, /Balances per account are complete/);
  assert.match(text, /pipe-delimited/, "the encoding must be named or the rows are unreadable");
  // First and last account still present.
  assert.match(text, /"1000\|0\|50\|1"/);
  assert.match(text, /"1799\|/);
});

test("the detail route is only recommended when the filters transfer", async () => {
  const small = {
    totalAmount: 0,
    accounts: [{ accountNumber: "4300", accountName: "Varer", openingBalance: 0, closingBalance: 20, postings: [] }],
  };

  // Shared filters only: reai_list_postings can genuinely take these.
  const shared = await run({ startDate: "2025-01-01", endDate: "2026-12-31", customerId: 7 }, small);
  assert.match(shared, /reai_list_postings with the same filters/);

  // A filter that tool does not accept. Unknown Zod keys are STRIPPED, so following the old advice would have
  // issued a much broader query and presented unrelated postings as the requested detail — silently succeeding
  // with the wrong answer, which is worse than failing.
  for (const [field, value] of [["vatCode", "3"], ["accountFrom", "4000"], ["amountFrom", 100], ["voucherNumber", "MV4"]]) {
    const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31", [field]: value }, small);
    assert.match(text, /NOT `?interchangeable/i, `${field} should suppress the reai_list_postings suggestion`);
    assert.match(text, new RegExp(`does not accept [^.]*${field}`), `${field} must be named as unsupported`);
    assert.doesNotMatch(
      text,
      /reai_list_postings with the same filters/,
      `${field} must not be told to reuse filters that tool drops`,
    );
  }
});

test("a response that is not the expected shape is passed through untouched", async () => {
  // Fail open rather than silently summarising something this does not understand. If the API changes shape,
  // the caller should see what it actually sent — spec-drift.mjs is what notices the change.
  for (const odd of [[], { unexpected: true }, null, "a string"]) {
    const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31" }, odd);
    assert.doesNotMatch(text, /account\(s\) with activity/, `shape ${JSON.stringify(odd)} was summarised anyway`);
  }
});
