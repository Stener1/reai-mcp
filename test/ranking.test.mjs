import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOperations, matchStrength, fieldTokens } from "../dist/reai/spec.js";

/**
 * Discovery ranking, measured rather than assumed.
 *
 * `reai_search_endpoints` is how an agent reaches the 143 operations no curated
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
  ["opening balance when starting in the system", "/api/opening-balances"],
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
    "opening balance when starting in the system",
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
    ["post a voucher", "POST", "/api/vouchers"],
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
  assert.equal(strength("/api/opening-balances", "opening-balances"), 1);
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
  assert.equal(weak("/api/opening-balances", "opening-balances"), 0.6);
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
