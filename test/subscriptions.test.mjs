import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionTools, uncuratedSubscriptionPaths } from "../dist/tools/subscriptions.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest, curatedArgsEscalate, isAllowed } from "../dist/policy.js";

const tool = (name) => {
  const found = subscriptionTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, response) {
  const calls = [];
  const result = await tool(name).handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => {
          calls.push(req);
          // A function gets (request, callNumber), so a tool that READS before it writes can be
          // given a different answer per call — which reai_update_subscription now needs.
          const data = typeof response === "function" ? response(req, calls.length) : response;
          return { data, status: 200 };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783 },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const subscription = (over = {}) => ({
  id: 4,
  customerId: 12,
  customerName: "Kunde AS",
  active: true,
  automaticBillingGeneration: false,
  outputMode: "create_order",
  sendEhf: false,
  intervalMonths: 1,
  nextBillingDate: "2026-09-01",
  due: false,
  ...over,
});

// The whole reason this domain needs curating. Each of these three turns a subscription
// into something that reaches a customer with no further call, and each has to be refused
// on BOTH axes: irreversible for the write mode, and an external send that `full` does not
// lift on its own.
test("the three arming fields are refused on both axes", () => {
  const paths = tool("reai_create_subscription").apiPaths;
  for (const [field, value] of [
    ["outputMode", "create_invoice"],
    ["automaticBillingGeneration", true],
    ["sendEhf", true],
  ]) {
    const escalated = curatedArgsEscalate(paths, { [field]: value });
    assert.ok(escalated, `${field}=${value} must escalate`);
    assert.equal(escalated.risk, "irreversible", field);
    assert.equal(isAllowed(escalated.risk, "reversible"), false, `${field} must not run in default mode`);
    assert.equal(escalated.transmits, true, `${field} reaches a counterparty`);
  }
  // And the ordinary subscription stays ordinary — a draft order, billed on request. If
  // this escalated, the safe way to use the domain would need the dangerous mode.
  assert.equal(
    curatedArgsEscalate(paths, {
      customerId: 1,
      outputMode: "create_order",
      automaticBillingGeneration: false,
      sendEhf: false,
    }),
    undefined,
  );
  // Replacing an existing one is the same question.
  assert.equal(
    curatedArgsEscalate(tool("reai_update_subscription").apiPaths, { outputMode: "create_invoice" })?.transmits,
    true,
  );
});

test("declared risks match what the escape hatch would say", () => {
  assert.equal(subscriptionTools.length, 9);
  for (const t of subscriptionTools) {
    assert.ok(registeredTools.includes(t), `${t.name} must be inside the repo-wide sweeps`);
    for (const [method, path] of t.apiPaths ?? []) {
      const fromPolicy = classifyRequest(method, path.replace(/\{[^}]+\}/g, "1"));
      const rank = { read: 0, reversible: 1, irreversible: 2 };
      assert.ok(rank[t.risk] >= rank[fromPolicy], `${t.name} is softer than ${method} ${path}`);
    }
  }
  // Activating arms the schedule; deactivating undoes a standing risk and stays available
  // in the default mode, the same reasoning applied elsewhere to stop-and-cancel actions.
  assert.equal(tool("reai_activate_subscription").risk, "irreversible");
  assert.equal(tool("reai_deactivate_subscription").risk, "reversible");
  // Billing now produces the document; it is the one tool here that transmits by itself.
  assert.equal(tool("reai_generate_subscription_billing").transmits, true);
  assert.equal(tool("reai_generate_subscription_billing").destructive, true);
  for (const name of ["reai_create_subscription", "reai_update_subscription", "reai_list_subscriptions"]) {
    assert.ok(!tool(name).transmits, `${name} must not be hidden when external sending is off`);
  }
  assert.equal(tool("reai_delete_subscription").destructive, true);
});

// Mass billing is reachable through the escape hatch, where the refusal names it. Making it
// a curated tool would put "bill everything due" one call away.
test("generate-due is deliberately not curated", () => {
  assert.deepEqual([...uncuratedSubscriptionPaths], ["POST /api/subscriptions/generate-due"]);
  assert.equal(
    registeredTools.some((t) => (t.apiPaths ?? []).some(([, p]) => p.includes("generate-due"))),
    false,
  );
  // And it is still refused by the policy, so the escape hatch is not a way around anything.
  assert.equal(classifyRequest("POST", "/api/subscriptions/generate-due"), "irreversible");
});

