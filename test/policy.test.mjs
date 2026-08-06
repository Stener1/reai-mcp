import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRequest,
  isAllowed,
  parseWriteMode,
  assertAllowed,
  WriteBlockedError,
  DEFAULT_WRITE_MODE,
  canonicalizeApiPath,
  classifyWithBody,
  escalatingBodyFields,
} from "../dist/policy.js";
import { ReaiClient } from "../dist/reai/client.js";

test("parseWriteMode defaults to reversible", () => {
  assert.equal(parseWriteMode(undefined), "reversible");
  assert.equal(parseWriteMode(""), "reversible");
  assert.equal(DEFAULT_WRITE_MODE, "reversible");
});

test("parseWriteMode accepts documented values and aliases", () => {
  assert.equal(parseWriteMode("read-only"), "read-only");
  assert.equal(parseWriteMode("readonly"), "read-only");
  assert.equal(parseWriteMode("READ_ONLY"), "read-only");
  assert.equal(parseWriteMode("  Full  "), "full");
  assert.equal(parseWriteMode("safe"), "reversible");
});

test("parseWriteMode rejects unknown values rather than guessing", () => {
  assert.throws(() => parseWriteMode("yolo"), /REAI_WRITE_MODE must be one of/);
});

test("GET is always a read, whatever the path", () => {
  for (const path of ["/api/vouchers", "/api/customers", "/api/admin/tenants", "/anything"]) {
    assert.equal(classifyRequest("GET", path), "read", path);
  }
});

test("ledger, legal-document, money and payroll writes are irreversible", () => {
  const cases = [
    ["POST", "/api/vouchers"],
    ["DELETE", "/api/vouchers/123"],
    ["PUT", "/api/vouchers/123"],
    ["POST", "/api/postings/customer/close"],
    ["POST", "/api/invoices"],
    ["POST", "/api/supplier-invoices"],
    ["POST", "/api/expenses"],
    ["POST", "/api/salary-payments"],
    ["POST", "/api/vat-returns"],
    ["POST", "/api/tax-returns"],
    ["POST", "/api/opening-balances"],
    ["POST", "/api/bank-reconciliations"],
    ["POST", "/api/assets"],
    ["POST", "/api/loans"],
    ["POST", "/api/share-investments"],
  ];
  for (const [method, path] of cases) {
    assert.equal(classifyRequest(method, path), "irreversible", `${method} ${path}`);
  }
});

test("user, tenant and admin management is irreversible, not master data", () => {
  for (const [method, path] of [
    ["POST", "/api/users"],
    ["DELETE", "/api/users/5"],
    ["POST", "/api/tenants"],
    ["PATCH", "/api/admin/users"],
    ["DELETE", "/admin/tenants/9"],
  ]) {
    assert.equal(classifyRequest(method, path), "irreversible", `${method} ${path}`);
  }
});

test("master-data writes are reversible", () => {
  for (const [method, path] of [
    ["POST", "/api/customers"],
    ["PATCH", "/api/customers/42"],
    ["DELETE", "/api/customers/42"],
    ["POST", "/api/customers/42/contact-persons"],
    ["POST", "/api/suppliers"],
    ["POST", "/api/products"],
    ["POST", "/api/departments"],
    ["POST", "/api/offers"],
    ["POST", "/api/orders"],
    ["POST", "/api/documents"],
    ["POST", "/api/attachments"],
  ]) {
    assert.equal(classifyRequest(method, path), "reversible", `${method} ${path}`);
  }
});

test("a reconciliation rule is standing authority to post, so it is irreversible", () => {
  // It looks like master data and creates no posting immediately. But applying a
  // rule books vouchers, the API documents a sync-time auto-reconciliation step
  // that may act on it with no further call, and deleting the rule does not
  // reverse what it booked. "Books nothing yet" is not the same as reversible.
  assert.equal(classifyRequest("POST", "/api/reconciliation-rules"), "irreversible");
  assert.equal(classifyRequest("PUT", "/api/reconciliation-rules/3"), "irreversible");
  // Deletion is dragged along by the shared prefix. Accepted: it is safe in
  // itself, but a rule cannot be created in reversible mode either.
  assert.equal(classifyRequest("DELETE", "/api/reconciliation-rules/3"), "irreversible");
  // Reading them stays available in every mode.
  assert.equal(classifyRequest("GET", "/api/reconciliation-rules"), "read");
});

