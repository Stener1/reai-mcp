import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The voucher POST among the requests a handler made.
 *
 * reai_create_voucher now reads /api/general-sub-accounts before writing — an account that has
 * sub-accounts requires one on every posting — so `sent[0]` is a GET and indexing by position
 * broke. Selecting by method says what these assertions actually mean.
 */
const postsOf = (sent) => sent.filter((r) => r.method === "POST");
const postOf = (sent) => {
  const hit = postsOf(sent)[0];
  assert.ok(hit, `no POST was sent; got ${sent.map((r) => `${r.method} ${r.path}`).join(", ")}`);
  return hit;
};
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
  classifyTransmission,
  transmittingBodyFields,
  assertTransmitAllowed,
  ExternalSendBlockedError,
  classifyPaymentRouting,
  classifyInvoiceDelivery,
  paymentRoutingFields,
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
  ]) {
    assert.equal(classifyRequest("POST", path), "irreversible", path);
  }
  // /deactivate was in that list and should not have been. It is the exact inverse of
  // activate — the spec says one "marks the subscription active", the other "marks it
  // inactive" — so it is reversible by definition, and it is the action that STOPS
  // unattended invoice issuance. Requiring `full` mode to halt a runaway subscription
  // is the wrong way round.
  assert.equal(classifyRequest("POST", "/api/subscriptions/7/deactivate"), "reversible");
  // Plain subscription master data is still reversible.
  assert.equal(classifyRequest("PUT", "/api/subscriptions/7"), "reversible");
  assert.equal(classifyRequest("DELETE", "/api/subscriptions/7"), "reversible");
});

// This test used to assert that only a literal `true` escalates, and that
// {"sendEhf":"true"} and {"sendEhf":1} were safe. That was written to the wrong
// framework: the comments claimed ASP.NET, but the spec is springdoc-generated and
// the backend is Spring with Jackson, whose default CoercionConfig binds the string
// "true" and the integer 1 to Java `true`. So both of those armed an external send
// the policy scored as sending nothing — and the test locked the gap in place.
test("escalation follows what the value BINDS to, not its JavaScript type", () => {
  for (const body of [
    { sendEhf: false },
    { sendEhf: 0 },
    { sendEhf: "false" },
    { outputMode: "create_order" },
    { outputMode: 0 },
    { sendEhf: null },
    {},
  ]) {
    assert.equal(classifyWithBody("reversible", body), "reversible", JSON.stringify(body));
  }
  for (const body of [
    { sendEhf: true },
    { sendEhf: "true" },
    { sendEhf: "TRUE" },
    { sendEhf: 1 },
    { outputMode: "create_invoice" },
    { outputMode: "CREATE_INVOICE" },
    // Jackson accepts an integer ordinal for an enum unless FAIL_ON_NUMBERS_FOR_ENUMS
    // is set, and it is off by default. outputMode is ["create_order","create_invoice"],
    // so ordinal 1 is create_invoice.
    { outputMode: 1 },
    { automaticBillingGeneration: "true" },
  ]) {
    assert.equal(classifyWithBody("reversible", body), "irreversible", JSON.stringify(body));
  }
});

test("escalation is case-insensitive on the field name", () => {
  assert.equal(classifyWithBody("reversible", { SENDEHF: true }), "irreversible");
  assert.equal(classifyWithBody("reversible", { sendEHF: true }), "irreversible");
});

test("a body with no inspectable object is passed through untouched", () => {
  // [{ sendEhf: true }] used to be in this list, asserting that an array root was
  // ignored. That was the bail-out written down as intent: all three inspectors
  // returned early on an array, so wrapping an escalating field in one defeated them.
  // No operation takes an array root today, but reai_request forwards whatever body it
  // is given, so it would have become live the day ReAI added a bulk endpoint.
  for (const body of [undefined, null, "string", 42, [], [1, 2, 3], [null], [[{ sendEhf: true }]]]) {
    assert.equal(classifyWithBody("reversible", body), "reversible", JSON.stringify(body) ?? "undefined");
  }
});

test("an array body is inspected element by element", () => {
  assert.equal(classifyWithBody("reversible", [{ sendEhf: true }]), "irreversible");
  // Including when only a later element carries it.
  assert.equal(classifyWithBody("reversible", [{ id: 1 }, { sendEhf: "true" }]), "irreversible");
  assert.equal(classifyTransmission("POST", "/api/orders", [{ sendEhf: true }]), "external");
  assert.equal(
    classifyPaymentRouting("reversible", "/api/suppliers/5", [{ iban: "NO9386011117947" }], "PATCH"),
    "irreversible",
  );
  assert.equal(
    classifyInvoiceDelivery("reversible", "/api/orders", [{ invoiceEmail: "a@evil.example" }], false),
    "irreversible",
  );
  // And the error messages still name the fields, deduplicated across elements.
  assert.deepEqual(escalatingBodyFields([{ sendEhf: true }, { sendEhf: true }]), ["sendEhf=true"]);
  assert.deepEqual(paymentRoutingFields([{ iban: "NO93" }, { swiftCode: "DNBANOKK" }]), [
    "iban",
    "swiftCode",
  ]);
});

