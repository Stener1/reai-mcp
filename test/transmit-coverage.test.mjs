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
 *     has shipped twice. (2) only sees the ones with a telling name, which is 21 of 33.
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
    `only ${externalOps.length} operations classify as external; 33 were present when this ` +
      `was written, so a large drop means the classification broke, not that the API changed`,
  );
});

// ---------------------------------------------------------------------------
// 1. Enforcement
// ---------------------------------------------------------------------------

/** Drives the real handler with a client that makes any HTTP attempt loud. */
async function attempt(method, path, writeMode) {
  const tool = allTools.find((t) => t.name === "reai_request");
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
        throw new Error("__REACHED_THE_API__");
      },
    },
  };
  try {
    const res = await tool.handler({ method, path, body: {} }, ctx);
    return res.isError ? { refused: true } : { refused: false, how: "returned success" };
  } catch (err) {
    return /__REACHED_THE_API__/.test(err.message)
      ? { refused: false, how: "an HTTP request was made" }
      : { refused: true };
  }
}

test("every transmitting operation is refused in every write mode", async () => {
  const escaped = [];
  for (const op of externalOps) {
    // `full` is the one that matters most: it lifts the write ceiling, and the whole point of
    // the second axis is that it does NOT lift external send. `read-only` matters for the two
    // transmitting GETs, which are the ones a "surely a read is safe" assumption would miss.
    for (const writeMode of ["read-only", "reversible", "full"]) {
      const result = await attempt(op.method, concrete(op.path), writeMode);
      if (!result.refused) escaped.push(`${writeMode}: ${keyOf(op)} — ${result.how}`);
    }
  }
  assert.deepEqual(escaped, [], "these would have transmitted with REAI_ALLOW_EXTERNAL_SEND unset");
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
  // And it must not suggest raising the write mode, which would not help and is the more
  // dangerous of the two knobs to reach for.
  assert.doesNotMatch(text, /REAI_WRITE_MODE=full/);
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
    "lists files inside an attachment — matched only on the word 'files'",
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
  "GET /api/leads/person-profiles": "matched on 'file' inside 'profiles'",
  "POST /api/supplier-invoices/{id}/attachments/existing":
    "attaches an already-stored file to an INCOMING invoice; matched on 'file'",
  "GET /attachments/{id}/view/{filename}": "matched on 'file' inside 'filename'",
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

test("every excused operation still exists and still does not send", () => {
  const specKeys = new Set(OPERATIONS.map(keyOf));
  for (const [key, reason] of Object.entries(REVIEWED_NOT_SENDERS)) {
    assert.ok(specKeys.has(key), `excuses an operation the spec no longer has: ${key}`);
    assert.ok(reason.length > 25, `${key} needs a reason, not a placeholder`);
    // If one of these becomes a sender, the excuse is now a lie sitting next to the gate.
    const [method, path] = key.split(" ");
    assert.notEqual(
      classifyTransmission(method, concrete(path)),
      "external",
      `${key} is now classified external — remove its excuse rather than leaving both`,
    );
  }
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
