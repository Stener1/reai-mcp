import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTransmission } from "../dist/policy.js";
import { getSpecIndex } from "../dist/reai/spec.js";
import { allTools } from "../dist/server.js";

/**
 * Whether the external-send switch actually holds, across the WHOLE spec rather than the
 * handful of paths named in policy.test.mjs.
 *
 * Sending is the one class of mistake this server cannot walk back: an EHF invoice on the
 * Peppol network, an email to a customer, a signing request to a counterparty, a tax return
 * filed with Skatteetaten, a payroll run completed. Codex has caught a hole in exactly this
 * area before — government filings that were irreversible but not external — so the class is
 * worth a guard rather than a list of remembered examples.
 *
 * Three independent halves, because each covers a different failure and none covers all:
 *
 *  1. ENFORCEMENT, fully derived. Everything the policy calls external must be refused by the
 *     real reai_request handler, in every write mode. Catches a gate that runs in the wrong
 *     order, a mode that skips the check, or a transmitting GET slipping through `read-only`.
 *
 *  2. COVERAGE, from a signal INDEPENDENT of the policy. A keyword sweep of the spec: anything
 *     whose path or summary suggests it leaves the tenant must be classified external, or be
 *     listed below with the reason it is not. Catches a new spec operation nobody classified,
 *     and a pattern edit that drops an obvious one.
 *
 *  3. NAMED PINS for the transmitting operations no other test mentions. Half is not enough on
 *     its own: (1) derives its own subject from the policy, so removing a path shrinks the set
 *     and stays green — the "guard that tests a copy of the thing it guards" shape this repo
 *     has shipped twice. (2) only sees the ones with a telling name, which is 23 of 35.
 */

const OPERATIONS = getSpecIndex().operations;
const concrete = (path) => path.replace(/\{[^}]+\}/g, "7");
const keyOf = (op) => `${op.method} ${op.path}`;

/** Every operation the policy says leaves the tenant, spec-form path and all. */
const externalOps = OPERATIONS.filter(
  (op) => classifyTransmission(op.method, concrete(op.path)) === "external",
);

test("the spec still contains transmitting operations at all", () => {
  // If a spec rebuild or a policy refactor emptied this, every derived assertion below would
  // pass by iterating nothing. That is the failure mode the rest of this file is written
  // against, so it is checked first and by an absolute number.
  assert.ok(
    externalOps.length >= 30,
    `only ${externalOps.length} operations classify as external; 35 were present when this ` +
      `was written, so a large drop means the classification broke, not that the API changed`,
  );
});

// ---------------------------------------------------------------------------
// 1. Enforcement
// ---------------------------------------------------------------------------

/**
 * Drives the real handler and reports whether the API was reached, and WHICH gate refused.
 *
 * Two things here were wrong in the first version and are worth keeping visible:
 *
 * `called` is now recorded inside the stub rather than inferred from the error message. The
 * old version treated any throw not carrying its sentinel — and any isError result — as a
 * refusal, so a refactor that normalised client failures into an isError result while moving
 * the transmit check AFTER the request would have invoked the client and still been scored
 * "refused".
 *
 * `by` names the gate. The write ladder runs BEFORE the send gate, so outside `full` mode most
 * transmitting operations are refused by the write policy and the send gate never runs. A test
 * that only asked "was it refused" therefore proved nothing about sending in those modes —
 * demonstrated: gating on `writeMode === "full"` only left the whole file green.
 */
async function attempt(method, path, writeMode, body = {}) {
  const tool = allTools.find((t) => t.name === "reai_request");
  let called = false;
  const ctx = {
    config: {
      boundTenantId: undefined,
      defaultTenantId: 2783,
      writeMode,
      allowExternalSend: false,
    },
    session: {},
    client: {
      deepLink: () => "",
      request: async () => {
        called = true;
        throw new Error("__REACHED_THE_API__");
      },
    },
  };
  const classify = (err) => {
    const name = err?.name ?? "";
    if (name === "ExternalSendBlockedError") return "send-gate";
    if (name === "WriteBlockedError") return "write-ladder";
    return /__REACHED_THE_API__/.test(err?.message ?? "") ? "none" : "other";
  };
  try {
    const res = await tool.handler({ method, path, body }, ctx);
    return { called, refused: res.isError === true, by: res.isError ? "tool-error" : "none" };
  } catch (err) {
    return { called, refused: classify(err) !== "none", by: classify(err) };
  }
}