// Shapes a router discards but a string comparison does not. None is currently
// exploitable — the upstream's StrictHttpFirewall rejects the matrix parameter and the
// doubled slash with 400, and the trailing dot 404s, all verified live — but a
// guarantee that depends on another server rejecting malformed input is borrowed, not
// held: relax that firewall, or put a normalizing proxy in front, and it vanishes with
// nothing here to notice.
test("the classifier does not rely on the upstream rejecting odd path shapes", () => {
  for (const path of [
    "/api/subscriptions/1/generate;a=b",
    "/api/subscriptions/1/generate.",
    "/api/subscriptions/1/generate;jsessionid=x",
  ]) {
    assert.equal(classifyRequest("POST", path), "irreversible", path);
    assert.equal(classifyTransmission("POST", path), "external", path);
  }
  assert.equal(classifyRequest("POST", "/api/agreements/7/sign-request;x"), "irreversible");
  // The attachment-overwrite rule ran on the RAW path with a strict [^/]+, so a doubled
  // slash fell through to the reversible /api/attachments prefix — two matchers
  // disagreeing about one path, which is the shape of every bypass in this file.
  assert.equal(classifyRequest("PUT", "/api/attachments//9"), "irreversible");
  assert.equal(classifyRequest("PUT", "/api/attachments/9;x=1"), "irreversible");
  // Uploading stays additive, and an interior dot in a filename is left alone.
  assert.equal(classifyRequest("POST", "/api/attachments"), "reversible");
  assert.equal(classifyRequest("GET", "/api/attachments/9/view/invoice.pdf"), "read");
  assert.equal(classifyRequest("POST", "/api/customers"), "reversible");
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

test("the predicate map is not a 'field name is present' test", () => {
  // Still guards against regressing to name-presence, but no longer asserts that a
  // case variant is safe. This test used to require outputMode:"CREATE_INVOICE" to
  // stay reversible, which PINNED A BYPASS: ReAI is .NET, System.Text.Json matches
  // enum names case-insensitively, so "CREATE_INVOICE" binds exactly as
  // "create_invoice" does and would have armed recurring invoice issuance while the
  // policy called it reversible.
  assert.equal(classifyWithBody("reversible", { outputMode: "" }), "reversible");
  assert.equal(classifyWithBody("reversible", { outputMode: "create_order" }), "reversible");
  assert.equal(classifyWithBody("reversible", { sendEhf: false }), "reversible");
  assert.equal(classifyWithBody("reversible", { unrelatedField: true }), "reversible");
});

test("a case variant of an escalating value still escalates", () => {
  for (const value of ["create_invoice", "CREATE_INVOICE", "Create_Invoice", "cReAtE_iNvOiCe"]) {
    assert.equal(
      classifyWithBody("reversible", { outputMode: value }),
      "irreversible",
      `outputMode=${value} must escalate`,
    );
  }
  // And the field name binds case-insensitively too, which was already handled.
  assert.equal(classifyWithBody("reversible", { OutputMode: "create_invoice" }), "irreversible");
  assert.equal(classifyWithBody("reversible", { SENDEHF: true }), "irreversible");
});

test("subscription billing is transmission, not merely an irreversible write", async () => {
  // These were classified irreversible but NOT transmitting, so `full` mode alone
  // sent them: /generate bills one subscription, /generate-due bills every due
  // subscription in the tenant, and both issue invoices — which starts delivery.
  const { classifyTransmission } = await import("../dist/policy.js");
  assert.equal(classifyTransmission("POST", "/api/subscriptions/7/generate"), "external");
  assert.equal(classifyTransmission("POST", "/api/subscriptions/generate-due"), "external");
  assert.equal(
    classifyTransmission("POST", "/api/subscriptions", { outputMode: "create_invoice" }),
    "external",
  );
  assert.equal(
    classifyTransmission("POST", "/api/subscriptions", { automaticBillingGeneration: true }),
    "external",
  );
});

test("transmitting operations outside /api/ are covered too", async () => {
  // Every pattern was /api/-anchored while ~100 indexed operations live outside it,
  // reachable through reai_request, which never checks a path against the spec.
  // /salary/{id}/complete is literally the A-melding submission the /api/ pattern
  // guards.
  const { classifyTransmission } = await import("../dist/policy.js");
  for (const path of [
    "/salary/1/complete",
    "/salary/1/register-payment",
    "/ztl/banks/1/approval-reminders",
    "/ztl/banks/1/failed-payment-notifications",
    "/kassasystem/mobile/payment-request",
    "/adyen/payout/session",
    "/cf-worker/email-warning",
    "/vat-return/altinn-sync",
  ]) {
    assert.equal(classifyTransmission("POST", path), "external", `${path} should transmit`);
  }
  // Ordinary local writes are unaffected.
  for (const path of ["/api/customers", "/api/vouchers", "/api/products"]) {
    assert.equal(classifyTransmission("POST", path), "none", `${path} should not transmit`);
  }
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

// --- External transmission -------------------------------------------------
// A separate axis from Risk. Every transmitting endpoint is already
// `irreversible`, so REAI_WRITE_MODE=full -- which an operator sets to permit
// ledger postings -- would otherwise also permit sending EHF invoices to real
// counterparties. A posting can be reversed; a sent invoice cannot be recalled.

test("transmitting paths are recognised", () => {
  for (const path of [
    "/api/peppol/messages/sendsbdh",
    "/api/invoices/1/ehf",
    "/api/invoices/1/email",
    "/api/invoices/1/reminders",
    "/api/invoices/reminders/bulk",
    "/api/agreements/1/sign-request",
    "/api/agreements/1/sign-requests/2/send",
    // Issuing an invoice starts delivery asynchronously.
    "/api/invoices",
  ]) {
    assert.equal(classifyTransmission("POST", path), "external", path);
  }
});

test("ordinary writes and all reads are not transmitting", () => {
  for (const path of [
    "/api/customers",
    "/api/suppliers",
    "/api/vouchers",
    "/api/orders",
    "/api/supplier-invoices",
    "/api/reconciliation-rules",
  ]) {
    assert.equal(classifyTransmission("POST", path), "none", path);
  }
  // Reading an invoice sends nothing, even on a transmitting prefix.
  assert.equal(classifyTransmission("GET", "/api/invoices"), "none");
  assert.equal(classifyTransmission("GET", "/api/peppol/messages"), "none");
});

test("the two GETs that reach outside the tenant are treated as transmitting", () => {
  // GET being a read holds for the whole API bar these two, and this assertion used to
  // say phase4ping sends nothing. It is an AS4 ping onto the Peppol network; the other
  // synchronises with Altinn. read-only is the mode people point at a live business,
  // so it is exactly where they should not slip through.
  //
  // Neither carries a description in the spec, so the effect is inferred from the path
  // and its controller rather than documented — erring toward "this leaves the tenant"
  // is the safe direction.
  assert.equal(classifyTransmission("GET", "/api/peppol/messages/phase4ping"), "external");
  assert.equal(classifyTransmission("GET", "/vat-return/altinn-sync"), "external");
});

test("sendEhf in the body makes an otherwise local write transmitting", () => {
  assert.equal(classifyTransmission("POST", "/api/orders"), "none");
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: true }), "external");
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: false }), "none");
  // "true" binds to Java true under Jackson, so it transmits — see the binding test.
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: "true" }), "external");
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: 1 }), "external");
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: "false" }), "none");
  assert.deepEqual(transmittingBodyFields({ sendEhf: true }), ["sendEhf=true"]);
  assert.deepEqual(transmittingBodyFields({ sendEhf: false }), []);
});

test("transmission cannot be smuggled through a traversal path", () => {
  // The write classifier canonicalizes; this must too, or "/api/customers/../invoices/1/ehf"
  // would read as a customer write that sends an EHF invoice.
  assert.equal(classifyTransmission("POST", "/api/customers/../invoices/1/ehf"), "external");
  assert.equal(classifyTransmission("POST", "/api/customers/../invoices"), "external");
});

