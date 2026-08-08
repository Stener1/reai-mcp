import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOperations, getSpecIndex } from "../dist/reai/spec.js";

/**
 * Discovery measured against queries it was NOT tuned on.
 *
 * test/discovery-norwegian.test.mjs and test/ranking.test.mjs both hold sets I wrote and then
 * tuned the scorer against, which makes them regression tests rather than evidence that the
 * ranking generalises. This file is the held-out set: 41 queries built from Norwegian bookkeeping
 * vocabulary before looking at what the ranker did with any of them.
 *
 * The first measurement was 17 of 45 in the top 3, and a dozen queries returned NOTHING AT ALL —
 * which is the outcome that leaves an agent stuck rather than merely misdirected. Four of the
 * original 45 turned out to name endpoints that do not exist (/api/reports, /api/accruals,
 * /api/accounting-periods, and the /api/peppol paths are internal), so those were dropped rather
 * than "fixed": asserting a target the API does not have is a mistake this repo has made before.
 *
 * After adding the missing vocabulary and the Norwegian verbs: 36 of 41 in the top 3, 38 in the
 * top 10.
 *
 * And then a caveat that matters more than the number: this corpus is NOT held out any more. Review
 * pointed out that the same change which measured it also read its failures, added synonyms for its
 * vocabulary, and set these floors from the result — so it is a regression set, and quoting its
 * score as generalisation would be measuring fit to the cases I fixed. A second corpus at the bottom
 * of this file was written afterwards and measured once: 19 of 28, and 23 after fixing only the
 * queries that returned nothing at all. That is the honest figure for vocabulary nobody has thought
 * of yet.
 */

/** Every expected path is checked to EXIST before it is used as a target. */
const CASES = [
  ["inngående faktura", "/api/supplier-invoices"],
  ["utgående faktura", "/api/invoices"],
  ["betalingspåminnelse", "/api/invoices/{id}/reminders"],
  ["forfallsdato på faktura", "/api/invoices"],
  ["mva-melding", "/api/vat-returns"],
  ["skattemelding", "/api/tax-returns"],
  ["mva-koder", "/api/vat-codes"],
  ["bankavstemming", "/api/bank-reconciliations"],
  ["bankkontoer", "/api/company-banks"],
  ["banktransaksjoner", "/api/bank-reconciliations"],
  ["lønnsslipp", "/api/salary-payments"],
  ["a-melding", "/api/salary-payments/{id}/complete"],
  ["feriepenger", "/api/salary-payments/{id}/wage-specs"],
  ["reiseregning", "/api/expenses"],
  ["kjøregodtgjørelse", "/api/expenses"],
  ["diettgodtgjørelse", "/api/expenses"],
  ["utleggsrefusjon", "/api/expenses"],
  ["anleggsmidler", "/api/assets"],
  ["avskrivningssats", "/api/assets"],
  ["kunder", "/api/customers"],
  ["leverandører", "/api/suppliers"],
  ["kontaktpersoner", "/api/customers/{id}/contact-persons"],
  ["organisasjonsnummer oppslag", "/api/customers"],
  ["prosjekter", "/api/projects"],
  ["timeføring", "/api/timesheets"],
  ["ansatte", "/api/employees"],
  ["stillingsprosent", "/api/employees"],
  ["hovedbok", "/api/ledger"],
  ["resultatregnskap", "/api/ledger/general"],
  ["vedlegg", "/api/attachments"],
  ["dokumenter", "/api/documents"],
  ["ehf faktura mottak", "/api/invoice-reception-documents"],
  ["tilganger", "/api/users"],
  ["brukere og roller", "/api/users"],
  ["hvem har tilgang til regnskapet", "/api/users"],
  ["produkter", "/api/products"],
  ["ordre", "/api/orders"],
  ["tilbud til kunde", "/api/offers"],
  ["purregebyr", "/api/invoices/{id}/reminders"],
  ["kontoutskrift", "/api/ledger"],
  ["kreditnota", "/api/invoices"],
];

