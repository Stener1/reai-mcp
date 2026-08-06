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
  classifyTransmission,
  transmittingBodyFields,
  assertTransmitAllowed,
  ExternalSendBlockedError,
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
  assert.equal(classifyTransmission("GET", "/api/peppol/messages/phase4ping"), "none");
});

test("sendEhf in the body makes an otherwise local write transmitting", () => {
  assert.equal(classifyTransmission("POST", "/api/orders"), "none");
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: true }), "external");
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: false }), "none");
  assert.equal(classifyTransmission("POST", "/api/orders", { sendEhf: "true" }), "none");
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

  // A matched pair stays in one row even though the descriptions differ...
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
  let rows = sent[0].body.postings.map((p) => p.rowNumber);
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
  rows = sent[0].body.postings.map((p) => p.rowNumber);
  assert.equal(new Set(rows).size, 3, `expected three rows, got ${rows.join(",")}`);

  // A matched pair that would share a row but disagrees on description is refused
  // locally, since the row carries one description and the pair cannot be split.
  sent.length = 0;
  const conflict = await tool.handler(
    {
      date: "2026-08-06",
      postings: [
        { accountNumber: "1576", amount: 5, description: "aaa" },
        { accountNumber: "1580", amount: -5, description: "bbb" },
      ],
    },
    ctx,
  );
  assert.equal(sent.length, 0, "nothing should be sent when the row descriptions conflict");
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
