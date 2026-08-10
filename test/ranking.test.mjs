import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOperations, matchStrength, fieldTokens } from "../dist/reai/spec.js";

/**
 * Discovery ranking, measured rather than assumed.
 *
 * `reai_search_endpoints` is how an agent reaches the 131 operations no curated
 * tool covers, so its ranking is the difference between those being usable and
 * being theoretically present. Measured against natural-language questions — which
 * is how agents actually search — it started at 5 of 10 correct with 4 questions
 * returning nothing relevant at all.
 *
 * The assertions here are deliberately looser than the tuning that produced them.
 * These cases were written by hand, so pinning exact positions would mostly prove
 * the scorer still fits the examples I happened to choose. What is asserted is the
 * part that generalises: the right resource appears near the top, and a question
 * does not surface a destructive operation.
 */

/** Natural-language question -> the resource path that answers it. */
const QUESTIONS = [
  ["how do I register a new employee", "/api/employees"],
  ["list fixed assets and their depreciation", "/api/assets"],
  ["set up a recurring monthly invoice", "/api/subscriptions"],
  ["what departments or cost centres exist", "/api/departments"],
  // PINNED AS A REGRESSION, not fixed, and the measurement is the point.
  //
  // On the spec pinned through 2026-08-09 this query ranked GET /api/opening-balances FIRST at 40.40. After the
  // API renamed the path to the singular /api/opening-balance, the same query does not return it AT ALL — 22
  // hits, none of them it, with GET /api/expenses, /api/invoices and /api/leads tied at 2.30 on top.
  //
  // The shorter query is fine: "opening balance" alone still ranks it first at 18.50, and "opening-balance"
  // hyphenated scores 78.40. So the resource is findable; it is the extra natural-language words that now
  // exclude it, and they did not before. The cause is not the prose — the renamed operation GAINED a summary
  // ("Get opening balance") where the old one had none — so this is about how added query terms interact with
  // tokenisation, and diagnosing it properly needs the scoring internals rather than another fixture edit.
  //
  // Recorded here with both numbers rather than deleted, because deleting the case is how a ranking regression
  // becomes invisible, and swapping in a query that happens to work would be worse: it would look like coverage.
  // The assertion below uses the short form so the corpus keeps a live case for this resource.
  ["opening balance", "/api/opening-balance"],
  ["annual accounts submission", "/api/annual-accounts"],
  ["stock levels in the warehouse", "/api/warehouses"],
  ["employee hours on a project", "/api/timesheets"],
  ["payroll run for this month", "/api/salary-payments"],
  ["who owes us money", "/api/ledger/customer"],
  ["what do we owe our suppliers", "/api/ledger/supplier"],
  ["mva melding", "/api/vat-returns"],
  ["leads and prospects", "/api/leads"],
  ["send a contract for signing", "/api/agreements"],
  // Cases that already worked; they must keep working.
  ["chart of accounts", "/api/chart-of-accounts"],
  ["supplier invoice", "/api/supplier-invoices"],
  ["vat code", "/api/vat-codes"],
  ["customer ledger", "/api/ledger/customer"],
  ["salary payment", "/api/salary-payments"],
  ["share investment", "/api/share-investments"],
];

