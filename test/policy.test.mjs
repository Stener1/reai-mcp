import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRequest,
  isAllowed,
  parseWriteMode,
  assertAllowed,
  WriteBlockedError,
  DEFAULT_WRITE_MODE,
} from "../dist/policy.js";

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
    ["POST", "/api/reconciliation-rules"],
  ]) {
    assert.equal(classifyRequest(method, path), "reversible", `${method} ${path}`);
  }
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