test("assertTransmitAllowed gates on the flag, not on the write mode", () => {
  assert.doesNotThrow(() => assertTransmitAllowed("none", false, "POST /api/customers"));
  assert.doesNotThrow(() => assertTransmitAllowed("external", true, "POST /api/invoices/1/ehf"));

  try {
    assertTransmitAllowed("external", false, "POST /api/invoices/1/ehf");
    assert.fail("expected ExternalSendBlockedError");
  } catch (err) {
    assert.ok(err instanceof ExternalSendBlockedError);
    assert.match(err.message, /REAI_ALLOW_EXTERNAL_SEND/);
    // The refusal must read as configuration, not as a prohibition: sending
    // invoices is the point of an accounting system.
    assert.match(err.message, /ordinary configuration|the point of an accounting system/i);
  }
});

test("the two axes are genuinely independent", () => {
  // full write mode still cannot transmit...
  assert.throws(
    () => assertTransmitAllowed("external", false, "POST /api/invoices/1/ehf"),
    ExternalSendBlockedError,
  );
  // ...and external send does not loosen the write policy.
  assert.throws(
    () => assertAllowed("irreversible", "reversible", "POST /api/vouchers"),
    WriteBlockedError,
  );
});

test("invoice sub-operations that are local bookkeeping do not count as sending", () => {
  // A prefix on /api/invoices swept these in, so `full` plus no-external-send
  // could not register a payment or apply a credit note — ordinary
  // customer-ledger work with no communication involved.
  for (const path of [
    "/api/invoices/9/payments",
    "/api/invoices/9/refunds",
    "/api/invoices/9/rounding-adjustment",
    "/api/invoices/9/manual-credit-note-applications",
  ]) {
    assert.equal(classifyTransmission("POST", path), "none", path);
  }
});

test("the transmitting invoice sub-operations still are", () => {
  for (const path of [
    "/api/invoices/9/ehf",
    "/api/invoices/9/email",
    "/api/invoices/9/reminders",
    // Crediting "starts credit note delivery asynchronously".
    "/api/invoices/9/credit",
    "/api/invoices/reminders/bulk",
  ]) {
    assert.equal(classifyTransmission("POST", path), "external", path);
  }
});

test("filings with the government count as sending", () => {
  // As external as it gets. The tax return has no idempotency guard, so a
  // repeated call re-files.
  assert.equal(classifyTransmission("POST", "/api/tax-returns/2026/submit"), "external");
  assert.equal(classifyTransmission("POST", "/api/salary-payments/3/complete"), "external");
  assert.equal(classifyTransmission("POST", "/api/amelding/1/feedback-raw"), "external");

  // Validating a tax return is a dry run, and marking a VAT period completed
  // records that it was filed elsewhere — neither sends anything.
  assert.equal(classifyTransmission("POST", "/api/tax-returns/2026/validate"), "none");
  assert.equal(classifyTransmission("POST", "/api/vat-returns/complete-manually"), "none");
});

test("voucher rows follow the API's pairing rule, not description grouping", async () => {
  // The spec requires a matched debit+credit of equal absolute amount to share ONE
  // row, and a row to hold at most one debit and one credit. The previous model
  // grouped by description, which split matched pairs and left multi-debit vouchers
  // unnumbered. Verified through the real handler, so the body actually sent is what
  // is asserted.
  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_create_voucher");
  assert.ok(tool, "reai_create_voucher should exist");

  const sent = [];
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 1 },
    session: {},
    client: {
      request: async (opts) => {
        sent.push(opts);
        return { status: 201, data: { id: 1, number: "MV1-2026" } };
      },
      deepLink: () => "https://app.reai.no/",
    },
  };

  // A matched pair sharing a description stays in one row. (An earlier version of this
  // test claimed the same held with DIFFERING descriptions; the live API rejects that
  // outright — see the assignRowNumbers test in writes.test.mjs for its exact words.)
  await tool.handler(
    {
      date: "2026-08-06",
      postings: [
        { accountNumber: "1576", amount: 1, description: "same" },
        { accountNumber: "1580", amount: -1, description: "same" },
      ],
    },
    ctx,
  );
  let rows = postOf(sent).body.postings.map((p) => p.rowNumber);
  assert.equal(rows[0], rows[1], "a matched pair must share a row");

  // ...and a three-posting purchase voucher gets a row per posting, so no row holds
  // two debits.
  sent.length = 0;
  await tool.handler(
    {
      date: "2026-08-06",
      postings: [
        { accountNumber: "6700", amount: 800, description: "Kjøp" },
        { accountNumber: "2710", amount: 200, description: "Kjøp" },
        { accountNumber: "2400", amount: -1000, description: "Kjøp" },
      ],
    },
    ctx,
  );
  rows = postOf(sent).body.postings.map((p) => p.rowNumber);
  assert.equal(new Set(rows).size, 3, `expected three rows, got ${rows.join(",")}`);

  // A matched pair whose descriptions differ is given SEPARATE rows and sent. It used
  // to be refused locally, on the reasoning that a row carries one description and the
  // pair could not be split — but splitting is exactly what the API accepts, so refusing
  // turned a workable voucher into a dead end.
  sent.length = 0;
  const split = await tool.handler(
    {
      date: "2026-08-06",
      postings: [
        { accountNumber: "1576", amount: 5, description: "aaa" },
        { accountNumber: "1580", amount: -5, description: "bbb" },
      ],
    },
    ctx,
  );
  assert.equal(split.isError, undefined, "differing descriptions are not an error on their own");
  assert.equal(postsOf(sent).length, 1, "it should be sent, in two rows");
  const splitRows = postOf(sent).body.postings.map((p) => p.rowNumber);
  assert.notEqual(splitRows[0], splitRows[1], `expected two rows, got ${splitRows.join(",")}`);

  // But when the CALLER pins both to one row, that is a request the API will reject —
  // "a rowNumber holds at most one debit and one credit side, both with the same date,
  // description, currency and absolute amount" — so it is still refused locally, with
  // the reason, rather than sent to fail.
  sent.length = 0;
  const conflict = await tool.handler(
    {
      date: "2026-08-06",
      postings: [
        { accountNumber: "1576", amount: 5, description: "aaa", rowNumber: 0 },
        { accountNumber: "1580", amount: -5, description: "bbb", rowNumber: 0 },
      ],
    },
    ctx,
  );
  assert.equal(postsOf(sent).length, 0, "nothing should be sent when the caller pins a conflicting row");
  const text = conflict.content.map((c) => c.text).join("\n");
  assert.match(text, /must share a description/);
  assert.match(text, /Nothing was sent to ReAI/);
});