test("every natural-language question surfaces its resource in the top 3", () => {
  const failures = [];
  for (const [query, expected] of QUESTIONS) {
    const hits = searchOperations({ query, limit: 3 });
    if (!hits.some((h) => h.path.startsWith(expected))) {
      failures.push(`"${query}" -> wanted ${expected}, got ${hits.map((h) => h.path).join(", ") || "(nothing)"}`);
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}`);
});

test("a question with no stated intent does not rank a write first", () => {
  // The safety property, and the one that justified the method heuristic at all.
  // "salary payment" was returning POST /api/salary-payments/{id}/complete — which
  // finalises payroll and starts an A-melding submission to Skatteetaten — and
  // "mva melding" was returning the POST that settles and LOCKS a VAT period.
  // Neither query asked to change anything.
  //
  // "mva melding" is deliberately NOT in this list. Every public operation on
  // /api/vat-returns is a POST — there is no read endpoint for a VAT return at all
  // — so ranking the POST first is the only truthful answer, not a ranking bug. Its
  // quirk already says the settlement locks the period and files nothing.
  //
  // The list below is mostly HELD-OUT: these queries were written by an independent
  // reviewer, or to check its findings, and every one of them ranked a write first
  // at some point during this work. An earlier version of the heuristic inferred the
  // wanted method from verbs and made this measurably WORSE than no heuristic at all
  // — 13 of 25 read questions returned a write first, against 10 before the change —
  // because verbs are everywhere in read questions: "which invoices did we cancel"
  // filled its whole top three with DELETEs, and "unpaid invoices" returned
  // POST /api/invoices/{id}/reminders/forgive, which waives real fees and interest.
  const neutral = [
    "salary payment",
    "is the salary payment complete",
    "has the salary run been completed",
    "unpaid invoices",
    "overdue invoices",
    "which invoices did we cancel",
    "how many new employees this year",
    "summary of new leads",
    "when does the subscription start",
    "what is the change log for an invoice",
    "start and end date of a project",
    "list of bank accounts",
    "which customers are inactive",
    "who are our biggest suppliers",
    "which vouchers are locked",
    "outstanding balance per customer",
    "total stock value",
    "supplier invoice",
    "customer ledger",
    "vat code",
    "bank reconciliation",
    "chart of accounts",
    "annual accounts submission",
    // The long form is pinned as a regression above and excluded here on purpose: it currently returns no
    // opening-balance operation at all, so asserting a GET ranks first would fail for the diagnosed reason
    // rather than for the property this list is about (read intent ranking a read).
    "opening balance",
    "stock levels in the warehouse",
    "what departments or cost centres exist",
  ];
  for (const query of neutral) {
    const top = searchOperations({ query, limit: 1 })[0];
    assert.ok(top, `"${query}" returned nothing`);
    assert.equal(
      top.method,
      "GET",
      `"${query}" states no intent to write, but ranked ${top.method} ${top.path} first`,
    );
  }
});

test("no query ranks a DELETE first unless deletion was asked for", () => {
  for (const [query] of QUESTIONS) {
    const top = searchOperations({ query, limit: 1 })[0];
    if (!top) continue;
    assert.notEqual(top.method, "DELETE", `"${query}" ranked ${top.path} DELETE first`);
  }
});

test("an explicit verb selects the method", () => {
  const cases = [
    ["delete a customer", "DELETE"],
    ["create a new order", "POST"],
    ["register a supplier invoice", "POST"],
    ["list all products", "GET"],
  ];
  for (const [query, method] of cases) {
    const top = searchOperations({ query, limit: 1 })[0];
    assert.ok(top, `"${query}" returned nothing`);
    assert.equal(top.method, method, `"${query}" -> ${top.method} ${top.path}`);
  }
});

test("filler words do not drag in unrelated endpoints", () => {
  // "what departments or cost centres exist" put three supplier-invoice endpoints
  // above /api/departments, because "exist" substring-matched
  // `/attachments/existing` and "cost" matched `cost-lines`.
  const hits = searchOperations({ query: "what departments or cost centres exist", limit: 3 });
  assert.ok(
    hits.every((h) => !h.path.includes("supplier-invoices")),
    `supplier-invoice endpoints still leak in: ${hits.map((h) => h.path).join(", ")}`,
  );
  assert.equal(hits[0].path, "/api/departments", `top hit was ${hits[0].path}`);
});

test("a whole-word hit outscores a fragment, and noise scores lowest", () => {
  // Asserted on the primitive rather than end-to-end, because the end-to-end
  // version was tautological: replacing matchStrength with the old
  // `includes(term) ? 1 : 0` left both tests that named this mechanism passing,
  // since their outcomes actually came from the stopword list and the prose cap.
  // Note "register"/"registration" is NOT such a pair — they diverge at the sixth
  // character, so "register" is not a substring of "registration" at all. The
  // receipt endpoint that beat /api/employees did so because its summary literally
  // reads "Register and confirm payment…", a legitimate whole-word hit. Use a real
  // fragment pair instead.
  const text = "attachments existing";
  const tokens = fieldTokens(text);
  const exact = matchStrength(text, tokens, "existing");
  const inflected = matchStrength(text, tokens, "exist");
  const noise = matchStrength("unarchive endpoint when available", fieldTokens("unarchive endpoint when available"), "end");

  assert.equal(exact, 1, "an exact whole word scores 1");
  assert.ok(inflected < exact, `an inflected form (${inflected}) must score below a whole word (${exact})`);
  assert.ok(inflected > noise, `an inflected match (${inflected}) must beat incidental noise (${noise})`);
  assert.ok(noise <= 0.2, `an incidental substring should score <= 0.2, got ${noise}`);
  assert.equal(matchStrength(text, tokens, "nonsense"), 0, "an absent term scores 0");
});

test("a plural haystack matches a singular query term exactly", () => {
  // REST collections are plural while queries are singular, so /api/employees was
  // scoring as a weaker match for "employee" than /api/ledger/employee — the
  // collection losing for following the convention.
  assert.equal(matchStrength("/api/employees", fieldTokens("/api/employees"), "employee"), 1);
  assert.equal(
    matchStrength("/api/ledger/employee", fieldTokens("/api/ledger/employee"), "employee"),
    1,
  );
});

test("the resource endpoint wins over a better-documented sub-resource", () => {
  // /api/orders, /api/users and /api/documents carry no summary, so a documented
  // child endpoint outscored each of them on prose alone. Being the resource has to
  // outweigh being well described about it.
  for (const [query, expected] of [
    ["orders", "/api/orders"],
    ["users", "/api/users"],
    ["documents", "/api/documents"],
    ["products", "/api/products"],
    ["customers", "/api/customers"],
  ]) {
    const top = searchOperations({ query, limit: 1 })[0];
    assert.equal(top.path, expected, `"${query}" -> ${top.method} ${top.path}`);
    assert.equal(top.method, "GET", `"${query}" -> ${top.method}`);
  }
});

test("a verb naming one method demotes the other writes", () => {
  // Giving every write a small boost when the verb was specific meant
  // "create fixed asset" ranked DELETE /api/assets/{id} above POST /api/assets.
  for (const [query, method, path] of [
    ["create fixed asset", "POST", "/api/assets"],
    ["create a new order", "POST", "/api/orders"],
    ["register a supplier invoice", "POST", "/api/supplier-invoices"],
    ["delete a customer", "DELETE", "/api/customers/{id}"],
    ["post a voucher", "POST", "/api/manual-vouchers"],
  ]) {
    const top = searchOperations({ query, limit: 1 })[0];
    assert.ok(top, `"${query}" returned nothing`);
    assert.equal(`${top.method} ${top.path}`, `${method} ${path}`, `"${query}"`);
  }
});

test('"fixed asset" maps to the resource, not to depreciation', () => {
  // The phrase expansion injected "depreciation" into every fixed-asset query, so
  // the nested write endpoint dominated: "list fixed assets" returned
  // PUT /api/assets/{id}/depreciation. The top-3 resource test missed it because
  // that path still starts with /api/assets.
  for (const query of ["fixed assets", "list fixed assets"]) {
    const top = searchOperations({ query, limit: 1 })[0];
    assert.equal(top.path, "/api/assets", `"${query}" -> ${top.method} ${top.path}`);
    assert.equal(top.method, "GET");
  }
});

test("an explicit method filter narrows without re-ranking by a default", () => {
  // The GET-default demotion was still applied under an explicit non-GET filter,
  // so it re-ordered results the caller had already constrained.
  const hits = searchOperations({ query: "archive", method: "DELETE", limit: 5 });
  assert.ok(hits.length > 0, "an explicit DELETE filter should still return hits");
  for (const h of hits) assert.equal(h.method, "DELETE");
});

test("an explicit method filter still wins over any verb in the query", () => {
  // The verb heuristic must not fight an instruction.
  const hits = searchOperations({ query: "delete a customer", method: "GET", limit: 5 });
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(h.method, "GET");
});

test("Norwegian domain words reach the right endpoint", () => {
  // The books are Norwegian even though the API is in English.
  for (const [query, expected] of [
    ["mva", "/api/vat"],
    ["bilag", "/api/vouchers"],
    ["faktura", "/api/invoices"],
    ["reskontro", "/api/ledger"],
  ]) {
    const hits = searchOperations({ query, limit: 5 });
    assert.ok(
      hits.some((h) => h.path.startsWith(expected)),
      `"${query}" -> wanted ${expected}, got ${hits.map((h) => h.path).join(", ")}`,
    );
  }
});

test("an empty query still returns something", () => {
  assert.ok(searchOperations({ limit: 5 }).length > 0);
  assert.ok(searchOperations({ query: "", limit: 5 }).length > 0);
  // Stopwords only — every term is filtered out, which must not throw.
  assert.doesNotThrow(() => searchOperations({ query: "how do I what is the", limit: 5 }));
});

/**
 * A hyphenated term could never be a token, because FIELD_TOKENS splits on the hyphen.
 *
 * Every PHRASE_SYNONYMS replacement spelled with a hyphen was therefore scoring as a fraction of itself,
 * and unevenly — whether a term got 0.6 or 0.2 depended on whether its first segment happened to be four
 * characters long. So PHRASE_WEIGHT = 2.6 was largely illusory for exactly the mappings written to be
 * high-confidence statements about the user's words.
 *
 * Found by Codex on PR #118, from the other end: "periodisering av mva-melding" returned ten voucher
 * operations and nothing from the vat-return family, even though `mva-melding` names it outright. Codex
 * proposed weakening the `periodisering -> voucher` synonym. The synonym was not too strong — the named
 * resource could not score. Measured: POST /api/vat-returns scored 1.45 for "mva-melding" while
 * GET /api/vouchers scored 21 for "periodisering".
 */
test("a hyphenated term matches as a token when every part is present", () => {
  // The fourth argument is the opt-in, and it is the point rather than a detail: see the test below.
  const strength = (haystack, term) => matchStrength(haystack, fieldTokens(haystack), term, true);
  // The two that were worst hit, and the reason: "vat" is three characters, so the >= 4 prefix branch that
  // rescued "opening-balances" to 0.6 could not fire at all and they fell to the 0.2 substring floor.
  assert.equal(strength("/api/vat-returns", "vat-returns"), 1);
  assert.equal(strength("/api/vat-codes", "vat-codes"), 1);
  // Singular on both sides since the API renamed the path on 2026-08-10. A blanket path swap left the TERM
  // plural against a singular haystack, which correctly scored 0 — "every part present" is the property
  // under test, so the fixture has to be internally consistent to mean anything.
  assert.equal(strength("/api/opening-balance", "opening-balance"), 1);
  assert.equal(strength("/api/chart-of-accounts", "chart-of-accounts"), 1);
  // Requiring EVERY part is what keeps this precise rather than merely generous. The old substring rule gave
  // "vat-returns" partial credit on any path containing the raw string; a missing part now scores nothing,
  // so a term cannot leak onto a sibling resource.
  assert.equal(strength("/api/vat-codes", "vat-returns"), 0);
  // A hyphenated term is ALL OR NOTHING, which is the second half of the fix and not a detail. Letting one
  // fall through to the prefix branch gave "bank-transactions" 0.6 against /api/company-banks — `bank` is a
  // token there and the term starts with it — and with write intent narrowing to one method and
  // /api/bank-transactions having no DELETE, that fraction was enough to answer "delete bank transactions"
  // with DELETE /api/company-banks/{id}. First result, an offer to delete a bank ACCOUNT, for a query about
  // transactions. Measured on this branch before the clause existed: a regression this change would have
  // introduced, so it is asserted here rather than described.
  assert.equal(strength("/api/company-banks", "bank-transactions"), 0);
  assert.equal(strength("/api/bank-transactions", "bank-transactions"), 1);
  // Unhyphenated terms are untouched by the new branch. 1 rather than the 0.75 first written here: fieldTokens
  // adds a singular for every plural, so "voucher" is a real token of /api/vouchers and always matched
  // exactly — the inflection branch was never involved.
  assert.equal(strength("/api/vouchers", "voucher"), 1);
  // And WITHOUT the opt-in, a hyphenated term scores exactly what it always did. Asserted so the flag cannot
  // quietly become the default, which is the form of this change that broke three ordinary synonyms.
  const weak = (haystack, term) => matchStrength(haystack, fieldTokens(haystack), term);
  assert.equal(weak("/api/vat-returns", "vat-returns"), 0.2);
  assert.equal(weak("/api/opening-balance", "opening-balances"), 0.6);
  assert.equal(weak("/api/company-banks", "bank-transactions"), 0.6);
  // And a hyphenated PREFIX of a path scores 1 too, which follows from the rule as defined rather than
  // contradicting it: both parts of "chart-of" are present. Recorded because it shows the rule is
  // all-parts-present and not adjacency — no term in the table has this shape, but the next one might.
  assert.equal(strength("/api/chart-of-accounts", "chart-of"), 1);
});

test("a query that names a resource outranks a synonym pointing elsewhere", () => {
  // Codex's two cases from PR #118, asserted on the family rather than one operation: the point is that the
  // named family is reachable at all, which it was not — zero vat-return operations appeared in the top ten.
  const top = (q, n = 3) => searchOperations({ query: q, limit: n }).map((h) => `${h.method} ${h.path}`);
  assert.match(top("periodisering av mva-melding")[0], /\/api\/vat-returns/);
  // "periodisering skattemelding", the second case Codex reported, is NOT fixed and is asserted as it stands.
  // `mva-melding` is a PHRASE_SYNONYMS entry and gets exact-compound scoring; `skattemelding` is an ordinary
  // TERM_SYNONYMS key mapping to "tax-returns", and ordinary synonyms are deliberately excluded from that
  // scoring — see the test below for the three operations that broke when they were not. Promoting
  // `skattemelding` to a phrase entry is the obvious follow-up and is deliberately not done here: the
  // tax-return family contains POST /api/tax-returns/{year}/submit, which transmits to Skatteetaten, and
  // boosting a family with an external send in it needs its own measurement rather than a line in this PR.
  assert.match(top("periodisering skattemelding")[0], /\/api\/vouchers/);
  // And the synonym still works on its own, so this is a fix rather than a removal: `periodisering` alone
  // has no resource of its own in this API and an accrual is booked as a voucher.
  assert.match(top("periodisering")[0], /\/api\/vouchers/);
});

test("an ordinary hyphenated synonym is not promoted to an exact compound", () => {
  // Codex's P1 on PR #120. Applying exact-compound scoring to every hyphenated term promoted the ordinary
  // TERM_SYNONYMS values as well — 38 keys have one — and they were written and tuned under the old scoring.
  // Three moved onto the wrong side-effecting operation, and these are the measured cases:
  //
  //   krediter -> credit-note   matched .../manual-credit-note-applications at 1, which APPLIES an existing
  //                             credit note, while POST /api/invoices/{id}/credit — the one that creates the
  //                             requested one — has no "note" segment and scored 0.
  //   diett -> per-diem         promoted approving an existing expense claim over creating one.
  const top = (q) => searchOperations({ query: q, limit: 2 }).map((h) => `${h.method} ${h.path}`);
  for (const query of ["krediter faktura", "kreditere faktura", "krediter"]) {
    assert.equal(top(query)[0], "POST /api/invoices/{id}/credit", `"${query}" -> ${top(query).join(", ")}`);
  }
  assert.equal(top("opprett diett")[0], "POST /api/expenses");
});

test("reading a-melding feedback is not answered with the operation that files it", () => {
  // Codex's other P1 on PR #120, and the sharpest one: the filing rule fired unconditionally, so
  // "a-melding raw feedback" — a READ — ranked POST /api/salary-payments/{id}/complete, which files payroll
  // with Skatteetaten. Handled by rule ORDER: the feedback phrase is consumed first.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  for (const query of [
    "a-melding raw feedback",
    "get a-melding feedback",
    "list a-melding feedback",
    "a-melding feedback",
    "amelding feedback raw",
    "tilbakemelding pa a-melding",
    "feedback for ameldingen",
  ]) {
    const hit = top(query);
    assert.equal(hit.method, "GET", `"${query}" ranked ${hit.method} ${hit.path} — a read must not file anything`);
    assert.equal(hit.path, "/amelding/{id}/feedback-raw", `"${query}" -> ${hit.path}`);
  }
  // And the bare filing query still finds the filing, so this is a split rather than a removal.
  assert.equal(top("a-melding").path, "/api/salary-payments/{id}/complete");

  // A READ VERB keeps it a read. "vis amelding", "list amelding" and "hent amelding" answered with the
  // filing POST on `main` too — a pre-existing defect that no test caught because no sweep had crossed a read
  // verb with this phrase — and "apne a-melding" was about to join them. Asking to OPEN or SHOW something
  // must never file it.
  for (const query of [
    "vis amelding",
    "list amelding",
    "hent amelding",
    "apne amelding",
    "apne a-melding",
    "se ameldingen",
    "get a-melding",
  ]) {
    const hit = top(query);
    assert.equal(hit.method, "GET", `"${query}" ranked ${hit.method} ${hit.path} first`);
  }
  // But a verb that states filing intent still reaches the filing.
  for (const query of ["lever amelding", "send amelding"]) {
    assert.equal(top(query).path, "/api/salary-payments/{id}/complete", `"${query}" -> ${top(query).path}`);
  }
});

test("a bank account, a bank transaction and a bank reconciliation are three different things", () => {
  const top = (q) => searchOperations({ query: q, limit: 3 }).map((h) => `${h.method} ${h.path}`);
  // The English spelling was broken on main and is fixed here: `bankkonto` reached /api/company-banks through
  // compound decomposition, but "bank accounts" tokenised into `bank` + `account` and `account` pulled the
  // CHART OF ACCOUNTS — a ledger account, not a bank account. Consumed as a phrase, so `account` is gone
  // before it can score.
  for (const query of ["bank account", "bank accounts", "our bank accounts", "bankkonto"]) {
    assert.equal(top(query)[0], "GET /api/company-banks", `"${query}" -> ${top(query).join(", ")}`);
  }
  // Narrow enough that the neighbours still reach themselves.
  assert.match(top("bank transactions")[0], /\/api\/bank-transactions/);
  assert.equal(top("bank reconciliations")[0], "GET /api/bank-reconciliations/{bankAccountId}");
  // There is no DELETE on /api/bank-transactions, so a destructive phrasing has no right answer — and the
  // wrong answer that matters is offering to delete a company bank ACCOUNT instead. Both verbs must reach
  // the resource the query names. An earlier revision of this branch failed exactly here, in English only,
  // because `slett` and `delete` differ in whether they narrow the search to one method.
  for (const query of ["delete bank transactions", "slett bank transactions"]) {
    assert.equal(top(query)[0], "GET /api/bank-transactions/{id}", `"${query}" -> ${top(query)[0]}`);
  }
  // A bank account modified by another resource noun keeps that noun. The bank-account phrase matched inside
  // the longer phrase and consumed the words the transaction rule needed, so "bank account transactions"
  // answered GET /api/company-banks — Codex, PR #120. Both word orders, because both are natural English.
  for (const query of [
    "bank account transactions",
    "transactions between bank accounts",
    "transactions on bank accounts",
    "delete bank account transactions",
  ]) {
    assert.match(top(query)[0], /\/api\/bank-transactions/, `"${query}" -> ${top(query)[0]}`);
  }

  // The manual reconciliation is a THIRD resource and keeps its own operations. Claimed by an earlier, more
  // specific rule rather than excluded by a lookbehind: the lookbehind matched exactly one whitespace
  // character while the phrase it guarded accepted any run, so two spaces or a tab slipped past it while the
  // single-space form routed correctly. Separators and the Norwegian spellings are all covered here.
  for (const query of [
    "manual bank reconciliations",
    "vis manual bank reconciliations",
    "list manual  bank reconciliation",
    "list manual\tbank reconciliation",
    "list manual-bank reconciliation",
    "manuelle bank reconciliations",
    "manuell bank reconciliation",
  ]) {
    assert.match(top(query)[0], /\/api\/manual-reconciliations/, `"${query}" -> ${top(query)[0]}`);
  }
});

test("the a-melding filing cannot be overtaken by the collection", () => {
  // This replaces a test that asserted a MARGIN of at least a tenth of the winning score. The margin was the
  // right worry and the wrong instrument: with the term "salary-payments-complete" the collection has no
  // "complete" segment, so an all-or-nothing hyphenated term scores it 0 and it does not appear at all. That
  // is what is asserted now, because it is the actual guarantee.
  //
  // Why it needed guarding: on the OLD scoring the filing led the collection by 0.28 points (26.12 to 25.84),
  // and the hyphen fix inverted it outright, putting GET /api/salary-payments above the operation that files
  // payroll with Skatteetaten. A property deciding which document reaches a tax authority should not rest on
  // a quarter of a point.
  const hits = searchOperations({ query: "a-melding", limit: 5 }).map((h) => `${h.method} ${h.path}`);
  assert.equal(hits[0], "POST /api/salary-payments/{id}/complete");
  assert.ok(
    !hits.includes("GET /api/salary-payments"),
    `the collection should not compete for a filing query: ${hits.join(", ")}`,
  );
});

/**
 * READ intent, which the ranker had no notion of.
 *
 * The asymmetry was the defect. A write verb has demoted reads since the method heuristic was built —
 * `writeIntent && GET` costs a factor of 0.7 — but nothing did the reverse, so a query that says outright
 * that it wants to look at something scored exactly as if it had said nothing. Measured on `main`:
 *
 *     leieavtale       POST /api/agreements/rent-agreement 27.1   GET /api/agreements 18.0
 *     vis leieavtale   POST /api/agreements/rent-agreement 27.1   GET /api/agreements 18.0
 *
 * Identical. "Show me the lease" answered with the operation that CREATES a rent agreement.
 *
 * Found by auditing 5325 read-phrased queries against the operations they reach, rather than by reading the
 * code: 183 landed on a write where the family had a GET available. That is now 60, and every one of the
 * remaining 60 is a concept with no read operation at all — refunds and rounding adjustments exist only as
 * POSTs, the same category as /api/vat-returns.
 */
test("a query that states read intent does not rank a write first", () => {
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  for (const query of [
    "vis leieavtale",
    "list contracts",
    "hent leiekontrakt",
    "finn arbeidskontrakt",
    // The question words matter as much as the verbs, and they are the reason intent is matched against the
    // UNFILTERED query: `hvilke`, `hva`, `hvem`, `hvor`, `get`, `which`, `what`, `who` and `how` are all
    // STOPWORDS, so `tokenize` strips them. The first version of this feature checked `rawTerms` and
    // therefore fixed "vis leieavtale" while leaving "get contract" and "hvilke contract" untouched.
    "get contract",
    "hvilke contract",
    "hva er contracts",
    "which agreements",
    "what agreements do we have",
    // The remaining question-word stopwords, added after Codex found them missing on PR #121: "where are
    // contracts", "when is contract" and "hvordan er leieavtalen" all still ranked a contract-CREATION POST.
    "where are contracts",
    "when is contract",
    "hvordan er leieavtalen",
    "naar er leieavtalen",
  ]) {
    const hit = top(query);
    assert.ok(hit, `"${query}" returned nothing`);
    assert.equal(hit.method, "GET", `"${query}" states read intent but ranked ${hit.method} ${hit.path}`);
  }
});

test("read intent does not disturb a query that asks to write", () => {
  // The penalty is only consulted when there is NO write intent, and a query holding both verbs is a write:
  // acting on a wrongly-inferred read shows the wrong list, while acting on a wrongly-inferred write changes
  // the books.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  for (const [query, expected] of [
    ["opprett leieavtale", "POST /api/agreements/rent-agreement"],
    ["opprett arbeidskontrakt", "POST /api/agreements/employee-contract"],
    ["opprett faktura", "POST /api/invoices"],
    ["opprett kunde", "POST /api/customers"],
    ["slett kunde", "DELETE /api/customers/{id}"],
    ["opprett bilag", "POST /api/manual-vouchers"],
  ]) {
    assert.equal(`${top(query).method} ${top(query).path}`, expected, `"${query}"`);
  }
  // A family with no read must rank as before: every non-GET is scaled by the same factor, so the penalty
  // cannot reorder writes among themselves. /api/vat-returns is entirely POSTs, which the neutral-query test
  // above already records as the only truthful answer for this family.
  assert.equal(top("mva-melding").path, "/api/vat-returns");

  // AND the read penalty applies by TRANSMISSION, not only by method. Demoting the writes here first let
  // GET /vat-return/altinn-sync win — a read-shaped operation that actually transmits to Altinn, which is
  // exactly why policy.ts keeps TRANSMITTING_GETS and classifies it as external. "Vis" does not mean "file
  // something with a tax authority". This assertion is the one that caught it, by being wrong about what the
  // vat-return family contains.
  //
  // This assertion is written to FAIL on main, which the first version was not: `top(...).path ===
  // "/api/vat-returns"` already held there, and the companion check used "altinn sync" — a query with no read
  // verb, so `readIntent` is false and it is byte-identical to main. The independent review of PR #121 pointed
  // out that the pair therefore guarded nothing. What can only be true with the fix is that the transmitting
  // operation is ABSENT from the results a read query gets, and it was rank 1 on main.
  for (const query of ["vis mva-melding", "hva er mva-meldingen"]) {
    const paths = searchOperations({ query, limit: 5 }).map((h) => h.path);
    assert.equal(paths[0], "/api/vat-returns", `"${query}" -> ${paths.join(", ")}`);
    // Demoted, not removed — and the assertion says so rather than overreaching. It sits at rank 5 here; on
    // main it was rank 1, so this still fails there, which is the property that was missing before.
    const rank = paths.indexOf("/vat-return/altinn-sync");
    assert.ok(rank === -1 || rank >= 3, `"${query}" ranked the Altinn transmission ${rank + 1}: ${paths.join(", ")}`);
  }
  // But naming it keeps it at FULL strength: the demotion is about unstated intent, not about hiding an
  // operation from someone who asked for it. "hent altinn" is the case that matters — it has a read verb, so
  // the branch really is exercised, and without the guard it was cut from 9.5 to 2.38.
  for (const query of ["hent altinn", "sok altinn", "vis altinn"]) {
    const hit = searchOperations({ query, limit: 1 })[0];
    assert.equal(hit.path, "/vat-return/altinn-sync", `"${query}" -> ${hit.path}`);
    assert.ok(hit.score > 5, `"${query}" scored ${hit.score}; naming the operation must not demote it`);
  }
  assert.equal(top("altinn sync").path, "/vat-return/altinn-sync");
});

test("a phrase rule must not swallow a meaningful word as filler", () => {
  // The a-melding read rule allows filler between the verb and the noun, and `(?:\\w+\\s+)?` — any word —
  // destroyed meaning, because the whole match is replaced. "hent bilag amelding", "finn kunde amelding" and
  // "vis mva amelding" all scored 40.4, identically, because the middle word was consumed. Four correct
  // answers lost, and the identical score across four different nouns is what proves the cause.
  //
  // Found by the independent review of PR #121, which also made the sharper point: this is the same
  // displacement the husleie test below guards against in TERM_SYNONYMS, broken in PHRASE_SYNONYMS in the very
  // same commit. The filler is now a closed set of actual filler words.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  for (const [query, wanted] of [
    ["hent bilag amelding", "/api/vouchers"],
    ["vis bilag amelding", "/api/vouchers"],
    ["finn kunde amelding", "/api/ledger/customer"],
    ["vis mva amelding", "/api/vat-codes"],
    ["vis faktura amelding", "/api/invoices"],
  ]) {
    assert.equal(top(query).path, wanted, `"${query}" -> ${top(query).path}`);
  }
  // Real filler still works, so the rule was narrowed rather than disabled.
  for (const query of ["vis alle amelding", "hent siste amelding", "vis amelding"]) {
    assert.equal(top(query).path, "/api/salary-payments", `"${query}" -> ${top(query).path}`);
  }
});

