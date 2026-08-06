import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOperations } from "../dist/reai/spec.js";

/**
 * Discovery ranking, measured rather than assumed.
 *
 * `reai_search_endpoints` is how an agent reaches the ~256 operations no curated
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
  const neutral = [
    "salary payment",
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
});

test("a whole-word match beats a fragment", () => {
  // "register" inside "registration" was scored as strongly as an exact hit, which
  // put a receipt-registration endpoint above /api/employees.
  const hits = searchOperations({ query: "register a new employee", limit: 3 });
  assert.ok(
    hits.some((h) => h.path === "/api/employees"),
    `got ${hits.map((h) => h.path).join(", ")}`,
  );
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