test("anything creatable in reversible mode is also deletable in it", async () => {
  // `reversible` is documented as "reads, plus master data that can be cleanly
  // deleted". It shipped registering create tools for products, orders, offers and
  // company bank accounts with no way to remove any of them — found by walking a
  // session as an agent would: it drafted an offer and then had nothing to call.
  //
  // The DELETE endpoints existed and classified as reversible the whole time, so the
  // capability was permitted; only the curated tool was missing, which left the
  // agent to discover the escape hatch to undo what the default mode had just
  // encouraged.
  const { allTools } = await import("../dist/server.js");
  const { isAllowed } = await import("../dist/policy.js");

  const visible = allTools.filter((t) => isAllowed(t.risk, "reversible"));
  const names = new Set(visible.map((t) => t.name));
  const gaps = visible
    .filter((t) => t.name.startsWith("reai_create_"))
    .filter((t) => !names.has(t.name.replace("reai_create_", "reai_delete_")))
    .map((t) => t.name);

  assert.deepEqual(
    gaps,
    [],
    `these can be created in the default mode but not removed in it:\n  ${gaps.join("\n  ")}`,
  );
});

test("every delete tool's endpoint is classified no worse than the tool claims", async () => {
  // A delete tool advertising `reversible` while its path classifies irreversible
  // would be registered in the default mode and then refused at call time.
  const { allTools } = await import("../dist/server.js");
  const { classifyRequest, isAllowed } = await import("../dist/policy.js");

  // The narrowest write mode that permits a given risk. "irreversible" is a RISK,
  // not a mode — passing it as one is how this test first failed.
  const minimumMode = { read: "read-only", reversible: "reversible", irreversible: "full" };

  for (const tool of allTools.filter((t) => t.name.startsWith("reai_delete_"))) {
    const mode = minimumMode[tool.risk];
    assert.ok(mode, `${tool.name} has an unrecognised risk "${tool.risk}"`);
    for (const [method, path] of tool.apiPaths ?? []) {
      const risk = classifyRequest(method, path);
      assert.ok(
        isAllowed(risk, mode),
        `${tool.name} declares risk="${tool.risk}" (registered in ${mode} mode) but ` +
          `${method} ${path} classifies "${risk}", so calling it would be refused`,
      );
    }
  }
});

test("changing a counterparty's bank details escalates; changing its name does not", async () => {
  // `reversible` means "master data that can be cleanly deleted", and that criterion
  // does not describe "redirects a future payment". The record can be put back; the
  // transfer cannot, and it happens later, through a legitimate action by a person in
  // the ReAI UI — entirely outside anything this policy observes. So a prompt-injected
  // agent in the DEFAULT configuration could repoint a supplier's account.
  const { classifyRequest, classifyPaymentRouting, paymentRoutingFields } = await import("../dist/policy.js");
  const risk = (method, path, body, forwarded) =>
    classifyPaymentRouting(classifyRequest(method, path), path, body, forwarded);

  assert.equal(risk("PATCH", "/api/suppliers/1", { name: "New name" }), "reversible");
  assert.equal(risk("PATCH", "/api/suppliers/1", { bankAccountNumber: "15039012345" }), "irreversible");
  assert.equal(risk("PATCH", "/api/suppliers/1", { IBAN: "NO9386011117947" }), "irreversible");
  assert.equal(risk("PUT", "/api/creditors/1", { bankAccountNumber: "x" }), "irreversible");
  assert.equal(risk("PATCH", "/api/customers/1", { iban: "NO93" }), "irreversible");

  // An empty value is not a repoint.
  assert.equal(risk("PATCH", "/api/suppliers/1", { iban: "" }), "reversible");
  assert.equal(risk("PATCH", "/api/suppliers/1", { iban: null }), "reversible");

  // Registering the company's OWN bank account carries a swiftCode and is ordinary
  // work in the default mode — this must stay path-scoped, not field-only.
  //
  // The METHOD has to be passed for that exemption to apply, and this assertion used to
  // omit it and pass anyway: the exemption was written as a condition for entering scope,
  // so an unknown method left the path out of scope entirely and fell through to
  // "reversible". That is failing OPEN on a payment-routing path, which is the opposite of
  // this classifier's stated default. Company banks are now in scope like every other
  // inward-facing path, with POST exempted, so an unknown method fails closed instead.
  // Every real caller passes the method — the escape hatch and curatedArgsEscalate both do.
  assert.equal(
    risk("POST", "/api/company-banks", { swiftCode: "DNBANOKK", bban: "15201353103" }, "POST"),
    "reversible",
  );
  assert.equal(
    risk("POST", "/api/company-banks", { bban: "15201353103" }),
    "irreversible",
    "with no method to check the exemption against, the strict reading is the safe one",
  );

  assert.deepEqual(paymentRoutingFields({ name: "x", iban: "NO93" }), ["iban"]);
  assert.deepEqual(paymentRoutingFields({ name: "x" }), []);
});

test("overwriting an attachment is irreversible; uploading one is not", async () => {
  // The spec: "Replacing content updates the bytes for every owner that references
  // this attachment id." So overwriting the file on a posted voucher destroys the
  // documentation of every voucher pointing at it, and no DELETE exists under
  // /api/attachments to undo it. It sat in the tier whose criterion is "can be
  // cleanly deleted".
  const { classifyRequest } = await import("../dist/policy.js");
  assert.equal(classifyRequest("PATCH", "/api/attachments/1"), "irreversible");
  assert.equal(classifyRequest("PUT", "/api/attachments/1"), "irreversible");
  // Uploading a NEW attachment is additive, so a path prefix would have been too
  // blunt — it briefly made this irreversible too, which a test caught.
  assert.equal(classifyRequest("POST", "/api/attachments"), "reversible");
  assert.equal(classifyRequest("GET", "/api/attachments/1/content"), "read");
});

test("an inventory adjustment is irreversible", async () => {
  // quantityChange and unitCost restate stock quantity and valuation, which is a
  // balance-sheet input, and the only correction is an offsetting adjustment — the
  // same reverse-don't-delete property that puts vouchers in this tier.
  const { classifyRequest } = await import("../dist/policy.js");
  assert.equal(classifyRequest("POST", "/api/warehouses/inventory/adjust"), "irreversible");
  // Creating a warehouse is ordinary master data.
  assert.equal(classifyRequest("POST", "/api/warehouses"), "reversible");
});

