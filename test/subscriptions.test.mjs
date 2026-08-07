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
          return { data: response, status: 200 };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783 },
      session: {},
    },
  );
  return { calls, text: result.content.find((c) => c.type === "text").text };
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

test("the update is described as the replacement it is", async () => {
  const description = tool("reai_update_subscription").description;
  assert.match(description, /full REPLACEMENT, not a patch/);
  assert.match(description, /read it with reai_get_subscription first/);
  // The required fields are required on the update too, because the API replaces the record.
  const schema = tool("reai_update_subscription").inputSchema;
  for (const field of ["customerId", "startDate", "intervalMonths", "outputMode", "automaticBillingGeneration", "subscriptionLines"]) {
    assert.equal(schema[field].isOptional(), false, `${field} must be required on a replacement`);
  }
  const { calls } = await run(
    "reai_update_subscription",
    {
      id: 4,
      customerId: 12,
      startDate: "2026-01-01",
      intervalMonths: 1,
      billingTiming: "in_advance",
      currencyCode: "NOK",
      outputMode: "create_order",
      automaticBillingGeneration: false,
      subscriptionLines: [{ itemName: "Drift", quantity: 1, unitPrice: 1000 }],
    },
    { id: 4 },
  );
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, "/api/subscriptions/4");
  assert.equal(calls[0].body.id, undefined, "the id belongs in the path, not the body");
  assert.equal(calls[0].body.customerId, 12);
});

test("a line needs enough to bill", () => {
  const line = tool("reai_create_subscription").inputSchema.subscriptionLines;
  assert.equal(line.safeParse([]).success, false, "a subscription with no lines bills nothing");
  assert.equal(line.safeParse([{ itemName: "Drift", quantity: 1, unitPrice: 100 }]).success, true);
  assert.equal(line.safeParse([{ quantity: 1, unitPrice: 100 }]).success, false, "itemName is required");
});

// The first version of the create description said "Created INACTIVE: nothing is produced
// until reai_activate_subscription", and gave that as the reason creating one is ordinary
// reversible work. A live create returned active: true. The claim was false, and it was the
// kind that makes someone comfortable — so what actually keeps a new subscription harmless
// is automaticBillingGeneration: false, not its newness.
test("the create tool does not claim an inert draft stage", async () => {
  const description = tool("reai_create_subscription").description;
  assert.match(description, /Created ACTIVE/);
  assert.doesNotMatch(description, /Created INACTIVE/);
  assert.match(description, /automaticBillingGeneration: false/);
  assert.match(tool("reai_activate_subscription").description, /already active/);

  // And the note reports what the API returned rather than what the description expects.
  const active = await run("reai_create_subscription", {
    customerId: 1, startDate: "2026-09-01", intervalMonths: 1, billingTiming: "in_advance",
    currencyCode: "NOK", outputMode: "create_order", automaticBillingGeneration: false,
    subscriptionLines: [{ itemName: "x", quantity: 1, unitPrice: 1 }],
  }, { id: 9, active: true });
  assert.match(active.text, /Created subscription 9 — ACTIVE/);
});

// The arming state lives on the RECORD, and activate carries no body — so the argument gate
// has nothing to inspect. Without reading the subscription first, one call in `full` mode
// with sending OFF resumes automatic numbered invoicing over Peppol: the exact thing that
// switch exists to prevent, and reai_generate_subscription_billing — a strictly smaller
// action, one billing — is already gated on it.
test("activating an armed subscription is refused when sending is off", async () => {
  const armedRecord = subscription({
    active: false,
    automaticBillingGeneration: true,
    outputMode: "create_invoice",
    sendEhf: true,
  });
  const attempt = async (allowExternalSend, record) => {
    const calls = [];
    const ctx = {
      client: {
        request: async (req) => {
          calls.push(req);
          return { data: record, status: 200 };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend },
      session: {},
    };
    try {
      const r = await tool("reai_activate_subscription").handler({ id: 4, tenantId: 2783 }, ctx);
      return { calls, text: r.content[0].text };
    } catch (err) {
      return { calls, error: String(err.message ?? err) };
    }
  };

  const blocked = await attempt(false, armedRecord);
  assert.ok(blocked.error, "an armed subscription must not be re-armed with sending off");
  assert.match(blocked.error, /automaticBillingGeneration/);
  assert.match(blocked.error, /sendEhf/);
  // And it must be refused BEFORE the activate call is made, not after.
  assert.deepEqual(
    blocked.calls.map((c) => c.method),
    ["GET"],
    "the refusal has to happen before the POST, or the subscription is already running",
  );

  const allowed = await attempt(true, armedRecord);
  assert.ok(!allowed.error, "with sending on it is the operator's call");
  assert.match(allowed.text, /it now bills on its own/);

  // A subscription that bills only on request is not arming anything, so it stays usable
  // with sending off — otherwise restarting an ordinary one would need the dangerous mode.
  const manual = await attempt(false, subscription({ active: false }));
  assert.ok(!manual.error, "an unarmed subscription must still be activatable");
  assert.match(manual.text, /bills only when reai_generate_subscription_billing is called/);
});

// The API answers with counts. The first version ignored all four and said "Billed
// subscription N" whatever came back, so a run that generated nothing read as success.
test("generate reports what the API said it produced", async () => {
  const nothing = await run("reai_generate_subscription_billing", { id: 4 }, {
    generatedBillings: 0, generatedOrders: 0, generatedInvoices: 0, safetyCapHits: 0,
  });
  assert.match(nothing.text, /Nothing was generated/);
  assert.match(nothing.text, /nothing reached the customer/);
  assert.doesNotMatch(nothing.text, /^Billed subscription/);

  const many = await run("reai_generate_subscription_billing", { id: 4 }, {
    generatedBillings: 8, generatedOrders: 8, generatedInvoices: 0, safetyCapHits: 0,
  });
  assert.match(many.text, /Generated 8 billing\(s\)/);
  assert.match(many.text, /8 order\(s\) and 0 invoice\(s\)/);

  const invoiced = await run("reai_generate_subscription_billing", { id: 4 }, {
    generatedBillings: 2, generatedOrders: 0, generatedInvoices: 2, safetyCapHits: 0,
  });
  assert.match(invoiced.text, /numbered documents and have left for the customer/);

  const capped = await run("reai_generate_subscription_billing", { id: 4 }, {
    generatedBillings: 3, generatedOrders: 3, generatedInvoices: 0, safetyCapHits: 2,
  });
  assert.match(capped.text, /safety cap 2 time\(s\); some periods were NOT generated/);

  // An absent count is unknown, never zero and never success.
  const silent = await run("reai_generate_subscription_billing", { id: 4 }, {});
  assert.match(silent.text, /did not report how much it produced/);
  assert.doesNotMatch(silent.text, /Nothing was generated/);
});

// serviceRecipients is on the write schema and returned by the read, and the update is a
// full replacement — so leaving it out of the tool meant "read it first and send back what
// you do not intend to change" was impossible to follow.
test("the write schema can express everything the read returns", () => {
  for (const name of ["reai_create_subscription", "reai_update_subscription"]) {
    const schema = tool(name).inputSchema;
    assert.ok(schema.serviceRecipients, `${name} must be able to send serviceRecipients`);
    assert.equal(
      schema.serviceRecipients.safeParse([{ organizationNumber: "123456789", name: "Mottaker AS" }]).success,
      true,
    );
  }
});