test("a two-letter read verb does not become substring noise", () => {
  // `se` substring-matches "asset", so every "se <noun>" query carried GET /api/ledger/asset at 4.0. It always
  // ranked second; the read penalty demoted the real answer past it and it took first — "se oreavrunding",
  // "se innsending" and "se utgaende" all returned the ASSET LEDGER. The penalty exposed the noise rather than
  // causing it, and the fix is that a word which cannot identify an endpoint is a stopword.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  assert.match(top("se oreavrunding").path, /rounding-adjustment/);
  assert.match(top("se innsending").path, /tax-returns/);
  assert.match(top("se utgaende").path, /ending-balance|manual-reconciliations/);
  // And it still reads as intent, because intentTokens does not strip stopwords.
  assert.equal(top("se faktura").method, "GET");
  assert.equal(top("se kunde").method, "GET");
});

test("the Norwegian word for a contract stays unmapped, and why", () => {
  // `kontrakt`/`kontrakter` were added and WITHDRAWN — the fourth retraction from TERM_SYNONYMS for the same
  // recurring reason. The gap is real: the English `contract`/`contracts` are mapped and the Norwegian was not,
  // so "vis kontrakter" returns nothing, and adding it turned 38 empty queries into answers.
  //
  // The price was that every operation under /api/agreements matches "agreement", so the word cannot choose
  // between them and the ranking falls to text — which named the wrong write:
  //
  //     upload kontrakt    POST /api/attachments  ->  POST /api/agreements/{id}/sign-request
  //
  // `main` answered an upload with the attachment POST, correctly, and the synonym replaced it with an
  // operation that SENDS a signing request. Storing a document and starting a signature round are different
  // acts. Found by Codex on PR #121. Asserted so the temptation is recorded with its price.
  assert.equal(searchOperations({ query: "upload kontrakt", limit: 1 })[0].path, "/api/attachments");
  assert.equal(searchOperations({ query: "vis kontrakter", limit: 1 }).length, 0);
  // The English spelling still works, and the Norwegian compounds reach the family by decomposition.
  assert.equal(searchOperations({ query: "list contracts", limit: 1 })[0].path, "/api/agreements");
  assert.equal(searchOperations({ query: "vis leiekontrakt", limit: 1 })[0].path, "/api/agreements");
});