test("no transmitting operation reaches the API, in any write mode", async () => {
  const escaped = [];
  for (const op of externalOps) {
    for (const writeMode of ["read-only", "reversible", "full"]) {
      const r = await attempt(op.method, concrete(op.path), writeMode);
      // `called` is the property that matters: an HTTP request to a transmitting path IS the
      // send. Whether the handler then threw or returned an error is a detail.
      if (r.called) escaped.push(`${writeMode}: ${keyOf(op)} — the client was invoked`);
      else if (!r.refused) escaped.push(`${writeMode}: ${keyOf(op)} — returned success`);
    }
  }
  assert.deepEqual(escaped, [], "these would have transmitted with REAI_ALLOW_EXTERNAL_SEND unset");
});

test("in full mode the SEND gate is what refuses, not the write ladder", async () => {
  // The distinction this file previously missed. `full` lifts the write ceiling, so it is the
  // only mode where the send gate is the sole thing standing in the way — and therefore the
  // only mode where "refused" is evidence about sending at all. Asserting the error's identity
  // also turns a future silent change into a visible one: if any of these stops being
  // irreversible, or the gates swap order, the refuser changes and this fails.
  const wrong = [];
  for (const op of externalOps) {
    const r = await attempt(op.method, concrete(op.path), "full");
    if (r.by !== "send-gate") wrong.push(`${keyOf(op)} — refused by ${r.by}`);
  }
  assert.deepEqual(wrong, [], "in full mode every one of these must hit ExternalSendBlockedError");
});

test("outside full mode the write ladder refuses first, which is why the check above exists", async () => {
  // Not an aspiration — a measurement, recorded so the previous mistake cannot come back
  // quietly. In read-only and reversible, the write policy refuses every transmitting WRITE
  // before the send gate is consulted; only the transmitting GETs reach it, since a GET is
  // permitted by every write mode.
  const gets = externalOps.filter((op) => op.method === "GET");
  assert.ok(gets.length >= 2, `expected transmitting GETs to exist; found ${gets.length}`);
  for (const op of gets) {
    const r = await attempt(op.method, concrete(op.path), "read-only");
    assert.equal(r.by, "send-gate", `${keyOf(op)} in read-only`);
    assert.equal(r.called, false);
  }
  for (const op of externalOps.filter((op) => op.method !== "GET")) {
    const r = await attempt(op.method, concrete(op.path), "reversible");
    assert.equal(r.by, "write-ladder", `${keyOf(op)} in reversible`);
  }
});