test("open-item queries widen the date window; ordinary ones do not", async () => {
  // Three endpoints return only records "with activity in the period" and default to a
  // one-year or current-year window, so the open-item question — which orders are
  // unbilled, what have we not reimbursed, what do we still owe — silently omitted
  // anything older. Same shape as the customer-ledger bug that was already fixed; the
  // rest were missed.
  const { allTools } = await import("../dist/server.js");
  const sent = [];
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 1 },
    session: {},
    client: {
      request: async (opts) => {
        sent.push(opts);
        return { status: 200, data: [] };
      },
      deepLink: () => "https://app.reai.no/",
    },
  };

  const cases = [
    ["reai_list_orders", { status: "open" }, { status: "all" }],
    ["reai_list_expenses", { paidOut: "false" }, { paidOut: "true" }],
    ["reai_supplier_ledger", { isUnpaid: true }, {}],
  ];
  for (const [name, openArgs, plainArgs] of cases) {
    const tool = allTools.find((t) => t.name === name);
    assert.ok(tool, `${name} should exist`);

    sent.length = 0;
    await tool.handler(openArgs, ctx);
    assert.equal(sent[0].query.startDate, "2000-01-01", `${name} should widen for open items`);

    sent.length = 0;
    await tool.handler(plainArgs, ctx);
    assert.notEqual(sent[0].query.startDate, "2000-01-01", `${name} should not widen otherwise`);

    // An explicit start date always wins.
    sent.length = 0;
    await tool.handler({ ...openArgs, startDate: "2026-06-01" }, ctx);
    assert.equal(sent[0].query.startDate, "2026-06-01", `${name} must respect an explicit date`);
  }
});

test("date defaults follow Norway, not UTC", async () => {
  // toISOString() is UTC, so between midnight and 01:00/02:00 Norwegian time every
  // default was a day early. At 00:30 on 1 January that stamps an order 31 December of
  // the year just ended, posting revenue and VAT into a period that may be closed.
  const { norwegianDate } = await import("../dist/tools/registry.js");
  assert.equal(norwegianDate(new Date("2025-12-31T23:30:00Z")), "2026-01-01");
  assert.equal(norwegianDate(new Date("2026-06-15T23:30:00Z")), "2026-06-16");
  assert.equal(norwegianDate(new Date("2026-06-15T09:00:00Z")), "2026-06-15");
  assert.match(norwegianDate(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});

test("voucher amounts finer than øre are refused, as are all-zero vouchers", async () => {
  // The balance check rounded the SUM, not the postings, so 100.002 + (-99.998) — a
  // real 0.004 imbalance — was reported as balanced. Every money field in the API is
  // multipleOf 0.01, and ReAI rounding each posting silently changes both sides.
  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_create_voucher");
  const sent = [];
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 1 },
    session: {},
    client: {
      request: async (opts) => {
        sent.push(opts);
        return { status: 201, data: { id: 1 } };
      },
      deepLink: () => "https://app.reai.no/",
    },
  };
  const run = async (postings) => {
    sent.length = 0;
    const res = await tool.handler({ date: "2026-08-06", postings }, ctx);
    // WRITES, not requests: reai_create_voucher reads /api/general-sub-accounts before writing, so
    // a refused voucher still shows one GET.
    return {
      sent: postsOf(sent).length,
      text: res.content.map((c) => c.text).join("\n"),
      isError: res.isError,
    };
  };

  const subOre = await run([
    { accountNumber: "1500", amount: 100.002 },
    { accountNumber: "3000", amount: -99.998 },
  ]);
  assert.equal(subOre.sent, 0, "a sub-øre amount must not be sent");
  assert.match(subOre.text, /whole øre/);

  const zero = await run([
    { accountNumber: "1500", amount: 0 },
    { accountNumber: "3000", amount: 0 },
  ]);
  assert.equal(zero.sent, 0);
  assert.match(zero.text, /record nothing/);

  // Genuine øre amounts still work, and a real imbalance is still caught.
  const valid = await run([
    { accountNumber: "1500", amount: 0.01 },
    { accountNumber: "3000", amount: -0.01 },
  ]);
  assert.equal(valid.sent, 1);

  const unbalanced = await run([
    { accountNumber: "1500", amount: 100 },
    { accountNumber: "3000", amount: -99 },
  ]);
  assert.equal(unbalanced.sent, 0);
  assert.match(unbalanced.text, /not balanced/);
});

// invoiceEmail redirects where every future invoice is delivered: reversible as a
// record, permanent as a disclosure, and realised later when someone issues an
// invoice normally. It is NOT a payment field, and reporting it as one told the agent
// the wrong consequence and the wrong thing to verify — so it is classified
// separately, and scoped more widely: CreateOrderReq, UpdateOrderReq and
// SubscriptionWriteReq all accept it, so an address set on an order or a subscription
// reaches the same disclosure through a different door.
test("redirecting invoice delivery is irreversible wherever the field is accepted", async () => {
  const { classifyInvoiceDelivery } = await import("../dist/policy.js");
  const evil = { invoiceEmail: "attacker@evil.example" };
  for (const path of [
    "/api/customers/5",
    "/api/orders",
    "/api/orders/9",
    "/api/subscriptions",
    "/api/subscriptions/3",
  ]) {
    assert.equal(
      classifyInvoiceDelivery("reversible", path, evil, false),
      "irreversible",
      `${path} should escalate on invoiceEmail`,
    );
  }
  // Unrelated paths and unrelated fields are untouched.
  assert.equal(classifyInvoiceDelivery("reversible", "/api/orders", { customerId: 1 }, false), "reversible");
  assert.equal(classifyInvoiceDelivery("reversible", "/api/vouchers", evil, false), "reversible");
  // A whitespace-only address is not a NEW address, so it does not escalate as one — but naming the
  // field with a value that empties it is a delivery change in its own right, and on a method that
  // can overwrite what is stored it escalates for that reason instead. Measured: the API answers 400
  // to a space, so the call fails either way; the classification just says which risk it carried.
  assert.equal(classifyInvoiceDelivery("reversible", "/api/customers", { invoiceEmail: "  " }, false), "reversible");
  assert.equal(classifyInvoiceDelivery("reversible", "/api/customers/5", { invoiceEmail: "  " }, true), "irreversible");
});