test("sub-paths that settle money or transmit documents escalate to irreversible", () => {
  for (const [method, path] of [
    ["POST", "/api/orders/7/payments"],
    ["POST", "/api/agreements/3/sign-request"],
    ["POST", "/api/receipt-reception-documents/8/registration"],
    ["POST", "/api/invoice-reception-documents/8/supplier-invoice"],
  ]) {
    assert.equal(classifyRequest(method, path), "irreversible", `${method} ${path}`);
  }
});

test("unknown write paths fail closed", () => {
  assert.equal(classifyRequest("POST", "/api/some-future-endpoint"), "irreversible");
  assert.equal(classifyRequest("DELETE", "/totally/unknown"), "irreversible");
});

test("classification ignores the query string and trailing slash", () => {
  assert.equal(classifyRequest("POST", "/api/customers/"), "reversible");
  assert.equal(classifyRequest("POST", "/api/customers?foo=bar"), "reversible");
  assert.equal(classifyRequest("POST", "/API/VOUCHERS"), "irreversible");
});

test("a prefix match requires a path-segment boundary", () => {
  // "/api/userstats" must not be treated as "/api/users".
  assert.equal(classifyRequest("POST", "/api/userstats"), "irreversible"); // unknown -> fails closed
  assert.equal(classifyRequest("POST", "/api/customers-archive"), "irreversible"); // not "/api/customers"
});

test("isAllowed implements the mode ladder", () => {
  assert.equal(isAllowed("read", "read-only"), true);
  assert.equal(isAllowed("reversible", "read-only"), false);
  assert.equal(isAllowed("irreversible", "read-only"), false);

  assert.equal(isAllowed("read", "reversible"), true);
  assert.equal(isAllowed("reversible", "reversible"), true);
  assert.equal(isAllowed("irreversible", "reversible"), false);

  assert.equal(isAllowed("read", "full"), true);
  assert.equal(isAllowed("reversible", "full"), true);
  assert.equal(isAllowed("irreversible", "full"), true);
});

test("assertAllowed explains how to widen the policy", () => {
  assert.doesNotThrow(() => assertAllowed("read", "read-only", "GET /api/me"));

  try {
    assertAllowed("irreversible", "reversible", "POST /api/vouchers");
    assert.fail("expected WriteBlockedError");
  } catch (err) {
    assert.ok(err instanceof WriteBlockedError);
    assert.match(err.message, /REAI_WRITE_MODE=reversible/);
    assert.match(err.message, /REAI_WRITE_MODE=full/);
    assert.equal(err.risk, "irreversible");
    assert.equal(err.mode, "reversible");
  }
});

// --- Path canonicalization -------------------------------------------------
// Regression tests for a real bypass: classification ran on the raw string
// while the request was built with `new URL()`, which resolves dot segments. So
// "/api/customers/../vouchers" was classified against the reversible
// "/api/customers" prefix but posted to the general ledger.

test("dot segments cannot smuggle a write past the policy", () => {
  const smuggles = [
    "/api/customers/../vouchers",
    "/api/customers/../../api/vat-returns",
    "/api/documents/../users",
    "/api/customers/%2e%2e/vouchers",
    "/api/customers/%2E%2E/vouchers",
    "/api/offers/./../vouchers",
    "/api/products/../../api/salary-payments",
    "/api/customers/..%2fvouchers",
  ];
  for (const path of smuggles) {
    assert.equal(
      classifyRequest("POST", path),
      "irreversible",
      `${path} must not be classified as reversible`,
    );
  }
});

test("canonicalizeApiPath resolves to what will actually be requested", () => {
  const cases = [
    ["/api/customers/../vouchers", "/api/vouchers"],
    ["/api/customers/./1234", "/api/customers/1234"],
    ["/api/customers/%2e%2e/vouchers", "/api/vouchers"],
    ["/api/customers/1234", "/api/customers/1234"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalizeApiPath(input)?.pathname, expected, input);
  }
});