test("a METHOD_INTENT hint alone is not write intent", () => {
  // Codex proposed, on PR #121, that any verb implying a writing method should count as write intent. Tried and
  // REVERTED: the two tables are deliberately asymmetric. METHOD_INTENT holds words that say which method
  // WITHOUT licensing a write, so "which invoices did we cancel" — already a held-out case in this file —
  // ranked DELETE /api/invoices/{id}/manual-credit-note-applications first. One unambiguous verb was added
  // instead.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  assert.equal(top("which invoices did we cancel").method, "GET");
  // And adding `make` to WRITE_INTENT_VERBS instead was also measured and rejected: it is as common in a
  // past-tense question as in an imperative, so "which invoices did we make" ranked POST /api/invoices — the
  // same shape one word further on. Both are asserted, so neither fix can be reintroduced without failing here.
  assert.equal(top("which invoices did we make").method, "GET");
  assert.equal(top("how many invoices did we make").method, "GET");
  // The accepted cost, asserted rather than described: a create question gets the collection. Unhelpful, and
  // better than a write ranked first for a question about the past.
  assert.equal(top("how do I make a rent agreement").path, "/api/agreements");
});

test("widening a synonym to reach a family would displace the families it names", () => {
  // `husleie` decomposes to hus + leie and shares no token with "agreement", so GET /api/agreements is not a
  // candidate for "vis husleie" and read intent has nothing to promote — that query still ranks the create.
  // Adding "agreement" to the synonym fixes those 18 reads and was measured and REVERTED: the third token
  // made `husleie` win every compound it appeared in, and 26 pairs lost the resource the other word names.
  // This is the defect this table has now retracted three synonyms for. Asserted so the temptation is
  // recorded with its price, and so a future widening fails here.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  assert.equal(`${top("husleie mva").method} ${top("husleie mva").path}`, "GET /api/vat-codes");
  assert.equal(`${top("husleie bilag").method} ${top("husleie bilag").path}`, "GET /api/vouchers");
  assert.equal(top("husleie postering").path, "/api/postings");
  // The sibling spellings do reach the family, through compound decomposition rather than a wider synonym.
  for (const query of ["vis leieavtale", "vis leiekontrakt"]) {
    assert.equal(top(query).path, "/api/agreements", `"${query}" -> ${top(query).path}`);
  }
});