test("payment routing and invoice delivery give different reasons", async () => {
  const { curatedArgsEscalate } = await import("../dist/policy.js");
  const pay = curatedArgsEscalate([["PATCH", "/api/suppliers/{id}"]], { id: 1, iban: "NO93" });
  const mail = curatedArgsEscalate([["PATCH", "/api/customers/{id}"]], { id: 1, invoiceEmail: "a@b.c" });
  assert.match(pay.consequence, /where money is sent/);
  assert.match(pay.verify, /bank details/);
  assert.match(mail.consequence, /where invoices are delivered/);
  assert.ok(!/money/.test(mail.consequence), `an email address is not a payment: ${mail.consequence}`);
  assert.match(mail.verify, /channel you already trust/);
});

// Annotations are per tool and cannot vary per invocation, so a tool that is ordinary
// for most fields and irreversible for a few must be annotated for the worst call it
// can make. In `full` mode the call is permitted, and a client's confirmation prompt
// is then the only thing left protecting it.
test("a tool with escalating fields is annotated destructive", async () => {
  const { allTools } = await import("../dist/server.js");
  const { hasEscalatingFields, destructiveHintFor } = await import("../dist/server.js");
  let escalating = 0;
  let mixed = 0;
  for (const tool of allTools) {
    // The REAL probe, which also looks inside object-valued arguments. The local
    // reimplementation this used to carry could not see a routing field nested in a `changes`
    // record — the hole that shipped reai_update_agreement with destructiveHint: false.
    if (!hasEscalatingFields(tool)) continue;
    escalating += 1;
    // NOT asserted here: that the tool also carries a static `destructive` flag. The server
    // computes the hint as `destructive || risk === "irreversible" || hasEscalatingFields`, so an
    // escalating tool is annotated by construction and demanding the flag as well would be
    // redundant — reai_create_customer is correctly annotated without one.
    //
    // That argument leans on the formula, so the formula is asserted directly, below and in the
    // next test. An earlier version of this comment claimed toolsets.test.mjs pinned it; it did
    // not — it drives hasEscalatingFields and never reads the annotation, and reducing the
    // server's expression to `tool.destructive === true` left the entire suite green.
    assert.equal(
      destructiveHintFor(tool),
      true,
      `${tool.name} can escalate, so the published destructiveHint must be true`,
    );
    // "Mixed-risk" — ordinary for most fields, worse for a few — is the case the annotation was
    // introduced for, and it must keep existing. But it is not the only case: a tool whose PATH
    // is already irreversible can carry an escalating field too, with nothing left to escalate.
    // reai_update_creditor is exactly that, and asserting risk === "reversible" for everything
    // made it a failure rather than a category.
    if (tool.risk === "reversible") mixed += 1;
  }
  // Near the real census (16 escalating, 11 mixed at the time of writing) rather than the ~5x
  // slack the old floors carried: with `>= 3` this could have lost thirteen tools and stayed green,
  // which makes the count decorative rather than a guard.
  assert.ok(escalating >= 14, `expected ~16 tools with escalating fields, found ${escalating}`);
  assert.ok(mixed >= 9, `expected ~11 mixed-risk tools, found ${mixed}`);
});

/**
 * The annotation the server actually publishes, for EVERY tool.
 *
 * The test above argues that a static `destructive` flag would be redundant given the formula.
 * Nothing read the formula, so reducing it to `tool.destructive === true` — dropping both the
 * irreversible and the escalating-fields terms — left 471 tests green while three tools silently
 * became non-destructive. This pins each term by the property it exists for.
 */
test("the published destructiveHint covers irreversible, destructive and escalating tools", async () => {
  const { allTools, destructiveHintFor, hasEscalatingFields } = await import("../dist/server.js");
  const byTerm = { irreversible: 0, flagged: 0, escalating: 0 };
  for (const tool of allTools) {
    if (tool.risk === "irreversible") {
      byTerm.irreversible += 1;
      assert.equal(destructiveHintFor(tool), true, `${tool.name} is irreversible`);
    }
    if (tool.destructive === true) {
      byTerm.flagged += 1;
      assert.equal(destructiveHintFor(tool), true, `${tool.name} is flagged destructive`);
    }
    if (hasEscalatingFields(tool)) {
      byTerm.escalating += 1;
      assert.equal(destructiveHintFor(tool), true, `${tool.name} can escalate`);
    }
    // And a tool that is none of the three must NOT be annotated, or the hint says nothing.
    if (tool.risk !== "irreversible" && tool.destructive !== true && !hasEscalatingFields(tool)) {
      assert.equal(destructiveHintFor(tool), false, `${tool.name} is ordinary`);
    }
  }
  // Each term must have something to cover, or dropping it would go unnoticed — which is how
  // this hole existed in the first place.
  for (const [term, count] of Object.entries(byTerm)) {
    assert.ok(count > 0, `no tool exercises the ${term} term of the annotation`);
  }
});

// Reading the path as a router would must never produce a WEAKER answer than reading it
// literally. The first attempt at this fix substituted the routed form outright, on the
// premise that stripping can only make a path match a pattern it otherwise missed. That
// premise is false: a path matching no prefix fails CLOSED as irreversible, and
// stripping can make it match a reversible one. Three shapes came out weaker than
// before, which is why every guard now takes the stricter of both readings.
test("normalizing a path never lowers its risk", () => {
  for (const [method, path] of [
    // Fell through to fail-closed unrecognised; stripping made it match /api/suppliers.
    ["PATCH", "/api/suppliers;foo/5"],
    ["PUT", "/api/accountant-clients;foo/999/business-description"],
    // A dot-only segment emptied by an over-eager strip shortens the path and can drop a
    // pattern match: /api/invoices/.../email lost its transmission match entirely.
    ["POST", "/api/invoices/.../email"],
    ["PATCH", "/api/attachments/..."],
    ["POST", "/api/subscriptions/.../generate"],
  ]) {
    assert.equal(
      classifyRequest(method, path),
      "irreversible",
      `${method} ${path} must not be weakened by normalization`,
    );
  }
  assert.equal(classifyTransmission("POST", "/api/invoices/.../email"), "external");

  // The guards that take the path separately must agree, or a shape lands in the gap
  // between them: classifyRequest saying "reversible" while payment routing does not
  // recognise the path is exactly how an iban would slip through.
  assert.equal(
    classifyPaymentRouting("reversible", "/api/suppliers;foo/5", { iban: "NO9386011117947" }, "PATCH"),
    "irreversible",
  );
  assert.equal(
    classifyInvoiceDelivery("reversible", "/api/orders;x", { invoiceEmail: "a@evil.example" }, false),
    "irreversible",
  );
});

