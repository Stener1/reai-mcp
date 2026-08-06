import { test } from "node:test";
import assert from "node:assert/strict";
import { QUIRKS, quirksFor, findQuirks } from "../dist/reai/quirks.js";
import { getSpecIndex } from "../dist/reai/spec.js";

/**
 * The point of this registry is that quirks reach the ~256 operations no curated
 * tool covers. These tests keep it honest: a quirk pointing at a path that no
 * longer exists is worse than no quirk, because it looks authoritative.
 */

test("EVERY path of every quirk matches a real operation", () => {
  // Deliberately per-path. Requiring only one path to match let a renamed
  // endpoint keep publishing authoritative-looking advice, because a sibling path
  // in the same quirk still resolved.
  const ops = getSpecIndex().operations;
  for (const q of QUIRKS) {
    for (const p of q.paths) {
      const candidate = p.toLowerCase().replace(/\/+$/, "");
      const matched = ops.some((op) => {
        if (q.methods && !q.methods.includes(op.method)) return false;
        const target = op.path.toLowerCase();
        if (target === candidate) return true;
        return q.match === "descendants" && target.startsWith(candidate + "/");
      });
      assert.ok(
        matched,
        `quirk "${q.id}" declares path "${p}"` +
          `${q.methods ? ` for ${q.methods.join("/")}` : ""} which matches no operation` +
          `${q.match === "descendants" ? "" : " (match is exact; add match: \"descendants\" if intended)"}`,
      );
    }
  }
});

test("a quirk only reaches sub-operations when it says it does", () => {
  // The leak this fixed: POST /api/invoices/{id}/email inherited
  // "an invoice is created FROM AN ORDER" and was told to send an orderId, and
  // POST /api/customers/{id}/contact-persons inherited the customer-creation
  // field restrictions. Both are wrong, and both read as authoritative.
  const emailIds = quirksFor("POST", "/api/invoices/{id}/email").map((q) => q.id);
  assert.ok(!emailIds.includes("invoice-from-order-only"), emailIds.join(", "));

  const contactIds = quirksFor("POST", "/api/customers/{id}/contact-persons").map((q) => q.id);
  for (const leaked of ["customer-create-fields", "brreg-lookup", "phone-no-plus47"]) {
    assert.ok(!contactIds.includes(leaked), `${leaked} leaked onto contact-persons`);
  }

  // The parent operations still carry them.
  assert.ok(quirksFor("POST", "/api/invoices").some((q) => q.id === "invoice-from-order-only"));
  assert.ok(quirksFor("POST", "/api/customers").some((q) => q.id === "customer-create-fields"));

  // And a descendants-marked quirk still reaches down where that is intended.
  assert.ok(
    quirksFor("POST", "/api/vat-returns/reopen").some((q) => q.id === "vat-return-does-not-file"),
    "vat-return-does-not-file should reach /reopen",
  );
});

test("quirk ids are unique and kinds are known", () => {
  const ids = QUIRKS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate quirk id");
  const kinds = new Set(["shape", "workflow", "irreversible", "validation", "gotcha"]);
  for (const q of QUIRKS) {
    assert.ok(kinds.has(q.kind), `${q.id}: unknown kind "${q.kind}"`);
    assert.ok(q.note.length > 40, `${q.id}: note is too short to be useful`);
    assert.ok(q.paths.length > 0, `${q.id}: no paths`);
    for (const p of q.paths) assert.ok(p.startsWith("/"), `${q.id}: path "${p}" must be absolute`);
  }
});

test("the quirks that motivated this registry reach their endpoints", () => {
  // Each of these was learned the hard way; if any stops matching, the knowledge
  // has silently left the product.
  const cases = [
    ["GET", "/api/bank-transactions/{id}", "no-bank-transaction-list"],
    ["GET", "/api/bank-reconciliations/{bankAccountId}", "no-bank-transaction-list"],
    ["GET", "/api/bank-reconciliations/{bankAccountId}", "manual-vs-synced-reconciliation"],
    ["POST", "/api/invoices", "invoice-from-order-only"],
    ["POST", "/api/offers", "offer-lines-stricter"],
    ["POST", "/api/orders", "order-send-ehf"],
    ["POST", "/api/customers", "customer-create-fields"],
    ["POST", "/api/customers", "phone-no-plus47"],
    ["POST", "/api/supplier-invoices", "cost-line-explicit-accounts"],
    ["POST", "/api/subscriptions", "subscription-self-invoicing"],
    ["POST", "/api/vat-returns", "vat-return-does-not-file"],
    ["POST", "/api/vat-returns", "vat-return-query-params"],
    ["POST", "/api/vouchers", "voucher-signed-amounts"],
    ["GET", "/api/vouchers", "date-range-required"],
    ["POST", "/api/bank-reconciliations/{bankAccountId}/apply-rules", "apply-rules-async"],
    ["POST", "/api/bank-reconciliations/{bankAccountId}/vouchers", "book-transactions-subledger"],
  ];
  for (const [method, path, id] of cases) {
    const ids = quirksFor(method, path).map((q) => q.id);
    assert.ok(ids.includes(id), `${method} ${path} should carry "${id}"; got ${ids.join(", ") || "none"}`);
  }
});

test("method-scoped quirks do not leak onto other methods", () => {
  // The signed-amount convention is about writing a voucher, not reading one.
  assert.ok(!quirksFor("GET", "/api/vouchers").some((q) => q.id === "voucher-signed-amounts"));
  assert.ok(quirksFor("POST", "/api/vouchers").some((q) => q.id === "voucher-signed-amounts"));
  // And a read never carries the sendEhf warning.
  assert.ok(!quirksFor("GET", "/api/orders").some((q) => q.id === "order-send-ehf"));
});

test("prefix matching respects path segments", () => {
  // "/api/vat-returns" must not match "/api/vat-codes".
  assert.ok(!quirksFor("GET", "/api/vat-codes").some((q) => q.id.startsWith("vat-return")));
  // A sub-path does inherit its parent's quirks.
  assert.ok(quirksFor("POST", "/api/vat-returns/reopen").some((q) => q.id === "vat-return-does-not-file"));
});

test("findQuirks filters by keyword across note, path and kind", () => {
  assert.ok(findQuirks("vat").length >= 3);
  assert.ok(findQuirks("irreversible").every((q) => `${q.kind} ${q.note}`.toLowerCase().includes("irreversible")));
  assert.equal(findQuirks("definitely-not-a-real-term").length, 0);
  assert.equal(findQuirks().length, QUIRKS.length);
  assert.equal(findQuirks("   ").length, QUIRKS.length);
});

test("quirks reach operations that no curated tool covers", () => {
  // The whole justification for the registry.
  const uncovered = ["POST /api/subscriptions", "POST /api/tax-returns/{year}/submit", "GET /api/expenses"];
  for (const entry of uncovered) {
    const [method, path] = entry.split(" ");
    assert.ok(quirksFor(method, path).length > 0, `${entry} should carry at least one quirk`);
  }
});
