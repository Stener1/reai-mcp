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
 * The escape hatch is how an agent gets at the 143 operations no curated tool covers, so a
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
    // Two rounds of review on this one row, and both were right. It first asserted
    // "si opp leieavtalen" — terminate — against POST /api/agreements/rent-agreement, which CREATES
    // one. Rephrasing the question was not enough: the target was still a create, so a read question
    // was pinned to a mutating endpoint. It asserts the READ now, which the ranker does reach.
    ["hva står i leieavtale", "hva står i leieavtalen", "GET /api/agreements/{id}"],
    // And forms that already worked, so the test would notice the rule breaking them.
    ["slett bilag", "slett bilaget", "DELETE /api/vouchers/{id}"],
    ["godkjenn reiseregning", "godkjenn reiseregningen", "POST /api/expenses/{id}/approve"],
    // The -en consonant-stem class, which the first version of this work left out entirely.
    ["godkjenn reiseregning", "godkjenn reiseregningen", "POST /api/expenses/{id}/approve"],
    ["hvor mye beholdning", "hvor mye beholdningen", "GET /api/warehouses/inventory"],
    // And the -et half of the same class, which otherwise had no test at all: measured, removing the
    // -et rule left every other case passing.
    //
    // POST, not GET. This row first asserted the GET, which review caught: "last opp" is explicitly an
    // upload and the spec's POST /api/documents is summarised "Upload one or more documents". The
    // fixture was locking in the wrong method — see the phrase-intent test below for the fix.
    ["last opp dokument", "last opp dokumentet", "POST /api/documents"],
    ["vis vedlegg", "vis vedlegget", "GET /api/attachments/{id}"],
    // `anleggsmidlet` is NOT here, and the row that used to stand in for it was worse than nothing:
    // it asserted `anleggsmidler`, which is the indefinite PLURAL and its own synonym key, so it
    // passed on main and exercised neither rule while reading as if the class were covered. Review
    // caught that. The real limit is unchanged and stated: a stem-CHANGING definite —
    // anleggsmiddel becomes anleggsmidlet, dropping a vowel — is out of reach of any suffix rule.
  ]) {
    const bare = rankOf(indefinite, want);
    const suffixed = rankOf(definite, want);
    assert.ok(bare >= 0, `"${indefinite}" should find ${want}`);
    assert.ok(
      suffixed >= 0,
      `"${definite}" found nothing for ${want} — the definite form is how this is actually said`,
    );
    // EQUALITY, as the word-order test above uses. `suffixed < 5` was the first version and review
    // measured that it does no work: every row ranks its target #1 in both forms, so the threshold
    // had four ranks of slack and would have passed with the answer pushed behind three GETs — which
    // is precisely the regression a test called "the definite article does not change the answer"
    // exists to catch.
    assert.equal(
      suffixed,
      bare,
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

/**
 * The shortest real stem, which the length guards excluded by one character.
 *
 * `lån` (loan) folds to `lan`, so `lånet` folds to `lanet` — five characters, and the guards read
 * `base.length > 5`. Codex found it on #88. Measured before the fix: `lån` ranked GET /api/loans
 * first, `lånet` returned NOTHING, and `saldo på lånet` returned company-banks, departments and
 * salary-payments — it lost the loan endpoint entirely rather than merely reordering.
 *
 * `lan` is the only three-character stem among the 176 synonym keys that takes a consonant-stem
 * definite (`vat`, `mva`, `ehf` are abbreviations and `owe` is a verb), so this row IS the class.
 * The guards are gone rather than lowered: the gate — stem must be a synonym key — is the whole
 * protection, and no key is shorter than three characters, so there is nothing for a length to add.
 */
test("a three-letter stem reaches the definite rules", () => {
  for (const query of ["lånet", "lanet", "saldo på lånet", "lånene"]) {
    assert.ok(
      rankOf(query, "GET /api/loans") >= 0,
      `"${query}" found no loan endpoint — a three-letter stem is being excluded again`,
    );
  }
  // Rank equality with the indefinite, for the reason the test above gives.
  assert.equal(rankOf("lånet", "GET /api/loans"), rankOf("lån", "GET /api/loans"));
});

/**
 * The one-character suffix needs a higher floor than the rest, and Codex caught why on #95.
 *
 * A single -n strips one character, so it turns every four-letter word into a three-letter one — and
 * three-letter keys are exactly what removing the length guards set out to reach. With one uniform
 * floor, `vatn` (Nynorsk for water) stemmed to the known key `vat` and returned the VAT endpoints,
 * and `owen` stemmed to `owe`, so **"faktura til owen" — an invoice to a person — ranked the customer
 * LEDGER above /api/invoices**. That is the concrete harm; the dictionary examples are only how it
 * was noticed.
 *
 * Four for -n and three for the rest, and the asymmetry is not a fudge: every real Norwegian -n
 * definite has an -e stem, so adding -n to each three-letter key gives `vatn`, `mvan`, `owen`, `ehfn`,
 * `lann` — not one of which is a definite form of it.
 */
test("a one-character suffix does not strip a four-letter word", () => {
  for (const query of ["vatn", "owen", "vatn og avløp"]) {
    assert.equal(
      searchOperations({ query, limit: 3 }).length,
      0,
      `"${query}" derived a three-letter key it has nothing to do with`,
    );
  }
  // The case that actually matters: a name must not outrank the noun next to it.
  const at = rankOf("faktura til owen", "GET /api/invoices");
  assert.ok(at === 0, `"faktura til owen" ranks GET /api/invoices at ${at + 1}, behind the ledger`);
  // And the -n rule still does its job on the class it exists for.
  for (const [query, want] of [
    ["kunden", "GET /api/ledger/customer"],
    ["ordren", "GET /api/orders"],
    ["avtalene", "GET /api/agreements"],
  ]) {
    assert.ok(rankOf(query, want) >= 0, `"${query}" should still find ${want}`);
  }
});

/**
 * The plural definite of a CONSONANT stem is -ene, and fixing the singular is what made its absence
 * obvious: `utgiften` resolved while `utgiftene` returned nothing. The -e nouns were already covered
 * by the -ne rule because their stem keeps its own -e (`kunde` -> `kundene`), which is exactly why
 * this gap survived — the class looked handled.
 *
 * Measured before the rule: all six of these returned NOTHING.
 */
test("the consonant-stem definite plural resolves", () => {
  for (const [query, want] of [
    ["utgiftene", "GET /api/expenses"],
    ["dokumentene", "GET /api/documents"],
    ["vedleggene", "GET /api/attachments/{id}"],
    ["produktene", "GET /api/products"],
    ["lånene", "GET /api/loans"],
    ["kontoene", "GET /api/chart-of-accounts/accounts"],
  ]) {
    assert.ok(rankOf(query, want) >= 0, `"${query}" should find ${want}`);
  }
});

// A gate test was drafted here and deleted: "a suffix rule only fires on a stem the table knows"
// below already covers it, and more strictly — it asserts the top 3 rather than mere presence, and it
// names the three queries the ungated rule measurably broke. Dropping the gate fails that test and
// both third-corpus score floors; it did not fail the draft, which is what settled it.

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
    // Two more that the ungated rule broke, measured: it ranked GET /api/tax-returns/{year} first for
    // both — the annual income-tax return displacing the product resource and the annual accounts.
    // The `subscription` row that used to sit here was inert: identical top-3 with and without the
    // rule, so only one of the two cases was live.
    ["annual return", "GET /api/annual-accounts/{year}"],
    ["transaction product", "GET /api/products"],
  ]) {
    const at = rankOf(query, want);
    assert.ok(at >= 0 && at < 3, `"${query}" should rank ${want} in the top 3, got ${at + 1}`);
  }
});

