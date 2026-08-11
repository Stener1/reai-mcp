import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOperations, findOperation } from "../dist/reai/spec.js";

/**
 * A third corpus: whole SENTENCES, written before looking at what the ranker did with any of them.
 *
 * The two existing sets are mostly single terms and short phrases — "inngående faktura", "feriepenger",
 * "slett utgift". This one is what an accountant would actually type at an agent: "hvor mye skylder
 * kundene meg", "book a supplier invoice to an expense account". What is new is sentence LENGTH: filler
 * words, subordinate clauses and prepositional phrases around the resource word.
 *
 * NOT question forms. The first version of this comment claimed those were untested, and review showed
 * otherwise — test/discovery-heldout.test.mjs already holds "hvor mye skylder vi leverandørene", "hva er
 * neste fakturanummer" and "hvilke varer er på lager", and src/reai/spec.ts says as much in its own
 * words. "hvilke varer har jeg pa lager" below is a near-duplicate of one of them.
 *
 * Written in one sitting, then measured once. With every target labelled as the endpoint that actually
 * does the job — not as whatever the ranker happened to return — and scored on METHOD AND PATH, this
 * reads **15 of 20 at rank 1 and 18 of 20 in the top 3**. One gap was fixed on the strength of it
 * (`legg til`, see PHRASE_INTENT). The misses that remain are named at the bottom of this file with
 * their causes.
 *
 * Both of those qualifications cost points, and both were mine to get wrong. Scoring on the path alone
 * read 17 of 20, because "lag et tilbud til en kunde" targets POST /api/offers and the ranker returns
 * GET /api/offers first — counted as rank 1 while being exactly the miss this corpus set out to record.
 *
 * ## Two of my own labels were wrong, and that is the more useful finding
 *
 * The first measurement scored 13 of 20 because I had labelled the targets from memory. Two of the
 * seven "misses" were the ranker giving a BETTER answer than the one I asked for:
 *
 *     change a customers address       I wanted /api/customers/{id}
 *                                      it returned PUT /api/customers/{id}/address
 *     hvilke varer har jeg pa lager    I wanted /api/warehouses
 *                                      it returned GET /api/warehouses/inventory
 *
 * Both of those are the endpoint that does the thing. Scoring them as failures would have set a floor
 * that punishes the ranker for being right, and — worse — invited a "fix" that made it wronger. The
 * labels below are the corrected ones, and every target is checked to exist before it is used, because
 * asserting a path the API does not have is a mistake this repo has made before.
 *
 * A third of my first run was pure instrument error: I called `searchOperations(query, {limit})`
 * positionally when it takes a single options object, so every query ran with an empty string and all
 * twenty returned the same three unranked operations. That reads exactly like a catastrophic ranking
 * failure — 0 of 20 — and the tell was that the three results never changed. Verify the harness before
 * believing a number that surprises you.
 */

const CASES = [
  // Questions about money owed, in both languages.
  ["hvor mye skylder kundene meg", "GET", "/api/ledger/customer"],
  ["list unpaid customer invoices", "GET", "/api/invoices"],
  ["who are my biggest suppliers", "GET", "/api/ledger/supplier"],
  ["hvilke fakturaer er forfalt", "GET", "/api/invoices"],
  ["hvor mye har jeg pa bankkontoen", "GET", "/api/company-banks"],

  // Doing something to a named record.
  ["change a customers address", "PUT", "/api/customers/{id}/address"],
  ["endre en ordre", "PUT", "/api/orders/{id}"],
  ["download an invoice pdf", "GET", "/api/invoices/{id}/pdf"],
  ["find a customer by organisation number", "GET", "/api/customers"],

  // Creating things, English and Norwegian.
  ["add a new employee", "POST", "/api/employees"],
  ["book a supplier invoice to an expense account", "POST", "/api/supplier-invoices"],
  ["set up a recurring subscription invoice", "POST", "/api/subscriptions"],
  ["registrer et utlegg", "POST", "/api/expenses"],
  ["lag et tilbud til en kunde", "POST", "/api/offers"],

  // `legg til` — the commonest Norwegian "add", and the gap this corpus found. Before the
  // PHRASE_INTENT entry, "legg til en leverandor" ranked POST /api/suppliers ELEVENTH, with nine GETs
  // and DELETE /api/suppliers/{id} ahead of it, and "legg til en ny kunde" ranked POST /api/customers
  // fifth. `opprett` reached both first, so it was purely which synonym the caller used.
  //
  // Those figures were first published as "5th" and "3rd", measured with a path-only comparison — the
  // ranks of the GET on the same path. The same inflation as rankOf below, in the prose this time.
  ["legg til en ny kunde", "POST", "/api/customers"],
  ["legge til et vedlegg pa en ordre", "POST", "/api/orders/{id}/attachments"],

  // `lag` is deliberately NOT a create verb — METHOD_INTENT excludes it because `lag` is also the
  // everyday noun for a team, so "ansatte per lag" was being read as a create. The target here is
  // therefore the endpoint that DOES the job (POST /api/offers) even though the ranker returns the
  // collection GET, so this corpus records a known miss rather than blessing it. Labelling the GET
  // would have been the same mistake as test/ui.test.mjs asserting "this month is reconciled".

  // Reading reference data.
  ["what accounts are in my chart of accounts", "GET", "/api/chart-of-accounts/accounts"],
  ["hvilke varer har jeg pa lager", "GET", "/api/warehouses/inventory"],
  ["se alle banktransaksjoner som ikke er avstemt", "GET", "/api/bank-reconciliations/{bankAccountId}"],
  ["what is my vat position this term", "POST", "/api/vat-returns"],
];