// The policy was refusing the actions that REDUCE risk, alongside the ones that create
// it. Direction matters: stopping a runaway subscription and revoking a pending
// signature are the safe moves, and needing `full` mode for them is backwards.
test("an action that undoes a risk is not gated like the risk itself", () => {
  // Deactivate is the exact inverse of activate — the spec says one "marks the
  // subscription active" and the other "marks it inactive". Activate stays irreversible
  // because it starts unattended invoice issuance; stopping that must not need `full`.
  assert.equal(classifyRequest("POST", "/api/subscriptions/1/deactivate"), "reversible");
  assert.equal(classifyRequest("POST", "/api/subscriptions/1/activate"), "irreversible");

  // Deleting a pending signer "invalidates its signing link" — it sends nothing. The
  // transmitting pattern is matched without regard to method, so it caught the
  // revocation along with the send, and you could email a signing request and then be
  // unable to revoke it without enabling external send.
  assert.equal(classifyTransmission("DELETE", "/api/agreements/1/sign-requests/2"), "none");
  assert.equal(classifyTransmission("POST", "/api/agreements/1/sign-requests"), "external");
  assert.equal(classifyTransmission("POST", "/api/agreements/1/sign-request"), "external");
  // It is still irreversible: a deleted signer cannot be restored, and deleting the
  // last pending one can complete the agreement.
  assert.equal(classifyRequest("DELETE", "/api/agreements/1/sign-requests/2"), "irreversible");
});
/**
 * Emptying an invoice-delivery address is the same axis as setting one — in a PARTIAL body.
 *
 * The gate was presence-based, so it read one direction only: `invoiceEmail: "attacker@evil.example"`
 * escalated and needed `full` mode, while `invoiceEmail: ""` stayed `reversible` and went through in
 * the default mode. It was reachable through a CURATED tool, not just the escape hatch:
 * reai_update_customer is declared reversible, accepts invoiceEmail as a plain string, forwards ""
 * unchanged, and "" is the form measured to clear the stored address on PATCH /api/customers/{id}.
 *
 * The `partialBody` distinction is not decoration. Without it, every possible body for
 * PUT /api/orders/{id} escalated — omit the optional field and a replacement empties it, name it and
 * it is either a new address or an empty one — which left an agent in the default mode no way to edit
 * an order at all, there being no curated order-update tool. Review caught that.
 */
test("emptying an invoice-delivery address escalates when the body is partial", async () => {
  const { classifyInvoiceDelivery } = await import("../dist/policy.js");
  for (const path of ["/api/customers/5", "/api/orders/9", "/api/subscriptions/3"]) {
    for (const value of ["", null, "   "]) {
      assert.equal(
        classifyInvoiceDelivery("reversible", path, { name: "X", invoiceEmail: value }, true),
        "irreversible",
        `${path} with ${JSON.stringify(value)}`,
      );
    }
  }
});

test("a value that stringifies blank counts as emptying, whatever its type", async () => {
  const { classifyInvoiceDelivery, invoiceDeliveryClearedFields } = await import("../dist/policy.js");
  // The two halves of the axis have to be complementary, or a value falls between them and the gate
  // calls it neither direction. presentFields excludes anything blank once stringified, so "cleared"
  // must admit everything else a present key can hold. Review found the gap with these two.
  // Not `{}` — that stringifies to "[object Object]", so presentFields already counts it as a value
  // being SET and the axis escalates on the other branch. Complementary, which is the property.
  for (const value of [[], [""], ["  "]]) {
    assert.deepEqual(invoiceDeliveryClearedFields({ invoiceEmail: value }), ["invoiceEmail"], JSON.stringify(value));
    assert.equal(
      classifyInvoiceDelivery("reversible", "/api/customers/5", { invoiceEmail: value }, true),
      "irreversible",
      JSON.stringify(value),
    );
  }
});

test("a REPLACEMENT body that names an empty address does not escalate, and that is deliberate", async () => {
  const { classifyInvoiceDelivery } = await import("../dist/policy.js");
  const order = { customerId: 1, currencyCode: "NOK", daysUntilDue: 14, issueDate: "2026-01-01", orderLines: [] };
  // In a whole-record body an empty invoiceEmail cannot be told apart from faithfully carrying back
  // an address that is already empty — the common case, and exactly what reai_request tells callers
  // to do. Escalating it made PUT /api/orders/{id} refuse EVERY possible body in the default mode.
  for (const body of [order, { ...order, invoiceEmail: null }, { ...order, invoiceEmail: "" }]) {
    assert.equal(
      classifyInvoiceDelivery("reversible", "/api/orders/9", body, false),
      "reversible",
      JSON.stringify(body).slice(0, 60),
    );
  }
  // Setting a NEW address in the same body still escalates, which is the pre-existing half.
  assert.equal(
    classifyInvoiceDelivery("reversible", "/api/orders/9", { ...order, invoiceEmail: "new@example.com" }, false),
    "irreversible",
  );
});

test("the clearing rule does not fire where there is nothing to redirect", async () => {
  const { classifyInvoiceDelivery } = await import("../dist/policy.js");
  // A create cannot redirect an existing address. Its body is not partial either, so both readings
  // agree here — asserted anyway, because a POST naming an empty address is the case a caller would
  // most reasonably expect to be ordinary work.
  for (const value of ["", null]) {
    assert.equal(
      classifyInvoiceDelivery("reversible", "/api/orders", { customerId: 1, invoiceEmail: value }, false),
      "reversible",
      JSON.stringify(value),
    );
  }
  // Out of scope entirely: the field is only about delivery on customers, orders and subscriptions.
  assert.equal(classifyInvoiceDelivery("reversible", "/api/vouchers", { invoiceEmail: "" }, true), "reversible");
  // And an already-irreversible path is returned untouched, so nothing below can weaken it.
  assert.equal(classifyInvoiceDelivery("irreversible", "/api/customers/5", { invoiceEmail: "" }, true), "irreversible");
});

test("the refusal says which direction the delivery change goes", async () => {
  const { invoiceDeliveryChanges } = await import("../dist/policy.js");
  assert.deepEqual(invoiceDeliveryChanges({ invoiceEmail: "new@example.com" }, true), [
    "invoiceEmail set to a new address",
  ]);
  assert.deepEqual(invoiceDeliveryChanges({ invoiceEmail: "" }, true), ["invoiceEmail emptied"]);
  // In a replacement body an empty value is not reported as a change, because it is not known to be
  // one — the same reason it does not escalate.
  assert.deepEqual(invoiceDeliveryChanges({ invoiceEmail: "" }, false), []);
  assert.deepEqual(invoiceDeliveryChanges({ invoiceEmail: "new@example.com" }, false), [
    "invoiceEmail set to a new address",
  ]);
});