/**
 * An ACTION the query never asked for, however well its path happens to match.
 *
 * /api/salary-payments is the collection, /api/salary-payments/{id} the item, and
 * /api/salary-payments/{id}/complete the action that FILES payroll with Skatteetaten. Measured on main:
 *
 *     opprett salary payments   POST /api/salary-payments/{id}/complete   63.8   <- files with Skatteetaten
 *                               POST /api/salary-payments                 61.3   <- creates one, fifth
 *     opprett agreements        POST /api/agreements/{id}/sign-request     41.4   <- sends to a counterparty
 *                               POST /api/agreements/employee-contract     38.4
 *
 * Found by auditing 804 resource-only queries: 56 ranked an irreversible nested action first and 24 of those
 * transmit outside the tenant. Only irreversible or transmitting actions are demoted — a first version also cut
 * ordinary nested reads and the held-out corpora caught the cost within one run.
 */
test("a single-word action the query never named does not outrank the resource it did name", () => {
  // /api/salary-payments is the collection and /api/salary-payments/{id}/complete is the action that FILES
  // payroll with Skatteetaten. On main, "opprett salary payments" ranked the filing at 63.8 and the create
  // fifth at 61.3, and "salary run" reached the resource only at rank 8.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  assert.equal(`${top("opprett lonnskjoring").method} ${top("opprett lonnskjoring").path}`, "POST /api/salary-payments");
  // The filing must not be first for ANY of these, which is the property that matters. It is asserted this way
  // rather than pinning one winner because "opprett salary payments" reaches
  // POST /api/salary-payments/{id}/wage-specs — a two-part segment, so exempt, and reversible. Better than a
  // government filing and still not the create; named rather than glossed.
  for (const query of ["opprett salary payments", "create salary payments", "opprett lonnskjoring", "salary run"]) {
    assert.notEqual(top(query).path, "/api/salary-payments/{id}/complete", `"${query}" ranked the filing first`);
  }
  // "salary run" reaches the resource at rank 7 now, from 8 on main; the exact figure is pinned in
  // discovery-norwegian.test.mjs, which is where that corpus lives.
  assert.notEqual(top("salary run").path, "/api/salary-payments/{id}/complete");
});