/**
 * Rank of the target OPERATION — method and path — or -1.
 *
 * Matching on the path alone inflates the score, and did: "lag et tilbud til en kunde" targets
 * POST /api/offers, the ranker returns GET /api/offers first, and a path-only comparison counted that
 * as rank 1. It read 17 of 20 while the case the corpus was recording as a miss passed silently. A
 * method is half of what an agent needs; scoring without it measures the wrong thing.
 */
function rankOf(query, method, path) {
  return searchOperations({ query, limit: 10 }).findIndex((h) => h.path === path && h.method === method);
}

test("every target in this corpus exists in the spec", () => {
  for (const [query, method, path] of CASES) {
    assert.ok(findOperation(method, path), `${query}: target ${method} ${path} does not exist`);
  }
});

test("at least 14 of the 20 sentence queries rank their endpoint first", () => {
  const ranks = CASES.map(([query, method, path]) => [query, rankOf(query, method, path)]);
  const first = ranks.filter(([, r]) => r === 0);
  // The floor is the measurement minus one. Set at the measurement exactly, an unrelated synonym
  // would fail this file rather than the change that caused it; set far below, drift goes unnoticed,
  // which is what happened to the first held-out corpus (floors of 38/39 against a real 39/41).
  assert.ok(
    first.length >= 14,
    `${first.length} of ${CASES.length} at rank 1; not first:\n  ` +
      ranks
        .filter(([, r]) => r !== 0)
        .map(([q, r]) => `${q} — rank ${r < 0 ? "absent" : r}`)
        .join("\n  "),
  );
});

test("and at least 17 rank it in the top 3", () => {
  const outside = CASES.filter(([query, method, path]) => {
    const r = rankOf(query, method, path);
    return r < 0 || r >= 3;
  });
  assert.ok(
    CASES.length - outside.length >= 17,
    `only ${CASES.length - outside.length} in the top 3; outside:\n  ` +
      outside.map(([q, , p]) => `${q} -> want ${p}`).join("\n  "),
  );
});

test("a `legg til` query asks for a WRITE, not the ledger view of the same resource", () => {
  // The gap this corpus found. `legg til` is a PHRASE, which is why it belongs in PHRASE_INTENT and
  // not in METHOD_INTENT: bare `legg` is not a create request. Asserted per query rather than only
  // through the aggregate floor above, or the aggregate could absorb its loss silently.
  for (const [query, path] of [
    ["legg til en leverandor", "/api/suppliers"],
    ["legg til en ny kunde", "/api/customers"],
    ["legge til et vedlegg pa en ordre", "/api/orders/{id}/attachments"],
  ]) {
    const hits = searchOperations({ query, limit: 3 });
    assert.ok(hits.length > 0, `${query} returned nothing`);
    assert.equal(hits[0].method, "POST", `${query} ranked ${hits[0].method} ${hits[0].path} first`);
    // The METHOD alone is not enough. Asserting only that the top hit is a POST passed while the first
    // result for the supplier query was POST /api/supplier-invoices/{id}/attachments/existing — a write,
    // and the wrong endpoint entirely. The target must be in the top three as well.
    const rank = rankOf(query, "POST", path);
    assert.ok(rank >= 0 && rank <= 2, `POST ${path} is at rank ${rank} for "${query}"`);
  }
});