test("intent can come from a phrase, not only from a word", () => {
  // "Last opp" is upload and "last ned" is download — opposite methods sharing a verb that means
  // neither alone. `last` is also the noun for a load and an English word, so neither the method table
  // nor the write-intent set can hold it: the direction is in the particle and only the pair says
  // anything. Review found the consequence — "last opp dokumentet" ranked GET /api/documents while the
  // spec's POST is summarised "Upload one or more documents".
  for (const [query, want] of [
    ["last opp dokument", "POST /api/documents"],
    ["last opp dokumentet", "POST /api/documents"],
    ["laste opp et dokument", "POST /api/documents"],
  ]) {
    const at = rankOf(query, want);
    assert.ok(at >= 0 && at < 3, `"${query}" should rank ${want} in the top 3, got ${at + 1}`);
  }

  // And the other direction must NOT be read as a write. This is the case that makes the phrase rule
  // necessary rather than just adding `laste` to the verb tables — "laste ned" is a download.
  //
  // Asserted on the FIRST result, which is what the mechanism actually promises: implied methods bias
  // the ranking, they do not filter by method, so a write can still appear further down. A first
  // version demanded zero writes in the top five and failed on "last ned rapporten", where
  // POST /api/documents sits at rank four behind three GETs — the intent was respected and the
  // assertion was simply describing something the rule does not do.
  for (const query of ["last ned rapporten", "last ned pdf"]) {
    const top = searchOperations({ query, limit: 1 })[0];
    assert.ok(top, `"${query}" should find something`);
    assert.equal(top.method, "GET", `"${query}" is a download but ranked ${top.method} ${top.path} first`);
  }
  // The upload direction, conversely, must put a write first.
  for (const query of ["last opp dokumentet", "laste opp et dokument"]) {
    const top = searchOperations({ query, limit: 1 })[0];
    assert.equal(top.method, "POST", `"${query}" is an upload but ranked ${top.method} ${top.path} first`);
  }
});