test("canonicalizeApiPath refuses paths that escape our origin", () => {
  assert.equal(canonicalizeApiPath("https://evil.example.com/api/vouchers"), undefined);
  assert.equal(canonicalizeApiPath("//evil.example.com/api/vouchers"), undefined);
  assert.equal(canonicalizeApiPath(""), undefined);
  assert.equal(canonicalizeApiPath("   "), undefined);
});

test("canonicalizeApiPath keeps the query string separate", () => {
  const out = canonicalizeApiPath("/api/vouchers?startDate=2026-01-01");
  assert.equal(out?.pathname, "/api/vouchers");
  assert.equal(out?.search, "?startDate=2026-01-01");
});

test("a legitimate reversible write is still classified reversible", () => {
  // Guard against over-correcting the fix into blocking everything.
  assert.equal(classifyRequest("POST", "/api/customers"), "reversible");
  assert.equal(classifyRequest("PATCH", "/api/customers/1234"), "reversible");
  assert.equal(classifyRequest("POST", "/api/customers/1234/contact-persons"), "reversible");
});

// --- Body-aware escalation -------------------------------------------------
// Creating an order looks like ordinary master data, but `sendEhf: true`
// transmits the document to the counterparty over Peppol. Path-based
// classification cannot see that, so the body is inspected too.

test("a transmitting flag escalates an otherwise reversible write", () => {
  assert.equal(classifyRequest("POST", "/api/orders"), "reversible");
  assert.equal(classifyWithBody("reversible", { customerId: 1, orderLines: [] }), "reversible");
  assert.equal(classifyWithBody("reversible", { customerId: 1, sendEhf: true }), "irreversible");
});

test("a self-invoicing subscription escalates, including via a string value", () => {
  // POST /api/subscriptions is reversible master data, but these two fields let
  // ReAI issue numbered invoices on a schedule with no further call. outputMode
  // is a STRING, which a boolean-only check would miss entirely.
  assert.equal(classifyRequest("POST", "/api/subscriptions"), "reversible");
  assert.equal(classifyWithBody("reversible", { automaticBillingGeneration: true }), "irreversible");
  assert.equal(classifyWithBody("reversible", { outputMode: "create_invoice" }), "irreversible");
  // Producing a draft order instead is genuinely reversible.
  assert.equal(classifyWithBody("reversible", { outputMode: "create_order" }), "reversible");
  assert.equal(classifyWithBody("reversible", { automaticBillingGeneration: false }), "reversible");
});

test("subscription billing sub-paths are irreversible", () => {
  // /generate issues an invoice for one subscription; /generate-due does it for
  // every due subscription in the tenant at once.
  for (const path of [
    "/api/subscriptions/7/generate",
    "/api/subscriptions/generate-due",
    "/api/subscriptions/7/activate",
    "/api/subscriptions/7/deactivate",
  ]) {
    assert.equal(classifyRequest("POST", path), "irreversible", path);
  }
  // Plain subscription master data is still reversible.
  assert.equal(classifyRequest("PUT", "/api/subscriptions/7"), "reversible");
  assert.equal(classifyRequest("DELETE", "/api/subscriptions/7"), "reversible");
});

test("escalation only triggers on an explicit true", () => {
  for (const body of [
    { sendEhf: false },
    { sendEhf: "true" },
    { sendEhf: 1 },
    { outputMode: "create_order" },
    { sendEhf: null },
    {},
  ]) {
    assert.equal(classifyWithBody("reversible", body), "reversible", JSON.stringify(body));
  }
});

test("escalation is case-insensitive on the field name", () => {
  assert.equal(classifyWithBody("reversible", { SENDEHF: true }), "irreversible");
  assert.equal(classifyWithBody("reversible", { sendEHF: true }), "irreversible");
});

test("a non-object body is passed through untouched", () => {
  for (const body of [undefined, null, "string", 42, [{ sendEhf: true }]]) {
    assert.equal(classifyWithBody("reversible", body), "reversible", JSON.stringify(body) ?? "undefined");
  }
});