test("two phrases that agree on a method do not cancel each other out", () => {
  // `phraseMethodsFor` discarded its hint whenever TWO entries matched, which was the same thing as
  // "one phrase only" while last opp/last ned were the whole table. A second POST phrase broke it: the
  // natural way to ask for both operations matched twice, lost the hint, and every non-GET took the
  // no-intent 0.7 cut — the whole top three inverting from writes to reads.
  for (const query of [
    "last opp og legg til vedlegg",
    "last opp et vedlegg og legg til ordren",
    "last opp faktura og legg til bilag",
  ]) {
    const [top] = searchOperations({ query, limit: 1 });
    assert.equal(top.method, "POST", `${query} ranked ${top.method} ${top.path} first`);
  }

  // And phrases that DISAGREE still yield nothing, which is what the exclusivity rule was for.
  const [top] = searchOperations({ query: "last opp og last ned filen", limit: 1 });
  assert.equal(top.method, "GET", "a query naming an upload AND a download must not imply either");
});

test("`legge til grunn` and `legge til rette` are idioms, not requests to add", () => {
  // Both contain the phrase contiguously and are stock Norwegian accounting language. Unexcluded they
  // promoted IRREVERSIBLE writes over a read — "hvilket beløp skal jeg legge til grunn for mva" offered
  // POST /api/vat-returns/reopen in answer to a question about which figure to use.
  for (const query of [
    "hvilket belop skal jeg legge til grunn for mva",
    "hvilket beløp skal jeg legge til grunn for mva",
    "legge til rette for avstemming",
  ]) {
    const hits = searchOperations({ query, limit: 1 });
    assert.ok(hits.length > 0, `${query} returned nothing`);
    assert.equal(hits[0].method, "GET", `${query} ranked ${hits[0].method} ${hits[0].path} first`);
  }
});

test("neither the past participle nor the present tense asks for a write", () => {
  // Two traps, one conjugation apart.
  //
  // `lagt til` is the past participle: "hvor mange kunder ble lagt til i fjor" asks what happened, and
  // a POST first for it is a write offered in answer to a question — what keeps "make", "cancel",
  // "new" and "start" out of WRITE_INTENT_VERBS. Its exclusion is less of a decision than the source
  // comment implies: legge/la/lagt is a strong verb, so `lagt` is a different STEM and no suffix group
  // on `legg` could produce it. The case is still worth asserting, because a future entry could add it
  // deliberately — mutating the pattern to `(legg(e|er)?|lagt)` turns this test red.
  //
  // `legger til` is the present tense, and the first version of this change matched it while claiming
  // present tense was unambiguous. Review found it inside a RELATIVE CLAUSE of an explicit read
  // request: "vis kunder vi legger til i år" returned POST /api/customers, and the supplier form
  // offered to UNARCHIVE a supplier in answer to "show me". writeIntent is evaluated before
  // readIntent, so the phrase silently beat as plain a read verb as `vis`.
  for (const query of [
    "hvor mange kunder ble lagt til i fjor",
    "hvilke ansatte er lagt til",
    "hvilke vedlegg ble lagt til pa ordren",
    "vis kunder vi legger til i år",
    "vis kunder vi legger til i ar",
    "vis leverandorer vi legger til i ar",
  ]) {
    // `hits[0]` rather than a destructure: `const [top] = …` throws a TypeError on an empty result set
    // instead of failing an assertion, and an empty set is reachable — "legge til grunn" alone returns
    // nothing. A crash and a failure are not the same signal.
    const hits = searchOperations({ query, limit: 1 });
    assert.ok(hits.length > 0, `${query} returned nothing`);
    assert.equal(hits[0].method, "GET", `${query} ranked ${hits[0].method} ${hits[0].path} first`);
  }
});

