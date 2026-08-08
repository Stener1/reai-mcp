import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOperations, matchStrength, fieldTokens } from "../dist/reai/spec.js";

/**
 * Discovery ranking, measured rather than assumed.
 *
 * `reai_search_endpoints` is how an agent reaches the 148 operations no curated
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