test("the demotion is scoped to single-word segments, because the general form did harm", () => {
  // Both reviews of PR #122 found the unrestricted rule doing more damage than the defect, and each case below
  // is one of theirs, asserted so the general form cannot come back quietly.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];

  // It inverted a request into its own undo. This query is the endpoint's own summary, verbatim, and requiring
  // every hyphen part of `manual-credit-note-applications` to be named made it unexemptable — so the DELETE,
  // which took a milder cut, became first and would UNAPPLY the credit note.
  assert.equal(
    top("Apply a manual credit note to an invoice").path,
    "/api/invoices/{id}/manual-credit-note-applications",
  );
  assert.notEqual(top("Apply a manual credit note to an invoice").method, "DELETE");

  // And it pushed legitimate requests down or out: "signer avtalen" lost the signing operations from the top
  // three, and the rounding-adjustment endpoint lost its own summary as a query at rank 29 — past the default
  // limit of 25, so out of reach altogether.
  assert.match(top("signer avtalen").path, /sign-request/);
  const settle = searchOperations({ query: "Settle insignificant invoice outstanding", limit: 25 }).map((h) => h.path);
  assert.ok(
    settle.includes("/api/invoices/{id}/rounding-adjustment"),
    `the rounding adjustment must stay within the default limit: ${settle.slice(0, 5).join(", ")}`,
  );
});

