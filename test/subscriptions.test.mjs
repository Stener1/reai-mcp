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
