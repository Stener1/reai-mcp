import { test } from "node:test";
import assert from "node:assert/strict";
import { QUIRKS, quirksFor, findQuirks } from "../dist/reai/quirks.js";
import { getSpecIndex } from "../dist/reai/spec.js";

/**
 * The point of this registry is that quirks reach the 135 operations no curated
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
    ["PATCH", "/api/customers/{id}", "phone-one-rule-parsed-as-norwegian"],
    ["PATCH", "/api/customers/{id}", "customer-name-title-cased"],
    ["PATCH", "/api/suppliers/{id}", "phone-one-rule-parsed-as-norwegian"],
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
  // phone-one-rule-parsed-as-norwegian was on this list as phone-no-plus47, when it was scoped to the
  // entity phone only and reaching a contact-person path would have been a leak. It now covers both
  // deliberately, because re-measuring showed there is ONE rule rather than the two the old note
  // claimed — so it is no longer a leak candidate for these paths.
  for (const leaked of ["customer-create-fields", "brreg-lookup"]) {
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
    ["POST", "/api/customers", "phone-one-rule-parsed-as-norwegian"],
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

test("a hazard on a create is attached to the create, not to the failure it causes later", async () => {
  // Review's finding, and the sequence matters more than the wording: the warning that an opening
  // position makes a share investment permanent was attached to DELETE, so a caller met it only when
  // trying to remove the record — after the decision that made it permanent. A success-path hazard
  // belongs on the operation that causes it, with no `statuses`, so `reai_describe_endpoint` and a
  // successful call both carry it.
  const { QUIRKS, quirksFor } = await import("../dist/reai/quirks.js");

  const onCreate = quirksFor("POST", "/api/share-investments").map((q) => q.id);
  assert.ok(
    onCreate.includes("share-investment-opening-position-is-permanent"),
    "the caller has to be told before the record exists",
  );
  const warning = QUIRKS.find((q) => q.id === "share-investment-opening-position-is-permanent");
  assert.equal(warning.statuses, undefined, "a success-path hazard is not keyed to a status code");
  assert.match(warning.note, /openingQuantity/);
  assert.match(warning.note, /cannot be deleted|permanent/);

  // And the 400 explanation stays where the 400 happens, still scoped to it.
  const onDelete = QUIRKS.find((q) => q.id === "share-investment-with-events-cannot-be-deleted");
  assert.deepEqual(onDelete.statuses, [400]);
  assert.deepEqual(onDelete.methods, ["DELETE"]);
  // It has to point back at the decision rather than leaving the caller stuck.
  assert.match(onDelete.note, /POST \/api\/share-investments/);

  // An event posts to the ledger, so that warning must reach the event endpoint itself.
  assert.ok(
    quirksFor("POST", "/api/share-investments/{id}/events")
      .map((q) => q.id)
      .includes("share-investment-event-posts-a-voucher"),
  );
});