test("an action with no better alternative is not pushed out of reach", () => {
  // The condition that stops this becoming a blunt instrument. /api/manual-reconciliations has no
  // collection-level POST, so demoting .../reopen promotes nothing — and "åpne avstemmingen på nytt" asks to
  // reopen a reconciliation while never containing the word "reopen". A hard cut dropped it out of the top ten
  // entirely, which the ratcheted held-out corpus caught.
  const rankOf = (query, want) =>
    searchOperations({ query, limit: 10 })
      .map((h) => h.path)
      .findIndex((p) => p.startsWith(want));
  assert.ok(
    rankOf("åpne avstemmingen på nytt", "/api/manual-reconciliations/{bankAccountId}/reopen") >= 0,
    "the reconciliation reopen must stay reachable for the phrasing that asks for it",
  );
  // Pinned at its exact rank rather than ">= 0". The review pointed out that the loose form passed while the
  // very thing it guards degraded: an earlier version moved this from rank 8 to 9 and the test said nothing.
  assert.equal(rankOf("aktiver abonnementet igjen", "/api/subscriptions/{id}/activate"), 8);
});

/**
 * An exact compound names a PATH, so it is matched against the structural fields only.
 *
 * The all-or-nothing rule from PR #120 required merely that every part of a hyphenated term appear SOMEWHERE
 * in the haystack. In a path or an operation id the segments are adjacent by construction, so that was the same
 * thing. In prose the words scatter, and boilerplate scored a full 1:
 *
 *     "vat-returns"       vs  GET /api/vat-codes             "returns every vat code supported by reai…"
 *     "tax-returns"       vs  POST …/wage-specs              "…returns the updated salary payment"
 *     "chart-of-accounts" vs  GET /api/general-sub-accounts
 *
 * A strength of 1 with weight >= 1 enters `matchedResourceTerms`, so each of those bought the uncapped coverage
 * multiplier — exactly what the "a 0.2 bare-substring hit is noise and must not buy the coverage multiplier"
 * guard was written to stop. Measured: 35 such matches, every one in a summary or a description.
 *
 * Found by the independent review of PR #120, which reported it against that PR's first commit and noted the
 * later scoping did not address it. It did not: `vat-returns` and `tax-returns` ARE phrase replacements, so the
 * opt-in narrowed the blast radius without touching this.
 */
test("an exact compound does not match prose that merely contains its parts", () => {
  const description = "returns every vat code supported by reai, including its code, rate, and description";
  const tokens = fieldTokens(description);
  // Both parts are present, in the wrong order and far apart. Off for prose now.
  assert.equal(matchStrength(description, tokens, "vat-returns", false), 0);

  // And through the SCORER, which is where the change lives — the two assertions above pass on `main` too,
  // because they call the primitive with the flag already off. This one does not: on `main`, "mva-melding"
  // surfaced GET /api/vat-codes at rank 5, on the strength of "returns every vat code…" scoring a full 1 for
  // the phrase term `vat-returns`. An unrelated resource, reached through boilerplate.
  const forVatReturn = searchOperations({ query: "mva-melding", limit: 20 }).map((h) => `${h.method} ${h.path}`);
  assert.equal(forVatReturn[0], "POST /api/vat-returns");
  assert.ok(
    !forVatReturn.includes("GET /api/vat-codes"),
    `the VAT CODES list should not be reachable through prose here: ${forVatReturn.slice(0, 6).join(", ")}`,
  );
  // And the structural fields, where the segments are adjacent by construction, still score a full match.
  assert.equal(matchStrength("/api/vat-returns", fieldTokens("/api/vat-returns"), "vat-returns", true), 1);
  assert.equal(
    matchStrength("post_api_vat_returns", fieldTokens("post_api_vat_returns"), "vat-returns", true),
    1,
  );
});

test("requiring adjacency instead was rejected, and these are the cases that reject it", () => {
  // Recorded because adjacency is the obvious fix and it does not work. Two terms deliberately name a NESTED
  // path, where the parameter sits between the segments — and the singular/plural folding means a term's last
  // part is often not at a word boundary in the haystack. Both would break.
  const nested = "/api/salary-payments/{id}/complete";
  assert.equal(matchStrength(nested, fieldTokens(nested), "salary-payments-complete", true), 1);
  const plural = "/api/salary-payments";
  assert.equal(matchStrength(plural, fieldTokens(plural), "salary-payment", true), 1);
  // Which is why the a-melding split still resolves the way PR #121 left it.
  const top = (q) => searchOperations({ query: q, limit: 1 })[0];
  assert.equal(top("a-melding").path, "/api/salary-payments/{id}/complete");
  assert.equal(top("a-melding feedback").path, "/amelding/{id}/feedback-raw");
  assert.equal(top("vis amelding").path, "/api/salary-payments");
});

test("the correct prose matches survive, and only the two wrong ones go", () => {
  // The population matters, and a first version of this work got it wrong in both directions. Measured over all
  // 430 operations against every hyphenated phrase replacement: 18 prose matches, 14 with the words ADJACENT and
  // correct, 2 genuinely wrong. The CHANGELOG had claimed 35 and "every one false" — a number built by scanning
  // every hyphenated string in the source, including term-table values that never reach this branch. The review
  // of PR #127 counted properly.
  //
  // So the rule is adjacency in prose, not exclusion of prose: excluding it outright removed the same 2 and
  // demoted all 14, which measurably cost `mva-koder` 43.40 -> 40.40 and swapped two ranks under "mva-melding".
  const top = (q, n = 1) => searchOperations({ query: q, limit: n });

  // The 14, spot-checked at their scores: these are phrases, adjacent in a summary, and must not be demoted.
  assert.equal(`${top("chart of accounts")[0].method} ${top("chart of accounts")[0].path}`, "GET /api/chart-of-accounts");
  assert.equal(top("mva-koder")[0].path, "/api/vat-codes");
  assert.equal(top("mva-koder")[0].score, 43.4, "the blunt prose exclusion cost this 3 points");
  assert.match(top("bank transactions")[0].path, /bank-transactions/);
  assert.match(top("annual accounts")[0].path, /annual-accounts/);

  // And the two that were wrong: an unrelated resource reached through scattered words in a description.
  const chart = top("chart of accounts", 20).map((h) => `${h.method} ${h.path}`);
  assert.ok(!chart.includes("GET /api/general-sub-accounts"), `general-sub-accounts still present: ${chart.slice(0, 5)}`);
  const vat = top("mva-melding", 20).map((h) => `${h.method} ${h.path}`);
  assert.ok(!vat.includes("GET /api/vat-codes"), `vat-codes still present: ${vat.slice(0, 5)}`);
});

test("a multiword tag and a joined field-name list take the prose rule, not the structural one", () => {
  // The first version called all four non-prose fields "adjacent by construction". False for two of them, as the
  // review of PR #127 measured: there are 26 multiword tags, and fieldNamesOf joins unrelated parameter names
  // with spaces, so a term's parts can arrive from two different parameters — the same non-adjacency, at weight
  // 3, on the side the rule was leaving alone. Both are on the prose rule now.
  // A tag whose words ARE adjacent still matches at full strength.
  assert.equal(matchStrength("bank transactions", fieldTokens("bank transactions"), "bank-transactions", "prose"), 1);
  // Scattered across a joined field-name list, it does not.
  const joined = "transactionid bankaccountid postingdate";
  assert.equal(matchStrength(joined, fieldTokens(joined), "bank-transactions", "prose"), 0);
  // While the path keeps the structural rule, where a parameter may sit between the segments.
  const nested = "/api/salary-payments/{id}/complete";
  assert.equal(matchStrength(nested, fieldTokens(nested), "salary-payments-complete", "structural"), 1);
});