test("every target in this set is a path the API actually has", () => {
  // The guard that stops this file measuring the scorer against my imagination. Four of the
  // original queries named endpoints that do not exist, and "fixing" the ranker to reach them
  // would have been tuning it toward nothing.
  const paths = new Set(getSpecIndex().operations.map((o) => o.path));
  const missing = [...new Set(CASES.map(([, want]) => want))].filter(
    (want) => ![...paths].some((p) => p.startsWith(want)),
  );
  assert.deepEqual(missing, [], "these targets name no operation in the document");
});

const rankOf = (query, want) =>
  searchOperations({ query, limit: 10 })
    .map((h) => h.path)
    .findIndex((p) => p.startsWith(want));

test("no held-out query returns nothing at all", () => {
  // The floor, and the one that matters most: a query with no results is the difference between
  // an agent that reaches the ~250 uncovered operations and one that gives up. Twelve of these
  // returned nothing before the vocabulary was added.
  const empty = CASES.filter(([q]) => searchOperations({ query: q, limit: 5 }).length === 0).map(
    ([q]) => q,
  );
  assert.deepEqual(empty, [], "these queries found no endpoint at all");
});

test("at least 34 of the 41 held-out queries rank their endpoint in the top 3", () => {
  // A floor rather than an exact score, so the file does not have to be edited every time the
  // scorer changes for an unrelated reason — but high enough that losing several is a failure.
  // Measured at 37 when written; 17 before the vocabulary work.
  const hits = CASES.filter(([q, want]) => {
    const at = rankOf(q, want);
    return at >= 0 && at < 3;
  });
  assert.ok(
    hits.length >= 34,
    `only ${hits.length} of ${CASES.length} in the top 3:\n  ` +
      CASES.filter(([q, want]) => {
        const at = rankOf(q, want);
        return !(at >= 0 && at < 3);
      })
        .map(([q, want]) => `${q} → wanted ${want}`)
        .join("\n  "),
  );
});

test("and at least 39 rank it in the top 10", () => {
  const hits = CASES.filter(([q, want]) => rankOf(q, want) >= 0);
  assert.ok(hits.length >= 39, `only ${hits.length} of ${CASES.length} in the top 10`);
});

// The Norwegian verbs. WRITE_INTENT_VERBS already held four of them while METHOD_INTENT held
// none, which the comment above that table explicitly warns against: a word that licenses a write
// must also say which method, or the write gets the weak generic bonus and a GET on the same
// resource still wins. Measured before the fix: "opprett kreditnota" ranked the endpoint first and
// "lag kreditnota" did not find it at all — and `lag` is the commoner of the two verbs.
test("a Norwegian create verb ranks the write it asks for", () => {
  for (const [query, want] of [
    ["opprett kreditnota", "POST /api/invoices/{id}/credit"],
    ["opprett reiseregning", "POST /api/expenses"],
    ["registrer bilag", "POST /api/vouchers"],
    ["bokfør bilag", "POST /api/vouchers"],
    // Both spellings, because these tables are consulted with raw tokens rather than folded ones.
    ["bokfor bilag", "POST /api/vouchers"],
  ]) {
    const top = searchOperations({ query, limit: 3 }).map((h) => `${h.method} ${h.path}`);
    assert.ok(top.includes(want), `"${query}" → wanted ${want}, got ${top.join(", ")}`);
  }
});

// `lag` is deliberately NOT a create verb, although "lag en kreditnota" is the commonest phrasing:
// it is equally the everyday noun for a team, and as an unconditional token it turned "ansatte per
// lag" into a write request that ranked POST /api/employees first. A create verb this table does not
// know costs a worse ranking on one phrasing; a wrongly implied write costs a wrong answer on
// another, and the second is the one that matters.
test("the ambiguous `lag` is not treated as a create verb", () => {
  const asNoun = searchOperations({ query: "ansatte per lag", limit: 3 });
  assert.equal(asNoun[0].method, "GET", `"ansatte per lag" ranked ${asNoun[0].method} first`);
  // And the same for the other two the review named.
  for (const query of ["hvor lenge varer abonnementet", "hvilken konto bruker fakturaen"]) {
    const top = searchOperations({ query, limit: 3 });
    assert.equal(top[0].method, "GET", `"${query}" ranked ${top[0].method} ${top[0].path} first`);
  }
  // "hvor lenge varer abonnementet" is about a subscription, not about goods.
  assert.match(
    searchOperations({ query: "hvor lenge varer abonnementet", limit: 1 })[0].path,
    /subscriptions/,
  );
});