test("the curated tool that could clear a delivery address in the default mode no longer can", async () => {
  const { curatedArgsEscalate } = await import("../dist/policy.js");
  const { registeredTools } = await import("../dist/server.js");
  const tool = registeredTools.find((t) => t.name === "reai_update_customer");
  assert.ok(tool, "reai_update_customer should exist");
  // The exposure, precisely: the schema accepts "" and the handler forwards it unchanged.
  assert.equal(tool.inputSchema.invoiceEmail.safeParse("").success, true);
  assert.equal(tool.risk, "reversible");

  const cleared = curatedArgsEscalate(tool.apiPaths, { invoiceEmail: "" });
  assert.ok(cleared, "clearing through a curated tool must escalate");
  assert.ok(cleared, "clearing an address must escalate");
  assert.equal(cleared.risk, "irreversible");
  assert.deepEqual(cleared.fields, ["invoiceEmail"]);
  assert.match(cleared.consequence, /empties where invoices are delivered/);
  assert.match(cleared.verify, /why it is there before removing it/);

  // Setting one still reads as setting one, not as emptying it.
  const set = curatedArgsEscalate(tool.apiPaths, { invoiceEmail: "new@example.com" });
  assert.match(set.consequence, /every future invoice goes to that address/);
  assert.ok(!/empties/.test(set.consequence));

  // A curated tool's arguments are always partial, whatever HTTP method it uses underneath — so
  // reai_update_subscription escalates too, even though its endpoint is a PUT.
  const subscription = registeredTools.find((t) => t.name === "reai_update_subscription");
  assert.deepEqual(subscription.apiPaths.map(([m]) => m).includes("PUT"), true, "it is a PUT underneath");
  assert.ok(curatedArgsEscalate(subscription.apiPaths, { invoiceEmail: "" }), "still escalates on args");

  // But a create tool is untouched, because it has no stored address to redirect.
  const create = registeredTools.find((t) => t.name === "reai_create_subscription");
  assert.equal(curatedArgsEscalate(create.apiPaths, { invoiceEmail: "" }), undefined);
  assert.ok(curatedArgsEscalate(create.apiPaths, { invoiceEmail: "x@y.no" }), "setting one still escalates");
});

test("the quirk records which value actually clears, since it is the counterintuitive one", async () => {
  const { quirksFor } = await import("../dist/reai/quirks.js");
  const quirk = quirksFor("PATCH", "/api/customers/{id}").find(
    (q) => q.id === "invoice-email-is-cleared-by-an-empty-string-not-by-null",
  );
  assert.ok(quirk, "the quirk should reach the endpoint it is about");
  assert.match(quirk.note, /EMPTY STRING/);
  assert.match(quirk.note, /no-op that left the address in place/);
  assert.match(quirk.note, /400/);
  assert.match(quirk.note, /REAI_WRITE_MODE=full/);
  // A read cannot redirect anything, so it must not carry this.
  assert.ok(
    !quirksFor("GET", "/api/customers/{id}").some(
      (q) => q.id === "invoice-email-is-cleared-by-an-empty-string-not-by-null",
    ),
  );
});

/**
 * Whose write ceiling applies, when the grant and the operator disagree.
 *
 * This is the most consequential decision in remote mode and it had nothing testing it. A grant is
 * sealed at authorization time — unforgeable, but minted then and refreshable for weeks — while the
 * operator's REAI_WRITE_MODE is whatever the deployment is running now. Every request takes the
 * narrower of the two, which has to hold in both directions:
 *
 *   - An operator who redeploys with a tighter mode must have it apply immediately, to tokens that
 *     already exist. Otherwise tightening the deployment does nothing until every grant expires, and
 *     rotating the encryption key is the only real remedy.
 *   - A user who narrowed their own grant on the consent page must never be widened back by a
 *     permissive server.
 *
 * The helper was module-private in src/http.ts, which exports nothing and is spawned as a process, so
 * reaching it meant starting a real server. It now lives in policy.ts beside strictestRisk.
 */
test("the effective write ceiling is the narrower of the grant and the operator's", async () => {
  const { narrowerWriteMode } = await import("../dist/policy.js");
  const cases = [
    // grant, server, expected
    ["full", "reversible", "reversible"], // the operator tightened after the grant was issued
    ["full", "read-only", "read-only"],
    ["reversible", "full", "reversible"], // the user narrowed their own grant
    ["read-only", "full", "read-only"],
    ["reversible", "read-only", "read-only"],
    ["full", "full", "full"],
    ["read-only", "read-only", "read-only"],
  ];
  for (const [grant, server, expected] of cases) {
    assert.equal(
      narrowerWriteMode(grant, server),
      expected,
      `grant ${grant} on a ${server} server should serve ${expected}`,
    );
    // Symmetric: which argument is which must not matter, or the call site's argument order becomes
    // load-bearing in a way nothing states.
    assert.equal(narrowerWriteMode(server, grant), expected, `${server}/${grant} should also be ${expected}`);
  }
});

test("tightening the deployment actually removes the tools a wider grant could see", async () => {
  // The property end to end, rather than the arithmetic: compose the ceiling decision with the
  // visibility pipeline and check an irreversible tool really disappears. A `full` grant against a
  // server redeployed as `reversible` must see exactly what a `reversible` grant sees.
  const { narrowerWriteMode } = await import("../dist/policy.js");
  const { visibleTools } = await import("../dist/server.js");
  const seen = (grantMode, serverMode) =>
    visibleTools({
      toolsets: [],
      enableUi: false,
      writeMode: narrowerWriteMode(grantMode, serverMode),
      allowExternalSend: false,
    }).visible.map((t) => t.name);

  const tightened = seen("full", "reversible");
  assert.deepEqual(tightened, seen("reversible", "reversible"), "a full grant outlived the operator's tightening");
  assert.ok(
    !tightened.some((n) => n === "reai_create_voucher"),
    "an irreversible tool survived a tightened deployment",
  );
  // And the ceiling is a floor in neither direction: a read-only grant stays read-only on a full server.
  assert.deepEqual(seen("read-only", "full"), seen("read-only", "read-only"));
});
