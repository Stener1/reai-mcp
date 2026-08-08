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
  // Both of these slipped past the first version of this list, which is why they broke:
  // "årsregnskap" folds to "arsregnskap" and the synonym was keyed on a guess, and
  // "driftsmidler" is an irregular plural no suffix rule reaches.
  ["årsregnskap", "GET /api/annual-accounts/{year}"],
  ["driftsmidler", "GET /api/ledger/asset"],
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

// Presence in the top 25 was all this asserted, so an English query could slide from first
// to twenty-fifth and still pass — and a rank regression is precisely what it exists to
// catch. The compound pass caused one: because a term's weight was pinned by whichever token
// mentioned it first, "fakturagebyr på faktura" put /api/invoices fourth while the same two
// words in the other order kept it first. Ranks are asserted now.
test("the English queries did not regress in RANK, not merely in presence", () => {
  const worse = [];
  for (const [query, want] of ENGLISH) {
    const rank = rankOf(query, want);
    if (rank < 0) worse.push(`${query} → not found`);
    else if (rank >= 3) worse.push(`${query} → rank ${rank + 1}`);
  }
  // "salary run" sits outside the top three on main as well; it is the one query here that
  // was already mediocre, and this change does not affect it either way.
  assert.deepEqual(worse, ["salary run → rank 8"], "an English query lost ground");
});

// The order-dependence bug in its own right, since it is the kind that hides: both phrasings
// have to give the same answer, or the ranking depends on which word a user types first.
test("word order does not change the answer", () => {
  for (const [a, b, want] of [
    ["fakturagebyr på faktura", "faktura på fakturagebyr", "GET /api/invoices"],
    ["fakturagebyr fakturaer", "fakturaer fakturagebyr", "GET /api/invoices"],
    ["lønnskjøring bilag", "bilag lønnskjøring", "POST /api/vouchers"],
  ]) {
    const rankA = rankOf(a, want);
    const rankB = rankOf(b, want);
    assert.ok(rankA >= 0 && rankB >= 0, `${want} should be found for both orderings`);
    assert.equal(rankA, rankB, `"${a}" and "${b}" rank ${want} differently (${rankA + 1} vs ${rankB + 1})`);
  }
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

  // An unanchored `includes` matched a stem anywhere in the token, so ordinary Norwegian
  // words returned accounting endpoints with confidence: "kolonner" (columns) and
  // "belønning" (reward) both reached payroll, "sekunder" (seconds) the customer ledger,
  // "slager" (a hit song) the warehouse. Compounds keep their elements at the edges, so a
  // stem is only accepted at one — with at least two characters left over for the other.
  for (const word of ["kolonner", "belønning", "sekunder", "slager", "lønnsomhet"]) {
    assert.equal(
      searchOperations({ query: word, limit: 3 }).length,
      0,
      `"${word}" is not an accounting term and should match nothing`,
    );
  }
  // "lønnsomhet" shares a root with lønn rather than merely containing it, which no string
  // rule separates — it is listed as an exception, and the multi-word phrasing still works
  // because the real resource term carries it.
  assert.ok(rankOf("lønnsomhet per avdeling", "GET /api/departments") >= 0);

  // "beklager" ("sorry") ends in "lager", so a conversational apology was read as a
  // question about the warehouse: "beklager, hvor er abonnementene" ranked stock above
  // subscriptions. It is a filler word, so it belongs in the stopword list rather than in a
  // compound exception — and a polite question must give the same answer as a blunt one.
  assert.deepEqual(
    searchOperations({ query: "beklager, hvor er abonnementene", limit: 3 }).map((h) => h.path),
    searchOperations({ query: "hvor er abonnementene", limit: 3 }).map((h) => h.path),
    "a Norwegian filler word must not change the answer",
  );
});

/**
 * The definite article is a SUFFIX in Norwegian, and inflection must not change the answer.
 *
 * This is the same class of bug as the word-order test above: it hides, because the phrasing a
 * developer writes in a test is the indefinite one and the phrasing a person speaks is usually the
 * definite one. "Send fakturaen", "endre kunden", "si opp leieavtalen" — nobody says "send faktura".
 *
 * Most definite forms already resolved by accident: the compound-stem rule finds `faktura` inside
 * `fakturaen`. But it needs at least two characters left over, and the commonest Norwegian noun class
 * ends in -e and takes a single -n — so `kunden`, `ordren`, `leieavtalen` and `husleien` resolved to
 * NOTHING, which is a quarter of the synonym keys. Measured before the fix: "endre kunden" and "vis
 * ordren" returned no endpoint at all while "opprett kunde" and "vis ordre" ranked correctly.
 *
 * Asserted as a PROPERTY rather than a score, for the reason the word-order test gives: both
 * phrasings have to give the same answer, or the ranking depends on which grammatical form someone
 * happens to use.
 */