test("the refusal names the switch, so the reason is actionable", async () => {
  const { text } = await (async () => {
    const tool = allTools.find((t) => t.name === "reai_request");
    try {
      await tool.handler(
        { method: "POST", path: "/api/invoices/7/ehf", body: {} },
        {
          config: { defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
          session: {},
          client: { deepLink: () => "", request: async () => ({ data: {}, status: 200 }) },
        },
      );
      return { text: "" };
    } catch (err) {
      return { text: err.message };
    }
  })();
  assert.match(text, /REAI_ALLOW_EXTERNAL_SEND/);
  // It must not tell the caller to raise the write mode, which would not help and is the more
  // dangerous of the two knobs to reach for. Asserted as the RECOMMENDATION rather than as the
  // substring "REAI_WRITE_MODE=full": a better message could legitimately mention that flag in
  // order to say it will not help, and forbidding the characters would fail that improvement.
  assert.doesNotMatch(text, /(set|use|enable|raise|try)\s+REAI_WRITE_MODE/i);
});

// ---------------------------------------------------------------------------
// 2. Coverage, from a signal the policy does not share
// ---------------------------------------------------------------------------

/**
 * Deliberately broad and deliberately naive: it knows nothing about the policy's patterns, so
 * it can disagree with them. Over-catching is the point — each false positive costs one line
 * below, and a miss costs a send.
 */
const LOOKS_LIKE_A_SEND =
  /send|email|mail|sign-request|peppol|ehf|submit|filing|reminder|dispatch|deliver|distribut|notify|sms|invite|transmit|altinn|skatt|phone-call/i;

/**
 * Operations that LOOK like they send and do not, each with why.
 *
 * Kept as prose rather than a bare list so the next person can re-derive the judgement. Most
 * are reads of what was already sent, which is the opposite of sending, and three are just the
 * word "file" appearing inside another word.
 */
const REVIEWED_NOT_SENDERS = {
  "GET /api/agreements/{id}/sign-requests":
    "lists the signing requests that already exist; sending is the POST beside it",
  "DELETE /api/agreements/{id}/sign-requests/{signRequestId}":
    "revokes a pending signer and invalidates its link — it UNDOES a send, and the policy " +
    "carves it out by name so the switch cannot block the withdrawal of what it exists to control",
  "GET /api/attachments/{id}/ehf":
    "reads the EHF payload of a document already received; incoming, not outgoing",
  "GET /api/attachments/{id}/embedded-files":
    "reads files out of an attachment already received; it is caught by 'EHF' in its summary " +
    "(\"Download embedded files from an EHF attachment\"), not by the word 'files'",
  "PUT /api/customers/{id}/delivery-address":
    "sets a postal address and matched on 'deliver'; changing where goods go is not a send. It " +
    "is not unguarded either — checked, it is inside inPaymentRoutingScope, so a body carrying " +
    "bank-routing fields on this path still escalates on the other axis",
  "POST /api/expenses/{id}/deliver":
    "an internal status transition, open → for_approval, per the endpoint's own description; " +
    "nothing leaves the tenant and no approver is contacted by this call",
  "GET /api/invoices/{id}/efaktura-status":
    "reads the eFaktura status of an invoice already issued",
  "GET /api/invoices/{id}/ehf-history": "reads the record of past EHF sends",
  "GET /api/invoices/{id}/email-history": "reads the record of past emails",
  "GET /api/invoices/{id}/reminders":
    "lists reminders already issued; POST on the same path is the one that sends",
  "GET /api/invoices/{id}/reminders/{reminderId}/pdf":
    "downloads a reminder to the CALLER, not to the debtor",
};

test("anything that looks like a send is classified, or excused with a reason", () => {
  const unclassified = [];
  for (const op of OPERATIONS) {
    const blob = [op.path, op.summary ?? "", op.id ?? ""].join(" ");
    if (!LOOKS_LIKE_A_SEND.test(blob)) continue;
    if (classifyTransmission(op.method, concrete(op.path)) === "external") continue;
    if (keyOf(op) in REVIEWED_NOT_SENDERS) continue;
    unclassified.push(keyOf(op));
  }
  assert.deepEqual(
    unclassified,
    [],
    "these look like they leave the tenant but are not classified external — either add them " +
      "to the policy's transmitting patterns, or to REVIEWED_NOT_SENDERS with the reason they " +
      "do not send",
  );
});

test("every excused operation still exists, still matches the sweep, and still does not send", () => {
  const byKey = new Map(OPERATIONS.map((op) => [keyOf(op), op]));
  for (const [key, reason] of Object.entries(REVIEWED_NOT_SENDERS)) {
    const op = byKey.get(key);
    assert.ok(op, `excuses an operation the spec no longer has: ${key}`);
    assert.ok(reason.length > 25, `${key} needs a reason, not a placeholder`);
    // An excuse for something the sweep never selects is dead weight that LOOKS like a
    // reviewed decision. Three entries were exactly that: they were written against an
    // earlier regex containing bare `file`, which later became `filing`, so they excused
    // nothing while reading as considered judgements. Worse, the same drift in reverse — a
    // keyword quietly removed — would shrink the sweep and leave its excuses green.
    assert.ok(
      LOOKS_LIKE_A_SEND.test([op.path, op.summary ?? "", op.id ?? ""].join(" ")),
      `${key} no longer matches the sweep, so this excuse is dead — remove it, or restore the ` +
        `keyword that used to select it`,
    );
    // If one of these becomes a sender, the excuse is now a lie sitting next to the gate.
    const [method, path] = key.split(" ");
    assert.notEqual(
      classifyTransmission(method, concrete(path)),
      "external",
      `${key} is now classified external — remove its excuse rather than leaving both`,
    );
  }
});

/**
 * Transmission that depends on the BODY, driven through the handler.
 *
 * The path sweep cannot see these: `POST /api/orders` is "none" by path and external only when
 * the body carries sendEhf, so it is absent from externalOps and every assertion above. A
 * regression where reai_request stopped passing args.body to classifyTransmission would have
 * left this whole-spec file green while `full` mode issued EHF invoices with sending off.
 *
 * The armed values come from the policy's own field list rather than a copy of it, so a new
 * transmitting field cannot be added without appearing here.
 */
const ARMED_BODIES = [
  ["POST", "/api/orders", { sendEhf: true }],
  ["POST", "/api/orders", { sendEhf: "true" }],
  ["POST", "/api/subscriptions", { outputMode: "create_invoice" }],
  ["POST", "/api/subscriptions", { automaticBillingGeneration: true }],
  // A top-level ARRAY, which the inspection handles deliberately — a batch body would
  // otherwise hide an armed field behind its outer shape.
  ["POST", "/api/orders", [{ sendEhf: true }]],
];

/**
 * Not tested: an armed field NESTED inside an object or a line array, e.g.
 * `{ lines: [{ sendEhf: true }] }`. The inspection is deliberately shallow here and does not
 * catch that — checked against the spec rather than assumed: sweeping every `*Req` schema to
 * depth 4, sendEhf, outputMode and automaticBillingGeneration occur ONLY as top-level
 * properties (CreateOrderReq, UpdateOrderReq, SubscriptionWriteReq), so there is no request
 * shape in this API that nests them.
 *
 * Worth stating because the payment-routing axis DOES walk nested objects (MAX_BODY_DEPTH 4).
 * That asymmetry is justified by the spec — bank-routing fields genuinely nest, these do not —
 * not by one axis having been thought about less.
 */

test("a body that arms a send is refused by the handler, path notwithstanding", async () => {
  for (const [method, path, body] of ARMED_BODIES) {
    // Precondition: these must be "none" by path, or the test proves nothing about the body.
    assert.equal(
      classifyTransmission(method, path),
      "none",
      `${method} ${path} is external by PATH, so it cannot demonstrate body-triggered gating`,
    );
    assert.equal(classifyTransmission(method, path, body), "external", JSON.stringify(body));

    const r = await attempt(method, path, "full", body);
    assert.equal(r.called, false, `${method} ${path} ${JSON.stringify(body)} reached the API`);
    assert.equal(r.by, "send-gate", `${method} ${path} ${JSON.stringify(body)}`);
  }
});

test("every field the policy treats as arming a send is exercised above", async () => {
  const { transmittingBodyFields } = await import("../dist/policy.js");
  // The real list, derived: a field added to TRANSMITTING_BODY_FIELDS and not covered here
  // would otherwise be gated in the classifier and untested through the handler.
  const armed = { sendEhf: true, outputMode: "create_invoice", automaticBillingGeneration: true };
  const known = transmittingBodyFields(armed).map((entry) => entry.split("=")[0].toLowerCase());
  assert.ok(known.length >= 3, `expected the policy to report its armed fields; got ${known}`);
  const exercised = new Set(
    ARMED_BODIES.flatMap(([, , body]) =>
      JSON.stringify(body)
        .toLowerCase()
        .match(/"([a-z]+)":/g)
        ?.map((m) => m.slice(1, -2)) ?? [],
    ),
  );
  const missing = known.filter((f) => !exercised.has(f));
  assert.deepEqual(missing, [], "these arm a send in the policy but are not driven through the handler");
});

// ---------------------------------------------------------------------------
// 3. Named pins
// ---------------------------------------------------------------------------

/**
 * Transmitting operations that NO other test mentions by name.
 *
 * The seven Peppol ones are all caught by a single pattern, so one careless edit drops seven
 * ways of putting a document on the Peppol network and every derived assertion above stays
 * green — it would simply stop testing them. The two lead endpoints PLACE A PHONE CALL, which
 * is the least recallable thing in this API and the easiest to overlook, since nothing about
 * "leads" suggests the send axis.
 */
const MUST_TRANSMIT = [
  // Neither of these is visible to the sweep: /api/users has no summary at all and no send
  // token in its path, and "payments" is not a word the regex knows. Both were found by
  // review, and both are exactly the shape the sweep is blind to — which is why they are
  // pinned here rather than left to it.
  "POST /api/users",
  "POST /api/peppol/messages/sendas4-facturx/{senderId}/{receiverId}/{countryC1}",
  "POST /api/peppol/messages/sendas4/{senderId}/{receiverId}/{docTypeId}/{processId}/{countryC1}",
  "POST /api/peppol/reports/create-eusr/{year}/{month}",
  "POST /api/peppol/reports/create-tsr/{year}/{month}",
  "POST /api/peppol/reports/do-peppol-eusr-reporting/{year}/{month}",
  "POST /api/peppol/reports/do-peppol-reporting/{year}/{month}",
  "POST /api/peppol/reports/do-peppol-tsr-reporting/{year}/{month}",
  "POST /lead/company/{orgNumber}/phone-call",
  "POST /lead/{orgNumber}/person-phone-call",
];

test("the transmitting operations nothing else names are pinned here", () => {
  const specKeys = new Set(OPERATIONS.map(keyOf));
  for (const key of MUST_TRANSMIT) {
    assert.ok(specKeys.has(key), `pins an operation the spec no longer has: ${key}`);
    const [method, path] = key.split(" ");
    assert.equal(
      classifyTransmission(method, concrete(path)),
      "external",
      `${key} must be classified external`,
    );
  }
});

/**
 * The two operations this PR added to the send axis, pinned with their reasoning.
 *
 * Both were found by review after the first version of this file passed on all counts, and
 * both are invisible to the keyword sweep — which is the honest limit of that half: it is only
 * as strong as the spec's naming, and 284 of 430 operations here carry no summary at all.
 */
test("granting user access is on the send axis, because an invitation is an email", async () => {
  // UserAccessRes.status is "active" | "pending_invitation" with an invitationId, CreateUserReq
  // is { email, roleCode, expiresInDays }, and GET /api/users/invitations lists the pending
  // ones. An expiring invitation the invitee must accept can only reach them by mail. The
  // endpoint has no description, so the email is inferred from that shape — and failing closed
  // is easy here, because roleCode accepts ROLE_TENANT_ADMIN and what is sent is privilege.
  assert.equal(classifyTransmission("POST", "/api/users"), "external");
  const r = await attempt("POST", "/api/users", "full", {
    email: "someone@example.invalid",
    roleCode: "ROLE_TENANT_ADMIN",
  });
  assert.equal(r.called, false, "an admin invitation must not reach the API with sending off");
  assert.equal(r.by, "send-gate");

  // Reading and revoking access are not sends, and must stay usable.
  for (const [method, path] of [
    ["GET", "/api/users"],
    ["GET", "/api/users/invitations"],
    ["GET", "/api/users/roles"],
    ["DELETE", "/api/users/7"],
    ["PUT", "/api/users/7"],
  ]) {
    assert.equal(classifyTransmission(method, path), "none", `${method} ${path}`);
  }
});

test("paying a supplier invoice is on the send axis unless it is books-only", async () => {
  const path = "/api/supplier-invoices/7/payments";
  // Its own description: for a bank-integrated payment, approvalUrl "starts the BankID approval
  // flow". manualPayment: true records a payment that has already left the bank and sends
  // nothing; anything else selects the integration flow.
  assert.equal(classifyTransmission("POST", path, { manualPayment: true }), "none");
  assert.equal(classifyTransmission("POST", path, { manualPayment: "true" }), "none");
  assert.equal(classifyTransmission("POST", path, { manualPayment: 1 }), "none");

  // Absent is the dangerous one, and it is dangerous by MEASUREMENT rather than by caution:
  // omitting manualPayment once during live verification selected the bank-integrated flow,
  // which is why the curated tool makes the field required. reai_request has no such schema.
  for (const body of [{}, undefined, { manualPayment: false }, { paidPrivately: true }]) {
    assert.equal(
      classifyTransmission("POST", path, body),
      "external",
      `body ${JSON.stringify(body ?? null)} must not be able to start a transfer`,
    );
  }

  const armed = await attempt("POST", path, "full", { paymentDate: "2026-08-01", invoiceAmount: 125 });
  assert.equal(armed.called, false, "a bank-integrated payment must not reach the API");
  assert.equal(armed.by, "send-gate");

  // And the books-only form must still work at full mode with sending off, or this gate would
  // have made recording a paid invoice impossible — which is not what it is for.
  const booksOnly = await attempt("POST", path, "full", {
    paymentDate: "2026-08-01",
    invoiceAmount: 125,
    manualPayment: true,
    companyBankId: 1,
  });
  assert.equal(booksOnly.by, "none", "manualPayment: true must reach the API in full mode");
  assert.equal(booksOnly.called, true);

  // Listing and deleting payments are unaffected.
  assert.equal(classifyTransmission("GET", path), "none");
  assert.equal(classifyTransmission("DELETE", `${path}/3`), "none");
});

test("the CURATED payment tool is gated too, not only the escape hatch", async () => {
  // A policy rule alone was not enough here. classifyTransmission covers reai_request, but
  // curatedArgsEscalate reads a tool's arguments as an API body and does not consult it — so
  // the escape hatch became STRICTER than reai_register_supplier_invoice_payment, which is
  // backwards: the curated tool is the one an agent reaches for. The tool now calls
  // assertTransmitAllowed itself, the way reai_activate_subscription already did.
  //
  // Not routed through curatedArgsEscalate deliberately: that helper would read any argument
  // named like a transmitting field as arming a send, and a report tool's `outputMode` is
  // exactly such an argument. Attempted, and it made two existing tests fail for that reason.
  const { registeredTools } = await import("../dist/server.js");
  const tool = registeredTools.find((x) => x.name === "reai_register_supplier_invoice_payment");
  assert.ok(tool, "the curated payment tool must exist for this to mean anything");

  const call = async (args, allowExternalSend) => {
    let called = false;
    const ctx = {
      client: {
        deepLink: () => "",
        request: async () => {
          called = true;
          return { data: { paymentId: 1, status: "settled" }, status: 201 };
        },
      },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend },
      session: {},
    };
    try {
      await tool.handler(args, ctx);
      return { called, error: undefined };
    } catch (err) {
      return { called, error: err?.name };
    }
  };

  const base = { id: 42, invoiceAmount: 300, paymentDate: "2026-08-07", companyBankId: 1, tenantId: 2783 };

  // The bank-integrated branch: refused, and nothing reaches the API.
  const bankFlow = await call({ ...base, manualPayment: false }, false);
  assert.equal(bankFlow.error, "ExternalSendBlockedError");
  assert.equal(bankFlow.called, false, "a BankID transfer must not be started with sending off");

  // Books-only must stay usable, or the gate has broken recording a paid invoice.
  const booksOnly = await call({ ...base, manualPayment: true }, false);
  assert.equal(booksOnly.error, undefined);
  assert.equal(booksOnly.called, true);

  // And with sending enabled the bank-integrated branch works, since that is the point.
  const enabled = await call({ ...base, manualPayment: false }, true);
  assert.equal(enabled.error, undefined);
  assert.equal(enabled.called, true);
});

test("the refusal says what kind of thing is leaving", async () => {
  // The message listed "a document, email or signing request" while the axis had grown to
  // cover money movement and an access invitation. A refusal that names the wrong kind of
  // thing reads like a misfire, and an agent that thinks a gate misfired looks for a way past it.
  const { ExternalSendBlockedError } = await import("../dist/policy.js");
  const text = new ExternalSendBlockedError("paying supplier invoice 42").message;
  for (const kind of [/document/, /email/, /signing request/, /filing/, /invitation/, /money leaving/]) {
    assert.match(text, kind);
  }
});

test("an internal path is gated too, since reai_request can reach one", async () => {
  // The two phone-call endpoints and the Altinn sync are all INTERNAL operations. If the gate
  // only covered /api/, the least recallable calls in this spec would be the ones outside it.
  for (const [method, path] of [
    ["POST", "/lead/company/7/phone-call"],
    ["GET", "/vat-return/altinn-sync"],
  ]) {
    const result = await attempt(method, path, "full");
    assert.equal(result.refused, true, `${method} ${path} — ${result.how ?? ""}`);
  }
});
