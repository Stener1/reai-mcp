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
  const reaches = (q, candidate, op) => {
    const target = op.path.toLowerCase();
    if (target === candidate) return true;
    return q.match === "descendants" && target.startsWith(candidate + "/");
  };

  for (const q of QUIRKS) {
    const candidates = q.paths.map((p) => p.toLowerCase().replace(/\/+$/, ""));
    const methods = q.methods ?? null;

    // Two separate requirements, rather than every path x method pair. A quirk
    // legitimately spans a collection (POST /api/vouchers) and an item
    // (PUT /api/vouchers/{id}), where neither path supports both methods.

    // 1. No dead path: each declared path must match some operation the quirk
    //    could apply to. This is what catches a renamed endpoint.
    for (const [i, candidate] of candidates.entries()) {
      const matched = ops.some(
        (op) => (!methods || methods.includes(op.method)) && reaches(q, candidate, op),
      );
      assert.ok(
        matched,
        `quirk "${q.id}" declares path "${q.paths[i]}" which matches no operation` +
          `${methods ? ` for any of ${methods.join("/")}` : ""}` +
          `${q.match === "descendants" ? "" : ' (match is exact; add match: "descendants" if intended)'}`,
      );
    }

    // 2. No dead method: each declared method must reach some declared path.
    //    This is what catches a quirk scoped to PATCH while naming only the
    //    collection path, since PATCH lives on /{id}.
    for (const method of methods ?? []) {
      const matched = ops.some(
        (op) => op.method === method && candidates.some((c) => reaches(q, c, op)),
      );
      assert.ok(
        matched,
        `quirk "${q.id}" declares method ${method}, which matches none of its paths ` +
          `(${q.paths.join(", ")}). PATCH and PUT usually live on the /{id} path, not the collection.`,
      );
    }
  }
});

test("update-scoped quirks reach the item paths their operations live on", () => {
  // Regression: exact matching silently dropped these, because PATCH/PUT are on
  // /{id} while the quirk named only the collection.
  const cases = [
    ["PATCH", "/api/customers/{id}", "phone-no-plus47"],
    ["PATCH", "/api/customers/{id}", "customer-name-title-cased"],
    ["PATCH", "/api/suppliers/{id}", "phone-no-plus47"],
    ["PUT", "/api/offers/{id}", "offer-lines-stricter"],
    ["PUT", "/api/offers/{id}", "days-until-due-mandatory"],
    ["PUT", "/api/subscriptions/{id}", "subscription-self-invoicing"],
    ["PUT", "/api/company-banks/{id}", "company-bank-bban"],
  ];
  for (const [method, path, id] of cases) {
    const ids = quirksFor(method, path).map((q) => q.id);
    assert.ok(ids.includes(id), `${method} ${path} should carry "${id}"; got ${ids.join(", ") || "none"}`);
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