test("the list answers the question worth asking first", async () => {
  const armed = await run("reai_list_subscriptions", {}, [
    subscription(),
    subscription({ id: 5, active: true, automaticBillingGeneration: true, outputMode: "create_invoice" }),
    subscription({ id: 6, active: true, automaticBillingGeneration: true, outputMode: "create_order", due: true }),
  ]);
  assert.match(armed.text, /3 subscription\(s\)/);
  assert.match(armed.text, /2 bill\(s\) automatically right now, of which 1 issue a numbered invoice/);
  assert.match(armed.text, /1 active and due now/);

  const quiet = await run("reai_list_subscriptions", {}, [subscription()]);
  assert.match(quiet.text, /None bill automatically/);

  const none = await run("reai_list_subscriptions", {}, []);
  assert.match(none.text, /Nothing recurring is set up/);

  // A shape surprise is not emptiness — the same rule every list tool follows.
  const odd = await run("reai_list_subscriptions", {}, { content: [subscription()] });
  assert.match(odd.text, /did not return a list/);
});

// Three states where the first version of the summary was false, each in the reassuring
// direction. The worst is the first: an agent asks "does anything auto-invoice?", is told
// "None", then activates a stopped subscription — which every description frames as the
// ordinary thing to do — and numbered invoices start.
test("a stopped automatic subscription is not reported as manual", async () => {
  const dormant = await run("reai_list_subscriptions", {}, [
    subscription({ active: false, automaticBillingGeneration: true, outputMode: "create_invoice" }),
  ]);
  assert.doesNotMatch(dormant.text, /None bill automatically/);
  assert.match(dormant.text, /would bill automatically if activated — they are stopped, not manual/);

  // `due` on something that produces nothing pushes toward a generate call that does nothing.
  const dueButOff = await run("reai_list_subscriptions", {}, [
    subscription({ active: false, due: true }),
  ]);
  assert.doesNotMatch(dueButOff.text, /due now/);

  // An absent field is unknown, not false.
  const unknown = await run("reai_list_subscriptions", {}, [
    { id: 7, active: true, outputMode: "create_invoice" },
  ]);
  assert.match(unknown.text, /did not report automaticBillingGeneration/);
  assert.match(unknown.text, /UNKNOWN — not assumed to be no/);
  assert.doesNotMatch(unknown.text, /None bill automatically/);
});

test("reading one says whether it acts on its own", async () => {
  const machine = await run(
    "reai_get_subscription",
    { id: 4 },
    subscription({ automaticBillingGeneration: true, outputMode: "create_invoice", sendEhf: true }),
  );
  assert.match(machine.text, /ACTIVE and billing automatically/);
  assert.match(machine.text, /numbered INVOICE/);
  assert.match(machine.text, /EHF\/Peppol/);
  assert.match(machine.text, /with no further call/);

  const manual = await run("reai_get_subscription", { id: 4 }, subscription());
  assert.match(manual.text, /bills only when reai_generate_subscription_billing is called/);

  const off = await run("reai_get_subscription", { id: 4 }, subscription({ active: false }));
  assert.match(off.text, /produces nothing until activated/);
});

// Billing the same period twice is possible and the API will not stop it, so the tool that
// could cause it points at the one that shows whether it already happened.
test("billing history distinguishes never-billed from inactive", async () => {
  const never = await run("reai_subscription_billing_history", { id: 4 }, []);
  assert.match(never.text, /never billed/);
  assert.match(never.text, /not the same as it being inactive/);

  const some = await run("reai_subscription_billing_history", { id: 4 }, [
    { id: 1, billingDate: "2026-08-01", generatedOrderNumber: "O-1" },
  ]);
  assert.match(some.text, /1 billing\(s\) on subscription 4/);
  assert.match(
    tool("reai_generate_subscription_billing").description,
    /reai_subscription_billing_history/,
  );
});

