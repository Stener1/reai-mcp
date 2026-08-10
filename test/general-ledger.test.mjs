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

test("an account whose postings are not a list is named, not counted as zero", async () => {
  // The guard in test/list-shape caught an inline `Array.isArray(x) ? x.length : 0` here, and it was right:
  // reporting a non-array as zero says "this account has no postings" about an account whose postings came back
  // in a shape this tool did not expect. That is the silent-absence lie the whole repo is organised against.
  const ledger = {
    totalAmount: 0,
    accounts: [
      { accountNumber: "1920", accountName: "Bank", openingBalance: 0, closingBalance: 10, postings: [{ id: 1 }] },
      { accountNumber: "4300", accountName: "Varer", openingBalance: 0, closingBalance: 20, postings: "oops" },
      { accountNumber: "3000", accountName: "Salg", openingBalance: 0, closingBalance: 30, postings: undefined },
    ],
  };
  const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31" }, ledger);

  assert.match(text, /1 account\(s\) returned `postings` as something other than a list/);
  // The total counts only what was really counted, and says it excludes the rest.
  assert.match(text, /1 posting\(s\) in total/);
  assert.match(text, /excludes them/);
  // An ABSENT postings field is not the same defect and must not be reported as one. Scoped to the NOTE, not
  // the whole result: "3000" is that account's own number and appears in the summary either way, so an
  // unscoped regex here passes or fails for the wrong reason. Fourth time that trap has bitten in this repo.
  const shapeNote = /NOTE: [^]*?excludes them\./.exec(text)?.[0] ?? "";
  assert.ok(shapeNote, "the shape note is missing, so this assertion would be vacuous");
  assert.doesNotMatch(shapeNote, /3000/, "an absent postings field was reported as an unexpected shape");
  assert.match(shapeNote, /4300/, "the offending account must be named in the note");
});

test("a response that is not the expected shape is passed through untouched", async () => {
  // Fail open rather than silently summarising something this does not understand. If the API changes shape,
  // the caller should see what it actually sent — spec-drift.mjs is what notices the change.
  for (const odd of [[], { unexpected: true }, null, "a string"]) {
    const text = await run({ startDate: "2025-01-01", endDate: "2026-12-31" }, odd);
    assert.doesNotMatch(text, /account\(s\) with activity/, `shape ${JSON.stringify(odd)} was summarised anyway`);
  }
});