test("a Norwegian change or delete verb ranks the right method", () => {
  for (const [query, want] of [
    ["slett kunde", "DELETE /api/customers/{id}"],
    ["oppdater leverandør", "PATCH /api/suppliers/{id}"],
    ["endre kunde", "PATCH /api/customers/{id}"],
  ]) {
    const top = searchOperations({ query, limit: 3 }).map((h) => `${h.method} ${h.path}`);
    assert.ok(top.includes(want), `"${query}" → wanted ${want}, got ${top.join(", ")}`);
  }
});

test("a Norwegian question still ranks a READ, so the verbs did not buy writes everywhere", () => {
  // The regression the write-intent heuristic exists to avoid, in Norwegian. "betal" was left out
  // of the GET list deliberately for the same reason: a stemmer stripping -ing turns "hvilke
  // betalinger" into a create verb.
  for (const query of [
    "hvilke fakturaer er ubetalt",
    "hva skylder vi leverandører",
    "vis ansatte",
    "hvor mye lager har vi",
  ]) {
    const top = searchOperations({ query, limit: 3 });
    assert.ok(top.length > 0, `"${query}" found nothing`);
    assert.equal(top[0].method, "GET", `"${query}" ranked ${top[0].method} ${top[0].path} first`);
  }
});

// A bare noun must NOT surface a transmitting write, and this is the case that proves the
// method heuristic is doing something rather than just being generous.
test("a bare noun does not surface the write that would send a credit note", () => {
  const top = searchOperations({ query: "kreditnota", limit: 5 }).map((h) => `${h.method} ${h.path}`);
  assert.ok(
    !top.includes("POST /api/invoices/{id}/credit"),
    `a query with no stated intent should not rank a credit note that starts delivery: ${top.join(", ")}`,
  );
  // But it must still find the invoices, or the query is useless.
  assert.ok(top.some((c) => c.includes("/api/invoices")), top.join(", "));
});

// Pinned on its own rather than left to the top-3 floor, because losing this one is not
// interchangeable with losing any other: the a-melding and the tax return are two DIFFERENT
// filings to the same authority, and "a-melding" tokenises into "a" + "melding" where `melding`
// maps to return/returns — so before the phrase rule, the payroll filing query ranked the TAX
// RETURN first. An agent acting on that files the wrong thing with Skatteetaten.
test("a-melding finds the operation that FILES it, not the tax return", () => {
  // Asserted on the exact operation, not on any salary-payments path. The looser version passed
  // while POST .../complete sat fifth and the income-tax return still ranked above it — the very
  // confusion this case exists to catch, waved through by a test named after it.
  for (const query of ["a-melding", "a melding", "ameldingen"]) {
    const top = searchOperations({ query, limit: 3 }).map((h) => `${h.method} ${h.path}`);
    assert.equal(
      top[0],
      "POST /api/salary-payments/{id}/complete",
      `"${query}" → ${top.join(", ")}`,
    );
    assert.ok(
      !top.some((c) => c.includes("/api/tax-returns")),
      `the income-tax return must not appear at all for a payroll filing: ${top.join(", ")}`,
    );
  }
  // And the contrast, which is the reason it matters: these are three different filings.
  assert.match(searchOperations({ query: "mva-melding", limit: 1 })[0].path, /vat-returns/);
  assert.match(searchOperations({ query: "skattemelding", limit: 1 })[0].path, /tax-returns/);
});