// This used to assert the opposite: that every API-required field is required on the update too,
// "because the API replaces the record". That was the right contract for a pass-through and the
// wrong one for a merge — requiring them meant "change the interval" also meant "and retype the
// customer, the currency, the start date and every line", which is precisely how a caller drops
// invoiceEmail and half the lines. The tool now reads and merges, so the fields are optional and
// the REPLACEMENT is described as a property of the call underneath.
test("the update merges, and says the call underneath replaces", async () => {
  const description = tool("reai_update_subscription").description;
  assert.match(description, /full REPLACEMENT/);
  assert.match(description, /reads the subscription, maps it, merges/);
  // It must also say what it does NOT do, because an ordinary edit leaves the arming alone.
  assert.match(description, /DOES NOT DISARM/);
  const schema = tool("reai_update_subscription").inputSchema;
  for (const field of ["customerId", "startDate", "intervalMonths", "outputMode", "automaticBillingGeneration", "subscriptionLines"]) {
    assert.equal(schema[field].isOptional(), true, `${field} must be optional on a merge`);
  }
  // A stored subscription as the API returns one: lines under `lines`, with the computed fields
  // a response carries and a request does not.
  const stored = {
    id: 4,
    customerId: 12,
    startDate: "2026-01-01",
    intervalMonths: 1,
    billingTiming: "in_advance",
    currencyCode: "NOK",
    outputMode: "create_order",
    automaticBillingGeneration: false,
    daysUntilDue: 14,
    invoiceEmail: "billing@example.invalid",
    invoiceComment: "Kept",
    lines: [
      { rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1000, vatCode: "0", vatTitle: "Fritatt", vatRate: 0, amounts: { totalAmount: 1000 } },
    ],
  };
  const { calls } = await run(
    "reai_update_subscription",
    { id: 4, intervalMonths: 3 },
    (req, n) => (n === 1 ? stored : { ...stored, intervalMonths: 3 }),
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"], "it reads before replacing");
  assert.equal(calls[1].path, "/api/subscriptions/4");
  assert.equal(calls[1].body.id, undefined, "the id belongs in the path, not the body");
  // The change, and everything the caller did not mention.
  assert.equal(calls[1].body.intervalMonths, 3);
  assert.equal(calls[1].body.customerId, 12);
  assert.equal(calls[1].body.invoiceEmail, "billing@example.invalid", "delivery must survive an edit");
  assert.equal(calls[1].body.invoiceComment, "Kept");
  // The lines are mapped, not echoed: `lines` becomes `subscriptionLines`, and the three
  // computed fields a response line carries are dropped.
  assert.equal(calls[1].body.lines, undefined);
  assert.deepEqual(calls[1].body.subscriptionLines, [
    { rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1000, vatCode: "0" },
  ]);
});

test("an edit does not disarm a subscription, and says so", async () => {
  // The merge carries outputMode, automaticBillingGeneration and sendEhf over, so an ordinary
  // edit leaves a self-invoicing subscription self-invoicing. Silence there would read as
  // "the edit made it safe".
  const armed = {
    id: 9,
    customerId: 12,
    startDate: "2026-01-01",
    intervalMonths: 1,
    billingTiming: "in_advance",
    currencyCode: "NOK",
    outputMode: "create_invoice",
    automaticBillingGeneration: true,
    sendEhf: true,
    lines: [{ rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1000 }],
  };
  const { calls, text } = await run(
    "reai_update_subscription",
    { id: 9, invoiceComment: "New note" },
    (req, n) => (n === 1 ? armed : armed),
  );
  assert.equal(calls[1].body.sendEhf, true, "carried over, not dropped");
  assert.equal(calls[1].body.automaticBillingGeneration, true);
  assert.match(text, /Still armed/);
  assert.match(text, /did not change that/);
});

// The refusal below lives in the HANDLER, and these tests call the handler directly — so the
// schema has to let an empty array through, or the branch is dead code and the caller gets a bare
// validation error with none of the guidance. Exactly the shape that shipped in
// reai_update_company_bank's bban check, found there by driving the tool live.
test("the schema lets an empty line array reach the handler that explains it", () => {
  const lines = tool("reai_update_subscription").inputSchema.subscriptionLines;
  assert.equal(lines.safeParse([]).success, true, "an empty array must reach the handler");
  assert.equal(lines.safeParse(undefined).success, true, "omitting it means 'carry the stored ones over'");
  // The CREATE tool keeps the stricter rule: there is no stored subscription to fall back on.
  assert.equal(tool("reai_create_subscription").inputSchema.subscriptionLines.safeParse([]).success, false);
});

// Omission means "carry over", so null is the only way left to unlink — and adding .optional()
// alone left no way at all to detach a subscription from its project or agreement.
test("null unlinks the relations the document says are nullable, and only those", async () => {
  const schema = tool("reai_update_subscription").inputSchema;
  for (const field of ["agreementId", "projectId", "invoiceEmail", "invoiceComment", "internalComment"]) {
    assert.equal(schema[field].safeParse(null).success, true, `${field} must be clearable with null`);
  }
  // These four are non-nullable in the document, so null must stay refused: accepting it would
  // pass local validation only to fail at the API.
  for (const field of ["daysUntilDue", "periodAlignment", "sendEhf", "serviceRecipients"]) {
    assert.equal(schema[field].safeParse(null).success, false, `${field} is not nullable upstream`);
  }

  // And the null actually reaches the body rather than being treated as "unmentioned".
  const stored = {
    id: 4,
    customerId: 12,
    startDate: "2026-01-01",
    intervalMonths: 1,
    billingTiming: "in_advance",
    currencyCode: "NOK",
    outputMode: "create_order",
    automaticBillingGeneration: false,
    projectId: 77,
    invoiceEmail: "billing@example.invalid",
    lines: [{ rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1000 }],
  };
  const { calls } = await run("reai_update_subscription", { id: 4, projectId: null }, () => stored);
  assert.equal(calls[1].body.projectId, null, "the unlink must be sent, not dropped");
  assert.equal(calls[1].body.invoiceEmail, "billing@example.invalid", "and nothing else changes");
});

test("an edit that would leave no billing lines is refused", async () => {
  // `missing` only catches undefined/null/"", so an empty array would have replaced a billing
  // subscription with one that bills for nothing.
  const stored = {
    id: 4,
    customerId: 12,
    startDate: "2026-01-01",
    intervalMonths: 1,
    billingTiming: "in_advance",
    currencyCode: "NOK",
    outputMode: "create_order",
    automaticBillingGeneration: false,
    lines: [{ rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1000 }],
  };
  const { calls, result, text } = await run(
    "reai_update_subscription",
    { id: 4, subscriptionLines: [] },
    () => stored,
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.match(text, /no billing lines/);
  assert.match(text, /reai_deactivate_subscription/, "it must name the right way to pause billing");
});

test("a read of the wrong shape is refused rather than merged into", async () => {
  for (const body of [{ data: { id: 4, customerId: 12 } }, {}, "a subscription"]) {
    const { calls, result } = await run("reai_update_subscription", { id: 4, intervalMonths: 3 }, () => body);
    assert.equal(result.isError, true, JSON.stringify(body));
    assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  }
});

test("a line is checked against the bounds the API enforces", () => {
  const lines = tool("reai_create_subscription").inputSchema.subscriptionLines;
  const ok = (v) => assert.equal(lines.safeParse([v]).success, true, JSON.stringify(v));
  const no = (v, pattern) => {
    const r = lines.safeParse([v]);
    assert.equal(r.success, false, `should be rejected: ${JSON.stringify(v)}`);
    if (pattern) assert.match(r.error.issues[0].message, pattern);
  };

  ok({ itemName: "Drift", quantity: 1, unitPrice: 1000 });
  // A variant supplies its own name, so requiring itemName would block the ordinary way to
  // bill a catalogue item. The spec makes both optional; one of them has to be there.
  ok({ variantId: 5, quantity: 1, unitPrice: 100 });
  no({ quantity: 1, unitPrice: 1 }, /either an itemName or a variantId/);

  // SubscriptionLineReq's own bounds, refused here with the reason rather than at the API
  // with a bare 400.
  no({ itemName: "x", quantity: 0, unitPrice: 1 }, /at least 1/);
  no({ itemName: "x", quantity: 100001, unitPrice: 1 }, /100000/);
  no({ itemName: "x", quantity: 1, unitPrice: 20_000_000 }, /10,000,000/);
  no({ itemName: "x", quantity: 1, unitPrice: -20_000_000 }, /10,000,000/);
  // "Must be a whole-number value from 0 to 100", per the field's own description.
  no({ itemName: "x", quantity: 1, unitPrice: 1, discount: 50.5 }, /WHOLE-number/);
  no({ itemName: "x", quantity: 1, unitPrice: 1, discount: 150 });
  no({ itemName: "x".repeat(256), quantity: 1, unitPrice: 1 }, /255/);
  ok({ itemName: "x", quantity: 1, unitPrice: 1, discount: 50 });

  assert.equal(lines.safeParse([]).success, false, "a subscription with no lines bills nothing");
});

// Every other tool in the repo passes the RESOLVED tenant to deepLink. Passing the raw
// argument meant an omitted tenantId — the normal case once reai_use_tenant has run — fell
// back to the environment default, so the link could name a different company than the
// record above it.
test("the deep link names the tenant the record came from", async () => {
  const seen = [];
  const ctx = {
    client: {
      request: async () => ({ data: { id: 4, active: false }, status: 200 }),
      deepLink: (path, tenantId) => {
        seen.push({ path, tenantId });
        return `https://app.reai.no${path}?tenantId=${tenantId}`;
      },
    },
    // No tenantId in the arguments; the session supplies it, as it does after
    // reai_use_tenant or on a bound connector.
    config: { writeMode: "read-only" },
    session: { activeTenantId: 2783 },
  };
  const result = await tool("reai_get_subscription").handler({ id: 4 }, ctx);
  assert.deepEqual(seen, [{ path: "/subscriptions/4", tenantId: 2783 }]);
  assert.match(result.content[0].text, /tenantId=2783/);
});

// ---------------------------------------------------------------------------
// The merge preserves the arming, which the argument gate cannot see
// ---------------------------------------------------------------------------

/** An armed subscription: invoices by itself, over EHF, unattended. */
const armedStored = (over = {}) => ({
  id: 9,
  customerId: 12,
  startDate: "2026-01-01",
  intervalMonths: 1,
  billingTiming: "in_advance",
  currencyCode: "NOK",
  outputMode: "create_invoice",
  automaticBillingGeneration: true,
  sendEhf: true,
  active: true,
  invoiceComment: "Kept",
  lines: [{ rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1000 }],
  ...over,
});

/** Drives the handler with the external-send switch OFF, as a default deployment has it. */
async function runSendOff(args, responses) {
  const calls = [];
  let thrown;
  try {
    const result = await tool("reai_update_subscription").handler(
      { tenantId: 2783, ...args },
      {
        client: {
          request: async (req) => {
            calls.push(req);
            return { data: typeof responses === "function" ? responses(req, calls.length) : responses, status: 200 };
          },
          deepLink: () => "",
        },
        config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
        session: {},
      },
    );
    return { calls, text: result.content[0].text, refused: result.isError === true };
  } catch (err) {
    thrown = err;
    return { calls, text: err?.message ?? String(err), refused: true, name: err?.name };
  }
}

// Before this tool merged, outputMode and automaticBillingGeneration were REQUIRED arguments, so
// every update that succeeded with sending off had necessarily disarmed the subscription. Making
// preservation the default turned "edit an unattended invoicing machine" into an ordinary call.
test("changing what an unattended invoice says needs the send switch", async () => {
  for (const change of [
    { customerId: 999 },
    { subscriptionLines: [{ itemName: "Something else", quantity: 1, unitPrice: 9_999_999 }] },
    { startDate: "2020-01-01" },
    { intervalMonths: 12 },
    { billingTiming: "in_arrears" },
    { currencyCode: "EUR" },
    { serviceRecipients: [{ organizationNumber: "111222333", name: "Another", countryCode: "NO" }] },
  ]) {
    const r = await runSendOff({ id: 9, ...change }, () => armedStored());
    assert.equal(r.refused, true, `${Object.keys(change)[0]} must be refused on an armed subscription`);
    assert.equal(r.name, "ExternalSendBlockedError", Object.keys(change)[0]);
    assert.deepEqual(r.calls.map((c) => c.method), ["GET"], "nothing may be written");
    assert.match(r.text, /bills on its own/);
  }
});

test("an edit that reaches nobody is still allowed on an armed subscription", async () => {
  // The gate has to be scoped, or ordinary maintenance on a live subscription needs the send flag.
  for (const change of [{ invoiceComment: "New note" }, { internalComment: "Housekeeping" }, { daysUntilDue: 30 }, { projectId: null }]) {
    const r = await runSendOff({ id: 9, ...change }, (req, n) => (n === 1 ? armedStored() : armedStored()));
    assert.equal(r.refused, false, `${Object.keys(change)[0]} changes nothing anyone receives`);
    assert.deepEqual(r.calls.map((c) => c.method), ["GET", "PUT"]);
  }
});

test("a subscription that is NOT armed can have its substance edited freely", async () => {
  const r = await runSendOff({ id: 9, customerId: 999 }, () =>
    armedStored({ outputMode: "create_order", automaticBillingGeneration: false, sendEhf: false }),
  );
  assert.equal(r.refused, false, "nothing reaches anyone, so nothing to gate");
  assert.equal(r.calls[1].body.customerId, 999);
});

test("disarming is allowed with the switch off, since turning a send off is not a send", async () => {
  const r = await runSendOff(
    { id: 9, outputMode: "create_order", automaticBillingGeneration: false, sendEhf: false },
    () => armedStored(),
  );
  assert.equal(r.refused, false);
  assert.equal(r.calls[1].body.sendEhf, false);
  assert.equal(r.calls[1].body.automaticBillingGeneration, false);
});

test("an inactive subscription is not described as still billing", async () => {
  // Measured: a replacement does NOT reactivate one, so saying "goes on billing as it was" of a
  // stopped subscription would be false — and reai_list_subscriptions is careful about exactly
  // that distinction.
  const { text } = await run("reai_update_subscription", { id: 9, invoiceComment: "x" }, () =>
    armedStored({ active: false, sendEhf: false, outputMode: "create_order", automaticBillingGeneration: true }),
  );
  assert.match(text, /INACTIVE/);
  assert.match(text, /does not reactivate it/);
  assert.doesNotMatch(text, /goes on billing as it was/);
});

// ---------------------------------------------------------------------------
// The fourth shape difference: service recipients
// ---------------------------------------------------------------------------

test("a service recipient is mapped, not echoed", async () => {
  const stored = armedStored({
    outputMode: "create_order",
    automaticBillingGeneration: false,
    sendEhf: false,
    serviceRecipients: [
      // As a response carries them: companyId is response-only, companyName becomes name.
      { companyId: 501, companyName: "Datter AS", organizationNumber: "999888777", countryCode: "NO" },
    ],
  });
  const { calls } = await run("reai_update_subscription", { id: 9, invoiceComment: "x" }, () => stored);
  assert.deepEqual(calls[1].body.serviceRecipients, [
    { organizationNumber: "999888777", name: "Datter AS", countryCode: "NO" },
  ]);
  assert.equal("companyId" in calls[1].body.serviceRecipients[0], false, "companyId is response-only");
});

test("a recipient that cannot be written back is refused rather than sent", async () => {
  // Every SubscriptionServiceRecipientRes property is optional, but organizationNumber is REQUIRED
  // on the write — and the API refuses a recipient without one (measured, 400 naming the field).
  const stored = armedStored({
    outputMode: "create_order",
    automaticBillingGeneration: false,
    sendEhf: false,
    serviceRecipients: [{ companyName: "Uten orgnr", countryCode: "NO" }],
  });
  const { calls, result, text } = await run("reai_update_subscription", { id: 9, invoiceComment: "x" }, () => stored);
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.match(text, /no organizationNumber/);
  assert.match(text, /Pass serviceRecipients explicitly/);

  // ...unless the caller says what the list should be, which resolves it.
  const fixed = await run(
    "reai_update_subscription",
    { id: 9, serviceRecipients: [{ organizationNumber: "999888777", name: "Datter AS", countryCode: "NO" }] },
    () => stored,
  );
  assert.notEqual(fixed.result.isError, true);
  assert.equal(fixed.calls[1].body.serviceRecipients[0].organizationNumber, "999888777");
});

test("falsy-but-meaningful line values survive the mapping", async () => {
  const stored = armedStored({
    outputMode: "create_order",
    automaticBillingGeneration: false,
    sendEhf: false,
    lines: [
      { rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1000, discount: 0, comment: "", vatCode: "0", vatRate: 0, amounts: { totalAmount: 1000 } },
    ],
  });
  const { calls } = await run("reai_update_subscription", { id: 9, invoiceComment: "x" }, () => stored);
  const line = calls[1].body.subscriptionLines[0];
  assert.equal(line.discount, 0, "a zero discount is a value, not an absence");
  assert.equal(line.comment, "", "and so is an empty comment");
  assert.equal("vatRate" in line, false);
  assert.equal("amounts" in line, false);
});

test("the refusals with no coverage: nothing given, and a required field nowhere", async () => {
  const nothing = await run("reai_update_subscription", { id: 9 }, () => armedStored());
  assert.equal(nothing.result.isError, true);
  assert.equal(nothing.calls.length, 0, "it must not even read");

  // A stored record missing a required field, and a change that does not supply it.
  const incomplete = await run(
    "reai_update_subscription",
    { id: 9, invoiceComment: "x" },
    () => ({ id: 9, customerId: 12, lines: [{ rowNumber: 1, itemName: "Drift", quantity: 1, unitPrice: 1 }] }),
  );
  assert.equal(incomplete.result.isError, true);
  assert.deepEqual(incomplete.calls.map((c) => c.method), ["GET"]);
  assert.match(incomplete.text, /requires/);
});

/**
 * The arming report used to be computed from `merged` — what was SENT — and the worst consequence was not a
 * wrong sentence but a MISSING one: a caller who sent `sendEhf: false` to stop an unattended invoicing
 * machine, and had it discarded, got no note at all, and the absence of a warning reads as confirmation.
 *
 * Not measured against the live API, deliberately: subscriptions are created ACTIVE, so a throwaway one on a
 * real company could generate an invoice, and the only subscription on the test tenant is a real one. So the
 * tool does not claim to know whether the API discards a disarming value — it reports the response, warns on
 * disagreement, and says when the response cannot answer. These tests pin all three.
 */
const armed = (over = {}) => ({
  ...subscription({ outputMode: "create_invoice", automaticBillingGeneration: true, sendEhf: true }),
  billingTiming: "in_advance",
  currencyCode: "NOK",
  startDate: "2026-01-01",
  lines: [{ itemName: "x", quantity: 1, unitPrice: 5, vatCode: "0" }],
  ...over,
});

async function updateArmed(args, before, after) {
  const calls = [];
  const queue = [{ data: before, status: 200 }, { data: after, status: 200 }];
  const result = await tool("reai_update_subscription").handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => { calls.push(req); return queue.shift(); },
        deepLink: () => "link",
      },
      // allowExternalSend true, so the transmit gate does not pre-empt the reporting under test.
      config: { writeMode: "full", tenantId: 2783, allowExternalSend: true },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

test("a disarming the API discarded is WARNED about, not passed over in silence", async () => {
  const { text } = await updateArmed({ id: 4, sendEhf: false }, armed(), armed());
  assert.match(text, /WARNING: this write sent sendEhf turned OFF/);
  assert.match(text, /STILL SET/);
  assert.match(text, /unattended billing this guards is not stopped/);
  assert.match(text, /reai_deactivate_subscription/, "the way to actually stop it is named");
  // And the armed list must reflect the RESPONSE, which still says sendEhf. Computing it from what was sent
  // would drop it here — the original bug — while the warning above happened to still fire.
  assert.match(text, /Still armed:[^\n]*sendEhf/, "the response says it is armed, so the list must say so");
});

test("a disarming the API honoured is not warned about, and drops out of the armed list", async () => {
  const { text } = await updateArmed({ id: 4, sendEhf: false }, armed(), armed({ sendEhf: false }));
  assert.doesNotMatch(text, /WARNING/);
  assert.match(text, /Still armed: outputMode="create_invoice", automaticBillingGeneration, confirmed/);
  assert.doesNotMatch(text, /Still armed:[^\n]*sendEhf/, "sendEhf must not be listed as still armed");
});

test("arming by this edit is not reported as something carried over", async () => {
  // The old text said "This edit did not change that — it carries over what was already set" even when the
  // caller had just armed it.
  const { text } = await updateArmed({ id: 4, sendEhf: true }, armed({ sendEhf: false }), armed());
  assert.match(text, /sendEhf was armed BY THIS EDIT, not carried over/);
  assert.doesNotMatch(text, /This edit did not change that/);
});

test("a response that omits the arming fields says so rather than implying disarmed", async () => {
  const { text } = await updateArmed({ id: 4, intervalMonths: 3 }, armed(), { id: 4, active: true, lines: [] });
  assert.match(text, /did not answer for outputMode, automaticBillingGeneration, sendEhf/);
  assert.match(text, /could not be confirmed/);
  assert.match(text, /sendEhf=true/, "it must name what was sent");
  assert.doesNotMatch(text, /Still armed/, "an unconfirmable state is not a confirmed one");
});

test("the arming flags are read with the coercion-tolerant predicates, not === true", async () => {
  // The backend coerces "true" and 1. A flag that arms a send is the last place to be strict about spelling,
  // and this repo has a recorded case of `{"sendEhf": "true"}` arming a send the policy scored as harmless.
  for (const value of ["true", 1, "yes"]) {
    const { text } = await updateArmed({ id: 4, intervalMonths: 3 }, armed(), armed({ sendEhf: value }));
    assert.match(text, /Still armed:[^\n]*sendEhf/, `sendEhf=${JSON.stringify(value)} must count as armed`);
  }
});

test("the disarm warning fires in the DEFAULT configuration, not only with external sending enabled", async () => {
  // The tests above pass allowExternalSend: true so the transmit gate cannot pre-empt the reporting under
  // test — which would hide the question of whether the warning is reachable at all for a real caller. It is:
  // `sendEhf` is not in BILLING_SUBSTANCE, so a disarm-ONLY edit does not trip assertTransmitAllowed and
  // reaches the PUT with external sending off. Worth pinning, because a warning that only exists behind the
  // permission it protects against would be close to useless.
  const calls = [];
  const queue = [{ data: armed(), status: 200 }, { data: armed(), status: 200 }];
  const result = await tool("reai_update_subscription").handler(
    { id: 4, sendEhf: false, tenantId: 2783 },
    {
      client: { request: async (req) => { calls.push(req.method); return queue.shift(); }, deepLink: () => "link" },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
      session: {},
    },
  );
  assert.deepEqual(calls, ["GET", "PUT"], "a disarm-only edit must not be gated by the transmit check");
  assert.notEqual(result.isError, true);
  assert.match(result.content.find((c) => c.type === "text").text, /WARNING: this write sent sendEhf turned OFF/);
});

test("disarming is not itself gated as a transmission — you can turn the dangerous thing off", async () => {
  // The trap #140 had with invoiceEmail: if passing the field escalated regardless of VALUE, a caller could
  // not disarm without the permission that arming needs. The escalation is value-aware, and that is worth a
  // test rather than a reading of the code.
  const paths = tool("reai_update_subscription").apiPaths;
  for (const field of ["sendEhf", "automaticBillingGeneration"]) {
    assert.equal(curatedArgsEscalate(paths, { [field]: false }), undefined, `${field}: false must not escalate`);
    const armedCall = curatedArgsEscalate(paths, { [field]: true });
    assert.ok(armedCall, `${field}: true must escalate`);
    assert.equal(armedCall.transmits, true);
  }
  assert.equal(curatedArgsEscalate(paths, { outputMode: "create_order" }), undefined);
  assert.ok(curatedArgsEscalate(paths, { outputMode: "create_invoice" }));
});

test("a CARRIED arming value the response contradicts is warned about — no `given` gate", async () => {
  // The defect #141 found and fixed in reai_update_creditor, reintroduced here in the same shape: gating on
  // the caller having NAMED the field blinds the check to a replacement changing a value it merely carried.
  // Measured before the fix: the write sent sendEhf: false, the response returned true, and the tool narrated
  // the API's arming as the caller's own status quo with no warning at all.
  const { text } = await updateArmed(
    { id: 4, internalComment: "ZZ" },
    armed({ sendEhf: false }),
    armed({ sendEhf: true }),
  );
  assert.match(text, /WARNING: this write sent sendEhf turned OFF/);
  assert.match(text, /STILL SET/);
  assert.match(text, /Still armed:[^\n]*sendEhf/);
  assert.doesNotMatch(text, /This edit did not change that/, "it did change — the API changed it");
});

test("a contradicted disarm is not also reported as the caller arming it", async () => {
  // `armedByThisEdit` keyed on the RESPONSE, so both fired at once and said opposite things. Reachable on a
  // realistic input: SubscriptionRes has no `required` array, so a GET omitting sendEhf is spec-legal.
  const { text } = await updateArmed({ id: 4, sendEhf: false }, armed({ sendEhf: undefined }), armed({ sendEhf: true }));
  assert.match(text, /WARNING: this write sent sendEhf turned OFF/);
  assert.doesNotMatch(text, /armed BY THIS EDIT/, "the caller asked to turn it off");
});

test("a null in the response is not folded into confirmed-disarmed", async () => {
  // bindsToTrue(null) is false, so present-and-null silently dropped the flag out of "confirmed from the
  // response" and suppressed the warning — this tool's own bug relocated from the request to the response.
  const { text } = await updateArmed({ id: 4, sendEhf: false }, armed(), armed({ sendEhf: null }));
  assert.match(text, /did not answer for sendEhf \(present but null\)/);
  assert.match(text, /could not be confirmed/);
  assert.doesNotMatch(text, /Still armed:[^\n]*sendEhf/, "a non-answer is not a confirmation");
});

test("a failed ARMING is reported too, not only a failed disarming", async () => {
  const { text } = await updateArmed({ id: 4, sendEhf: true }, armed({ sendEhf: false }), armed({ sendEhf: false }));
  assert.match(text, /sent sendEhf turned ON and the subscription came back WITHOUT it/);
  assert.match(text, /the safe direction, but not what was asked for/);
});

test("a lost line is warned about, on the one field the response is recorded as disagreeing about", async () => {
  // subscription-read-and-write-shapes-differ measured "a PUT carrying the eight required fields and one line
  // answered 200 … with the second line gone". Asserting the count from the REQUEST on that field of all
  // fields was the wrong half to trust.
  const { text } = await updateArmed({ id: 4, internalComment: "ZZ" }, armed(), armed({ lines: [] }));
  assert.match(text, /WARNING: this write sent 1 line\(s\) and the subscription came back with 0/);
  const ok = await updateArmed({ id: 4, internalComment: "ZZ" }, armed(), armed());
  assert.match(ok.text, /line\(s\) were carried over\. Confirmed from the response/);
});

test("active is read tolerantly, and not reported at all when nothing says", async () => {
  // A strict `=== false` under a comment about Jackson coercion made `active: null` assert billing about a
  // stopped subscription — worse than main, which fell back to the record.
  const nulled = await updateArmed({ id: 4, internalComment: "ZZ" }, armed({ active: false }), armed({ active: null }));
  assert.match(nulled.text, /INACTIVE/, "a null response must fall back to the record");
  const unknown = await updateArmed({ id: 4, internalComment: "ZZ" }, armed({ active: undefined }), armed({ active: undefined }));
  assert.match(unknown.text, /did not report whether it is active; assume it is/);
  assert.doesNotMatch(unknown.text, /goes on billing as it was/, "unknown is not the same as active");
});

test("outputMode is read with the coercion-tolerant predicate, which is why it is exported", async () => {
  // The only export this PR adds to policy.ts had no test exercising it through this tool: the coercion loop
  // covered sendEhf only, so `bindsToCreateInvoice` -> `v === "create_invoice"` survived mutation.
  const { text } = await updateArmed({ id: 4, internalComment: "ZZ" }, armed(), armed({ outputMode: 1 }));
  assert.match(text, /Still armed:[^\n]*outputMode/, "the Jackson ordinal must count as create_invoice");
});