/**
 * Loans and the words around them, which were almost entirely unreachable.
 *
 * `/api/loans` answered to `lån` and `loan` and to very little else. Measured before this: `gjeld`,
 * `avdrag`, `aksjonærlån`, `hovedstol` and `borrowing` returned NOTHING at all, and `banklån` and
 * `ansattlån` — ordinary Norwegian compounds — ranked company-banks and the employee ledger instead.
 * A domain nobody can name is a domain nobody can use, whatever tools it has.
 *
 * `renter` is the one that was actively WRONG rather than missing, and it is the reason this test
 * exists as a named case rather than a list. It is Norwegian for interest, and it ranked
 * `/api/agreements/rent-agreement` first: the -er rule strips it to `rent`, which matches that path
 * segment. Norwegian for rent is `leie`, so the collision is with English, and a user asking about the
 * interest on a loan was pointed at rent agreements — a confident wrong answer, which this repository
 * has repeatedly found to be worse than no answer.
 */
test("the loan vocabulary reaches the loan endpoints", () => {
  for (const query of [
    "gjeld",
    "avdrag",
    "hovedstol",
    "borrowing",
    "banklån",
    "ansattlån",
    "aksjonærlån",
    "renter",
    "rentesats",
  ]) {
    const at = rankOf(query, "GET /api/loans");
    assert.ok(at >= 0 && at < 3, `"${query}" should reach GET /api/loans in the top 3, got ${at + 1}`);
  }
});

/**
 * The other half of adding vocabulary, and the half the first version of this work got wrong: a word
 * broad enough to mean several things must not outrank the resource a query NAMES.
 *
 * Review measured four cases where the new entries did exactly that — `gjeld til leverandør` pushed the
 * supplier ledger from first to fourth, `nedbetaling av faktura` and `avdrag på faktura` moved off the
 * invoice payments, `motpart på banktransaksjon` filled all four top places with creditors and debtors,
 * and the English `renter agreement` (a person who rents) lost the rent agreement. Every one was a
 * generic term carrying several strong tokens and drowning a specific one.
 *
 * Two of the terms were dropped rather than weakened, because they are genuinely ambiguous and picking
 * a side is the bug: `nedbetaling` (an invoice gets paid down too — it reaches the invoice payments,
 * which is the better default) and `motpart` (the counterparty of anything, not only a loan). The rest
 * carry ONE token now.
 */
test("a broad loan word does not outrank the resource a query names", () => {
  for (const [query, want] of [
    ["gjeld til leverandør", "GET /api/ledger/supplier"],
    ["nedbetaling av faktura", "GET /api/invoices/{id}/payments"],
  ]) {
    assert.equal(rankOf(query, want), 0, `"${query}" should rank ${want} first`);
  }

  // English: a `renter` is a person who rents, so the -er rule reaching `rent` is CORRECT here and the
  // rent agreement has to win. Asserted on the RESOURCE rather than the verb — it ranks the POST first,
  // which is a question about intent and not about this fix.
  const top = searchOperations({ query: "renter agreement", limit: 1 }).map((h) => h.path)[0];
  assert.match(String(top), /rent-agreement/, `"renter agreement" should still rank the rent agreement first, got ${top}`);

  // `avdrag på faktura` is the one case left imperfect, and it is stated rather than hidden: the
  // invoice payments rank third behind the two loan reads. Accepted because `avdrag` is specifically a
  // loan principal instalment in Norwegian accounting — an invoice is paid in `delbetaling` — so the
  // phrase is unusual and the term is worth keeping. If it ever needs fixing, the fix is a
  // narrower-scope mechanism, not a heavier synonym.
  const at = rankOf("avdrag på faktura", "GET /api/invoices/{id}/payments");
  assert.ok(at >= 0 && at < 4, `the invoice payments should still be reachable, got ${at + 1}`);
});

test("the counterparty ledgers answer to their Norwegian names", () => {
  // A loan's counterparty is a creditor or a debtor depending on its perspective, so these are the
  // endpoints a caller needs next. They answered to the English words only: `creditor` found
  // /api/creditors while `kreditor` found nothing, and `debitor` ranked a supplier-invoice cost-line.
  for (const [query, want] of [
    ["kreditor", "GET /api/creditors"],
    ["kreditorer", "GET /api/creditors"],
    ["debitor", "GET /api/debtors"],
    ["debitorer", "GET /api/debtors"],
  ]) {
    const at = rankOf(query, want);
    assert.ok(at >= 0 && at < 3, `"${query}" should reach ${want} in the top 3, got ${at + 1}`);
  }
});

test("teaching it interest did not cost it rent", () => {
  // The other half of a homograph fix. `renter` now means interest, and `leie` still has to mean rent
  // — otherwise this trades one confident wrong answer for another.
  for (const query of ["husleie", "leiekontrakt", "leieavtalen", "si opp leieavtale"]) {
    const hits = searchOperations({ query, limit: 3 }).map((h) => `${h.method} ${h.path}`);
    assert.ok(
      hits.some((h) => /\/api\/agreements/.test(h)),
      `"${query}" should still reach the agreements: ${hits.join(", ")}`,
    );
  }
  // And interest must not reach the rent agreement FIRST, which is the state this fixed.
  const first = searchOperations({ query: "renter", limit: 1 }).map((h) => h.path)[0];
  assert.doesNotMatch(String(first), /rent-agreement/, "renter is interest, not rent");
});