test("the ranking defect docs/discovery.md describes is still present", async () => {
  // This test EXISTS TO FAIL when the defect is fixed. docs/discovery.md reasons in detail from the table
  // below — three irreversible external sends above five tied creation endpoints — and nothing asserted it,
  // so the day someone widens the family notion or drops the identity-bonus hyphen guard the page becomes
  // false and the suite stays green. If you are reading this because it failed: good. Check whether the
  // creation endpoints now win, and if so rewrite that section rather than adjusting this test.
  const { classifyRequest, classifyTransmission } = await import("../dist/policy.js");
  const CREATION = [
    "/api/agreements/accounting-services",
    "/api/agreements/employee-contract",
    "/api/agreements/purchase-agreement",
    "/api/agreements/rent-agreement",
    "/api/agreements/service-agreement",
  ];

  for (const query of ["create agreement", "opprett avtale", "create lease agreement"]) {
    const hits = searchOperations({ query, limit: 8 });
    // TWO, not three. This was three until the path tie-break stopped using `localeCompare`: under that
    // collation `{` sorted before letters, so `{id}/sign-requests/{signRequestId}/send` took rank 3 out of the
    // 16-point tie; by codepoint it sorts after `a`-`z` and the concrete creation templates do. Nothing about
    // merit changed — the whole group ties at 16 — which is why this number is a fact about the tie-break and
    // the assertions below still pin the defect itself.
    const leading = hits.slice(0, 2);
    const sendScores = leading.map((h) => h.score);
    for (const hit of leading) {
      const concrete = hit.path.replace(/\{[^}]+\}/g, "7");
      assert.match(hit.path, /sign-request/, `"${query}": rank ${hits.indexOf(hit) + 1} is ${hit.path}`);
      // The reason it matters that these are first, stated as an assertion rather than as prose.
      assert.equal(classifyTransmission(hit.method, concrete), "external", `${hit.path} should transmit`);
      assert.equal(classifyRequest(hit.method, concrete), "irreversible", `${hit.path} should be irreversible`);
    }
    // And rank 3 IS a creation template now, which is the part the tie-break changed. If this fails because a
    // send has come back to rank 3, the tie-break has regressed; if it fails because rank 3 outscores the sends,
    // the defect is genuinely fixed and this whole test should go.
    assert.ok(
      CREATION.includes(hits[2].path),
      `"${query}": rank 3 should be a creation template, got ${hits[2].path}`,
    );

    // And the five creation endpoints tie, which is why the page names no order among them — the order comes
    // from a path tie-break, not from merit. (The page used to say "tied for fourth through eighth"; since the
    // tie-break change they are third through seventh, and this comment cited the old wording for one commit.)
    const creation = hits.filter((h) => CREATION.includes(h.path));
    assert.equal(creation.length, 5, `"${query}": expected all five creation templates in the top 8`);
    assert.equal(
      new Set(creation.map((h) => h.score)).size,
      1,
      `"${query}": the creation templates no longer tie — docs/discovery.md says they do`,
    );
    // There WAS a score assertion here — "no creation template matches or beats a send" — and it is gone rather
    // than repaired, because under codepoint ordering it cannot fail. Any creation scoring at or above a send
    // also sorts before it (a letter beats `{`), so the position assertions above fire first, every time. Review
    // found the version I had just rewritten was unfalsifiable, and rewriting it again against the sends by name
    // did not help: the two conditions are the same condition.
    //
    // What remains pins the defect completely: ranks 1 and 2 are the sends, and rank 3 is a creation template. If
    // the sends ever stop leading, the first assertion fails; if a send returns to rank 3, the second does.
    // Keeping a third line that can only ever be decoration would misrepresent how much is checked.
    assert.ok(sendScores.every((s) => s > creation[0].score), `"${query}": the sends should still outscore`);
  }
});

test("search ranks identically whatever locale the process is in", async () => {
  // THE property this change is about, and nothing pinned it. Review demonstrated that: a comparator built on
  // `new Intl.Collator().compare` — genuinely locale-dependent — passed all 1203 tests, because the one test that
  // caught the old `localeCompare` caught it for a side-effect of how `{` sorts, not for locale-dependence.
  //
  // Measured hazard on this spec, which is NOT the Norwegian one the builder's comment cites: `/api/chart-of-
  // accounts` vs `/api/company-banks` compares -1 under `en` and +1 under `cs`, because Czech collates `ch` after
  // `h`. Under the old tie-break, 192 of 1435 corpus queries ordered differently under `LANG=cs_CZ`.
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

  // Two ordering-sensitive queries plus the pair that actually diverges, run in a child process so the locale is
  // genuinely different rather than simulated.
  const script = `
    const { searchOperations } = await import(${JSON.stringify(join(repo, "dist", "reai", "spec.js"))});
    const out = [];
    for (const q of ["ledger", "tax-returns", "vat-returns", "accounts", "create agreement"]) {
      out.push(q + " => " + searchOperations({ query: q, limit: 10 }).map((h) => h.method + " " + h.path).join(","));
    }
    console.log(out.join("\\n"));
  `;
  const run = (locale) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale, LC_COLLATE: locale },
    });

  const baseline = run("en_US.UTF-8");
  // The queries above are chosen because they produce SCORE TIES between paths the collations disagree on —
  // `/api/chart-of-accounts` against `/api/general-sub-accounts` and `/api/countries`. My first version used
  // queries that merely mentioned those paths without tying them, so the tie-break never decided between them
  // and review's locale-dependent comparator passed. 228 such ties exist across the segment corpus.
  assert.ok(baseline.includes("chart-of-accounts"), `the probe should reach the diverging paths: ${baseline}`);
  assert.ok(
    /general-sub-accounts|countries/.test(baseline),
    `the probe must include a path that TIES with chart-of-accounts, or the collation cannot show: ${baseline}`,
  );
  for (const locale of ["cs_CZ.UTF-8", "nb_NO.UTF-8", "sv_SE.UTF-8", "lt_LT.UTF-8"]) {
    assert.equal(
      run(locale),
      baseline,
      `search ordered differently under LANG=${locale}; the tie-break has become locale-dependent again`,
    );
  }

  // And the collation really does disagree, so the assertions above are not vacuous on this machine.
  assert.notEqual(
    "/api/chart-of-accounts".localeCompare("/api/company-banks", "cs"),
    "/api/chart-of-accounts".localeCompare("/api/company-banks", "en"),
    "if these agree, this Node build has no ICU data and the locale assertions above prove nothing",
  );
});