test("the definite article does not change the answer", () => {
  for (const [indefinite, definite, want] of [
    // The -e noun class, which is where the gap was: a single -n leaves nothing for the compound rule.
    ["endre kunde", "endre kunden", "PATCH /api/customers/{id}"],
    ["vis ordre", "vis ordren", "GET /api/orders"],
    ["si opp leieavtale", "si opp leieavtalen", "POST /api/agreements/rent-agreement"],
    // And forms that already worked, so the test would notice the rule breaking them.
    ["slett bilag", "slett bilaget", "DELETE /api/vouchers/{id}"],
    ["godkjenn reiseregning", "godkjenn reiseregningen", "POST /api/expenses/{id}/approve"],
    // `anleggsmidlet` is deliberately NOT here. Its definite form drops a vowel from the stem —
    // anleggsmiddel becomes anleggsmidlet — and no suffix rule reaches a stem change. That is a real
    // limit of this approach, stated rather than hidden: the -n and -ne rules cover the -e noun class,
    // the compound-stem rule covers -et and -en where two characters remain, and stem-changing
    // definites are not covered at all.
    ["opprett anleggsmiddel", "opprett anleggsmidler", "POST /api/assets"],
  ]) {
    const bare = rankOf(indefinite, want);
    const suffixed = rankOf(definite, want);
    assert.ok(bare >= 0, `"${indefinite}" should find ${want}`);
    assert.ok(
      suffixed >= 0,
      `"${definite}" found nothing for ${want} — the definite form is how this is actually said`,
    );
    // Not equality: adding a suffix legitimately shifts a rank by one or two as other terms
    // re-weight. What must not happen is the definite form dropping out of reach.
    assert.ok(
      suffixed < 5,
      `"${definite}" ranks ${want} at ${suffixed + 1} while "${indefinite}" ranks it at ${bare + 1}`,
    );
  }
});

test("the definite plural resolves too", () => {
  // -ene on an -e stem: kunde -> kundene. The same one-character problem as the singular.
  for (const [query, want] of [
    ["hvilke kunder", "GET /api/customers"],
    ["hvilke kundene skylder oss", "GET /api/ledger/customer"],
    ["leverandørene våre", "GET /api/suppliers"],
    // This is the one that actually needs the -ne rule, and it is here because the others do not:
    // measured, `kundene`, `leverandørene` and `fakturaene` all resolve by other paths, so a test
    // built from them would have passed with the rule deleted. `avtalene` returns nothing without it.
    ["avtalene", "GET /api/agreements"],
  ]) {
    assert.ok(rankOf(query, want) >= 0, `"${query}" should find ${want}`);
  }
});

test("a short word ending in -n survives, though nothing currently distinguishes the guard", () => {
  // `lån` is three characters and ends in -n, so the length guard on the rule exists to stop it being
  // stripped to two. Said plainly: relaxing that guard breaks NO query I can find, because `lån` still
  // matches as itself and the junk form `lå` matches nothing — so the guard is precautionary and this
  // test does not prove it. That is worth stating rather than implying otherwise, which is a mistake
  // review caught in this repo before: a comment claiming both halves of a check were load-bearing
  // when one of them could not be reached.
  for (const [query, want] of [
    ["saldo på lån", "GET /api/loans"],
    ["lån", "GET /api/loans"],
  ]) {
    assert.ok(rankOf(query, want) >= 0, `"${query}" should still find ${want}`);
  }
});

test("a suffix rule only fires on a stem the table knows", () => {
  // Review's finding, and the reason the -n rule is gated. Stripping a trailing -n from anything long
  // enough also turns `documentation` into `documentatio`, and matchStrength then matches both forms
  // against the same endpoint token — so a two-word English query was skewed by one word counting
  // twice. Measured against main: "product documentation" ranked /api/products first before the rule
  // and the document-reception endpoints first after it. Worse than not having the rule at all.
  //
  // A derived form that is not a synonym key buys nothing and can only distort, which makes the gate
  // the mechanism rather than a safeguard.
  for (const [query, want] of [
    ["product documentation", "GET /api/products"],
    ["subscription", "GET /api/subscriptions"],
  ]) {
    const at = rankOf(query, want);
    assert.ok(at >= 0 && at < 3, `"${query}" should rank ${want} in the top 3, got ${at + 1}`);
  }
});