test("escalation never downgrades an already-irreversible call", () => {
  assert.equal(classifyWithBody("irreversible", {}), "irreversible");
  assert.equal(classifyWithBody("irreversible", { sendEhf: false }), "irreversible");
});

test("reads are unaffected by the body", () => {
  assert.equal(classifyWithBody("read", { sendEhf: true }), "read");
});

test("escalatingBodyFields names the offending field and its value", () => {
  assert.deepEqual(escalatingBodyFields({ sendEhf: true, customerId: 1 }), ["sendEhf=true"]);
  assert.deepEqual(escalatingBodyFields({ outputMode: "create_invoice" }), ['outputMode="create_invoice"']);
  assert.deepEqual(escalatingBodyFields({ sendEhf: false }), []);
  assert.deepEqual(escalatingBodyFields({ outputMode: "create_order" }), []);
  assert.deepEqual(escalatingBodyFields(undefined), []);
});

test("only booleans that are true, and the one string value, escalate", () => {
  // Guards the predicate map against regressing to a "field name is present" test.
  assert.equal(classifyWithBody("reversible", { outputMode: "CREATE_INVOICE" }), "reversible");
  assert.equal(classifyWithBody("reversible", { outputMode: "" }), "reversible");
  assert.equal(classifyWithBody("reversible", { automaticBillingGeneration: "true" }), "reversible");
});

test("manual reconciliation endpoints are matched by prefix, not by fail-closed accident", () => {
  // The policy previously listed "/api/manual-bank-reconciliations", which does
  // not exist — the real path has no "bank" segment. Those endpoints came out
  // irreversible only because unknown write paths fail closed, so the intended
  // protection would have silently vanished if anyone later listed the real path
  // as reversible.
  for (const path of [
    "/api/manual-reconciliations/5/close",
    "/api/manual-reconciliations/5/reopen",
    "/api/manual-reconciliations/5/ending-balance",
  ]) {
    assert.equal(classifyRequest("POST", path), "irreversible", path);
    assert.equal(classifyRequest("PUT", path), "irreversible", path);
  }
});

test("bank reconciliation mutations are irreversible, reads are not", () => {
  for (const path of [
    "/api/bank-reconciliations/5/matches",
    "/api/bank-reconciliations/5/vouchers",
    "/api/bank-reconciliations/5/apply-rules",
    "/api/bank-reconciliations/5/close",
    "/api/bank-transactions/9",
  ]) {
    assert.equal(classifyRequest("POST", path), "irreversible", path);
    assert.equal(classifyRequest("GET", path), "read", path);
  }
  // Company bank accounts are genuine master data.
  assert.equal(classifyRequest("POST", "/api/company-banks"), "reversible");
});

test("VAT and tax filing are irreversible", () => {
  for (const path of [
    "/api/vat-returns",
    "/api/vat-returns/reopen",
    "/api/vat-returns/complete-manually",
    "/api/tax-returns/2026/submit",
    "/api/tax-returns/2026/validate",
  ]) {
    assert.equal(classifyRequest("POST", path), "irreversible", path);
  }
  assert.equal(classifyRequest("GET", "/api/tax-returns/2026"), "read");
});

test("array query parameters are comma-joined, not repeated", () => {
  // The only array query parameter in the ReAI API (`include` on the bank
  // reconciliation view) declares style=form, explode=false.
  const seen = [];
  const client = new ReaiClient({
    token: "t",
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return client
    .request({
      method: "GET",
      path: "/api/bank-reconciliations/5",
      query: { month: "2026-08", include: ["summary", "matched_groups"] },
    })
    .then(() => {
      assert.match(seen[0], /include=summary%2Cmatched_groups/);
      assert.ok(!/include=summary&include=/.test(seen[0]), "must not repeat the key");
    });
});

test("empty and null-only arrays are omitted from the query string", () => {
  const seen = [];
  const client = new ReaiClient({
    token: "t",
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return client
    .request({ method: "GET", path: "/api/x", query: { a: [], b: [null, undefined], c: "keep" } })
    .then(() => {
      assert.ok(!seen[0].includes("a="), seen[0]);
      assert.ok(!seen[0].includes("b="), seen[0]);
      assert.match(seen[0], /c=keep/);
    });
});
