import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOperations } from "../dist/reai/spec.js";

/**
 * Discovery has to work in Norwegian, because this is a Norwegian accounting system.
 *
 * Measured before touching anything: English queries found the right operation 12 times out
 * of 14, but both Norwegian queries in the set found nothing at all. "lønnskjøring" returned
 * zero results while "lonn" was already in the synonym table, and "hvor mye lager har vi"
 * returned the chart of accounts.
 *
 * Two causes. Most of the everyday vocabulary was simply missing. And Norwegian glues nouns
 * together, so the word a user types is often a compound whose meaning lives in one half —
 * lønn+kjøring, vare+lager, lager+beholdning — which no plural or diacritic rule reaches.
 *
 * The escape hatch is how an agent gets at the ~250 operations no curated tool covers, so a
 * query that returns nothing is the difference between a capable agent and a stuck one.
 */

const rankOf = (query, want) =>
  searchOperations({ query, limit: 25 })
    .map((h) => `${h.method} ${h.path}`)
    .indexOf(want);

/** Queries a Norwegian bookkeeper would actually type. */
const NORWEGIAN = [
  ["hvor mye lager har vi", "GET /api/warehouses/inventory"],
  ["lønnskjøring", "POST /api/salary-payments"],
  ["varelager", "GET /api/warehouses/inventory"],
  ["lagerbeholdning", "GET /api/warehouses/inventory"],
  ["opprett bilag", "POST /api/vouchers"],
  ["leverandørfaktura", "GET /api/supplier-invoices"],
  ["kundefaktura", "GET /api/invoices"],
  ["abonnement", "GET /api/subscriptions"],
  ["avdelinger", "GET /api/departments"],
  ["timeliste for ansatt", "GET /api/timesheets"],
  ["avskrivning", "PUT /api/assets/{id}/depreciation"],
  ["skattemelding", "GET /api/tax-returns/{year}"],
  ["kontoplan", "GET /api/chart-of-accounts"],
  ["utgifter", "GET /api/expenses"],
  ["åpningsbalanse", "GET /api/opening-balances"],
  ["aksjer", "GET /api/share-investments"],
  ["lån", "GET /api/loans"],
  ["reskontro for kunde", "GET /api/ledger/customer"],
  // Nested under an invoice — there is no /api/reminders, and the first version of this
  // list asserted one, which the search was right to ignore.
  ["purringer", "GET /api/invoices/{id}/reminders"],
];

/** English, so the Norwegian work cannot be bought with a regression. */
const ENGLISH = [
  ["stock levels", "GET /api/warehouses/inventory"],
  ["adjust inventory", "POST /api/warehouses/inventory/adjust"],
  ["rent agreement", "POST /api/agreements/rent-agreement"],
  ["employment contract", "POST /api/agreements/employee-contract"],
  ["opening balance", "GET /api/opening-balances"],
  ["loan", "GET /api/loans"],
  ["timesheet hours", "GET /api/timesheets"],
  ["leads", "GET /api/leads"],
  ["who owes us money", "GET /api/ledger/customer"],
  ["salary run", "POST /api/salary-payments"],
];

test("a Norwegian query finds the endpoint it is about", () => {
  const misses = [];
  const outsideTop3 = [];
  for (const [query, want] of NORWEGIAN) {
    const rank = rankOf(query, want);
    if (rank < 0) misses.push(`${query} → ${want}`);
    else if (rank >= 3) outsideTop3.push(`${query} → rank ${rank + 1}`);
  }
  assert.deepEqual(misses, [], "a Norwegian query returned nothing useful");
  // Not every one has to be first, but a bookkeeper should not be reading past three.
  assert.ok(outsideTop3.length <= 2, `too many outside the top 3: ${outsideTop3.join(", ")}`);
});

test("the English queries did not regress", () => {
  const misses = [];
  for (const [query, want] of ENGLISH) {
    if (rankOf(query, want) < 0) misses.push(`${query} → ${want}`);
  }
  assert.deepEqual(misses, []);
});

// The mechanism, separately from the vocabulary: a compound has to decompose even when its
// halves are not themselves in the query.
test("a Norwegian compound is decomposed", () => {
  // Each of these is one word to a tokenizer, and none is a synonym key on its own.
  for (const [compound, want] of [
    ["lønnskjøring", "POST /api/salary-payments"],
    ["lagerbeholdning", "GET /api/warehouses/inventory"],
    ["kundefakturaer", "GET /api/invoices"],
    ["prosjektregnskap", "GET /api/projects"],
  ]) {
    assert.ok(rankOf(compound, want) >= 0, `${compound} should reach ${want}`);
  }
  // And a stem must not fire on a word that merely contains it by accident. "konto" is
  // deliberately absent from the compound list because it sits inside "kontor" (an office)
  // and "kontant" (cash) — a substring rule that cheap would map both to the chart of
  // accounts.
  const kontor = searchOperations({ query: "kontor", limit: 5 }).map((h) => h.path);
  assert.ok(
    !kontor.includes("/api/chart-of-accounts"),
    "a coincidental substring must not become a synonym",
  );
});