// ---------------------------------------------------------------------------
// A SECOND corpus, and why there has to be one
// ---------------------------------------------------------------------------
//
// Review made a point I had missed about my own method: the set above stopped being held out the
// moment I read its failures, added synonyms for its vocabulary, and set the floors from the
// resulting score. It is a regression set now, and quoting its 36/41 as evidence of generalisation
// would be measuring fit to the cases I fixed.
//
// So this corpus was written afterwards, from different vocabulary and phrasings, and measured
// ONCE before anything was changed for it:
//
//   first measurement   19 of 28 in the top 3, 22 in the top 10
//   after fixing only the queries that returned NOTHING AT ALL   23 of 28, 26 in the top 10
//
// Two of the original thirty targets were mine being wrong again — every /kassasystem/ path is
// internal, and there is no GET /api/vouchers/{id}/attachments, only a DELETE — which is the third
// time in this work that a "ranking failure" turned out to be a target the API does not have.
//
// The gap between 23/28 here and 36/41 above is the honest cost of a synonym table: it covers the
// words someone has thought of. Fixing the empty results was still right — a query with no results
// strands an agent — but this file should not be tuned further against, or it stops measuring
// anything.
const FRESH = [
  ["ubetalte kundefakturaer", "/api/ledger/customer"],
  ["leverandørgjeld", "/api/ledger/supplier"],
  ["kundefordringer", "/api/ledger/customer"],
  ["avstem bankkonto", "/api/bank-reconciliations"],
  ["opprett ny kunde", "/api/customers"],
  ["endre adresse på kunde", "/api/customers/{id}/address"],
  ["hvem er kontaktperson hos kunden", "/api/customers/{id}/contact-persons"],
  ["registrer timer på prosjekt", "/api/timesheets"],
  ["godkjenn utlegg", "/api/expenses/{id}/approve"],
  ["lever reiseregning til godkjenning", "/api/expenses/{id}/deliver"],
  ["hvor mange ansatte har vi", "/api/employees"],
  ["send purring", "/api/invoices/{id}/reminders"],
  ["hvilke abonnement fornyes snart", "/api/subscriptions"],
  ["hvem har eierrolle", "/api/users"],
  ["inviter regnskapsfører", "/api/users"],
  ["innkommende ehf", "/api/invoice-reception-documents"],
  ["saldo på lån", "/api/loans"],
  ["opprett anleggsmiddel", "/api/assets"],
  ["avskriv anleggsmiddel", "/api/assets/{id}/depreciation"],
  ["slett bilag", "/api/vouchers/{id}"],
  ["hvilke varer er på lager", "/api/warehouses/inventory"],
  ["opprett ordre", "/api/orders"],
  ["send faktura til kunde", "/api/invoices"],
  ["mva-oppgjør", "/api/vat-returns"],
  ["lønnskostnader", "/api/salary-payments"],
  ["feriepengegrunnlag", "/api/salary-payments"],
  ["ansettelsesavtale", "/api/agreements/employee-contract"],
  ["leiekontrakt", "/api/agreements/rent-agreement"],
];

test("every target in the second corpus exists too", () => {
  const paths = new Set(getSpecIndex().operations.map((o) => o.path));
  const missing = [...new Set(FRESH.map(([, want]) => want))].filter(
    (want) => ![...paths].some((p) => p.startsWith(want)),
  );
  assert.deepEqual(missing, [], "these targets name no operation in the document");
});

test("no query in the second corpus returns nothing at all", () => {
  const empty = FRESH.filter(([q]) => searchOperations({ query: q, limit: 5 }).length === 0).map(
    ([q]) => q,
  );
  assert.deepEqual(empty, [], "these queries found no endpoint at all");
});

test("the second corpus holds its measured score of 23 in the top 3", () => {
  // A floor at the measured value, not below it: this set is not to be tuned against, so the only
  // legitimate movement is upward from work that generalises.
  const hits = FRESH.filter(([q, want]) => {
    const at = searchOperations({ query: q, limit: 10 })
      .map((h) => h.path)
      .findIndex((p) => p.startsWith(want));
    return at >= 0 && at < 3;
  });
  assert.ok(
    hits.length >= 23,
    `${hits.length} of ${FRESH.length} in the top 3; the measured baseline is 23`,
  );
});