test("all five queries that are not at rank 1 are named, with their causes", () => {
  // NAMED, so that "15 of 20" is not a number anyone has to re-derive to understand. The title and the
  // count were both stale from a two-item version of this test, which is its own small lesson: a test
  // that enumerates cases has to be renamed when the list grows, or it understates its own coverage.
  //
  // 1. `lag et tilbud til en kunde` returns GET /api/offers, and POST /api/offers is not in the top ten
  //    at all. `lag` is excluded from METHOD_INTENT on purpose (it is also the everyday noun for a
  //    team, so "ansatte per lag" read as a create), and that exclusion is argued at its definition.
  //    A miss by choice — recorded, not blessed.
  assert.equal(searchOperations({ query: "lag et tilbud til en kunde", limit: 1 })[0].method, "GET");
  assert.equal(rankOf("lag et tilbud til en kunde", "POST", "/api/offers"), -1);

  // 2. `who are my biggest suppliers` ranks the supplier collection above the supplier LEDGER, which is
  //    where balances live. Defensible either way — "suppliers" is literally what the query names — so
  //    it is pinned as behaviour rather than argued as correct.
  assert.equal(rankOf("who are my biggest suppliers", "GET", "/api/ledger/supplier"), 2);

  // 3. `set up a recurring subscription invoice` puts POST /api/subscriptions fourth; the three ahead
  //    of it are all subscription operations, so the resource is right and the method ordering is not.
  assert.equal(rankOf("set up a recurring subscription invoice", "POST", "/api/subscriptions"), 3);

  // 4. `what is my vat position this term` ranks POST /api/vat-returns third behind GET /api/vat-codes.
  //    There IS no read endpoint for a VAT position — the quirk `vat-position-has-no-read-endpoint`
  //    records that — so no ranking change can produce a satisfying first hit here.
  assert.equal(rankOf("what is my vat position this term", "POST", "/api/vat-returns"), 2);
  // The second hit is GET /vat-return/altinn-sync, which this repo classifies as a read-shaped
  // operation that TRANSMITS to Altinn — worth knowing about in a top three for a VAT question.
  assert.equal(searchOperations({ query: "what is my vat position this term", limit: 2 })[1].path, "/vat-return/altinn-sync");

  // 5. `se alle banktransaksjoner som ikke er avstemt` ranks GET /api/company-banks first, ahead of the
  //    reconciliation view. Not a near-miss: a list of bank ACCOUNTS does not answer a question about
  //    unreconciled transactions. It scores 33.3 against 32.8 — the query names "bank" twice over
  //    (banktransaksjoner) and the company-banks path is the shortest thing carrying it.
  assert.equal(rankOf("se alle banktransaksjoner som ikke er avstemt", "GET", "/api/company-banks"), 0);
  assert.equal(rankOf("se alle banktransaksjoner som ikke er avstemt", "GET", "/api/bank-reconciliations/{bankAccountId}"), 1);
});

test("the fixed query still has a wrong FIRST hit, and its cause is the documented prose bias", () => {
  // "legg til en leverandor" ranks POST /api/supplier-invoices/{id}/attachments/existing above
  // POST /api/suppliers. It is not the verb and not the formula: `POST /api/suppliers` carries NO
  // summary and NO description, so it is scored on path, tag and id alone, while the nested
  // attachment route has prose mentioning "supplier" three times. 173 of the 320 public operations are bare
  // in exactly this way — docs/discovery.md measures it and records that a derived-phrase haystack for
  // them was tried and rejected.
  //
  // Pinned as a FACT rather than asserted as correct behaviour: if ReAI ever documents
  // POST /api/suppliers, this test fails and the note above should be revisited rather than the floor
  // lowered.
  assert.equal(
    (findOperation("POST", "/api/suppliers").summary ?? "") + (findOperation("POST", "/api/suppliers").description ?? ""),
    "",
    "POST /api/suppliers now carries prose, so the cause of this miss has changed",
  );
  // `>= 0` as well as `<= 2`. rankOf returns -1 when the target is not in the ten-result window at
  // all, and -1 satisfies `<= 2` — so the first version of this line passed when the operation was
  // ENTIRELY ABSENT while claiming it stayed in the top three. Caught in review; it is the vacuous
  // assertion this repository keeps shipping, here in a test written to guard against exactly that.
  const supplierRank = rankOf("legg til en leverandor", "POST", "/api/suppliers");
  assert.ok(supplierRank >= 0 && supplierRank <= 2, `POST /api/suppliers is at rank ${supplierRank}`);
});
