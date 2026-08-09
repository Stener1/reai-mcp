import { test } from "node:test";
import assert from "node:assert/strict";
import { salesTools } from "../dist/tools/sales.js";
import { classifyRequest, classifyTransmission } from "../dist/policy.js";

/**
 * `reai_update_order`.
 *
 * The sales toolset could create, list, read and delete an order but not change one, so the only route to
 * `PUT /api/orders/{id}` was `reai_request` — and that PUT is a full replacement whose RESPONSE DOES NOT
 * MATCH ITS REQUEST. Three separate mismatches, all measured against order 4105 on tenant 2783:
 *
 *   GET returns  lines: [{ id, itemName, comment, quantity, unitPrice, discount, vatCode, vatTitle,
 *                          vatRate, variantId, amounts, accrual… }]
 *   PUT requires orderLines: [{ itemName, comment, quantity, unitPrice, discount, vatCode, variantId,
 *                               accrual… }]                       <- renamed, and 4 fields it does not declare
 *
 * and `comment`, `internalComment`, `buyerReference`, `externalReference`, `projectId`, `invoiceEmail` are
 * optional, so a PUT that omits them empties them.
 */

const tool = () => {
  const found = salesTools.find((t) => t.name === "reai_update_order");
  assert.ok(found, "reai_update_order is not registered");
  return found;
};

async function run(args, responses) {
  const calls = [];
  const result = await tool().handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => {
          calls.push(req);
          return { data: typeof responses === "function" ? responses(req, calls.length) : responses, status: 200 };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

/** An order as the live API returns one, including the four line fields the PUT does not accept. */
const order = (overrides = {}) => ({
  id: 4105,
  number: "OR-4105",
  status: "open",
  invoiceId: null,
  sendEhf: false,
  currencyCode: "NOK",
  customerId: 5941,
  daysUntilDue: 14,
  issueDate: "2026-08-07",
  comment: "ZZ customer-visible",
  internalComment: null,
  buyerReference: null,
  externalReference: null,
  projectId: null,
  lines: [
    {
      id: 99001,
      itemName: "ZZ line",
      comment: null,
      quantity: 2,
      unitPrice: 500,
      discount: 0,
      vatCode: "3",
      vatTitle: "Utgående 25 %",
      vatRate: 25,
      variantId: null,
      amounts: { net: 1000, vat: 250, gross: 1250 },
      accrualEnabled: false,
    },
  ],
  ...overrides,
});

test("changing one field reads first and sends the lines back under the name the PUT wants", async () => {
  const { calls, text } = await run({ id: 4105, daysUntilDue: 30 }, (req, n) => (n === 1 ? order() : order({ daysUntilDue: 30 })));
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"], "it must read before replacing");
  assert.equal(calls[1].path, "/api/orders/4105");
  const body = calls[1].body;

  // Renamed: the response's `lines` becomes the request's `orderLines`.
  assert.ok(Array.isArray(body.orderLines), "the lines must be sent as orderLines");
  assert.equal(body.lines, undefined, "`lines` is not a field the PUT declares");
  assert.equal(body.orderLines.length, 1);

  // And stripped of everything the PUT does not declare — three of these are computed by the API.
  for (const forbidden of ["id", "vatTitle", "vatRate", "amounts"]) {
    assert.equal(body.orderLines[0][forbidden], undefined, `${forbidden} must not be sent back`);
  }
  // While the fields it DOES declare survive with their values.
  assert.equal(body.orderLines[0].quantity, 2);
  assert.equal(body.orderLines[0].unitPrice, 500);
  assert.equal(body.orderLines[0].vatCode, "3");
  assert.equal(body.orderLines[0].itemName, "ZZ line");

  // Required by the PUT, so they come from the record rather than being dropped.
  assert.equal(body.currencyCode, "NOK");
  assert.equal(body.customerId, 5941);
  assert.equal(body.issueDate, "2026-08-07");
  assert.equal(body.daysUntilDue, 30, "the caller's change wins");
  // Optional, so a partial PUT would have emptied it.
  assert.equal(body.comment, "ZZ customer-visible", "an optional field must be carried, not dropped");
  assert.match(text, /1 existing line\(s\) read and sent back unchanged/);
});

test("sendEhf is never sent, and an order that already has it is refused", async () => {
  const { calls, result, text } = await run({ id: 4105, comment: "ZZ" }, () => order({ sendEhf: true }));
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.match(text, /sendEhf/);
  assert.match(text, /external transmission|leaves the tenant/);
  // The reason it matters, asserted rather than described: that body IS an external send per the policy.
  assert.equal(classifyTransmission("PUT", "/api/orders/7", { sendEhf: true }), "external");
  assert.equal(classifyTransmission("PUT", "/api/orders/7", { sendEhf: false }), "none");
});

test("an already-invoiced order is refused rather than replaced on unestablished behaviour", async () => {
  const { calls, result, text } = await run({ id: 4105, comment: "ZZ" }, () => order({ invoiceId: 771, status: "invoiced" }));
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /invoiceId 771/);
  assert.match(text, /not established/);
  assert.match(text, /reai_credit_invoice/, "the real remedy is named");
});

test("no changes is refused without even reading", async () => {
  const { calls, result, text } = await run({ id: 4105 }, () => order());
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(text, /nothing was written/i);
});

test("explicit orderLines replace the existing ones", async () => {
  const lines = [{ itemName: "ZZ new", quantity: 1, unitPrice: 250, vatCode: "3" }];
  const { calls, text } = await run({ id: 4105, orderLines: lines }, (req, n) => (n === 1 ? order() : order()));
  assert.deepEqual(calls[1].body.orderLines, lines);
  assert.match(text, /1 line\(s\) replaced/);
});

test("an order with no readable lines is refused rather than having its contents invented", async () => {
  const { calls, result, text } = await run({ id: 4105, comment: "ZZ" }, () => order({ lines: [] }));
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /no readable lines/);
});

test("a value the API did not store is reported against what was sent", async () => {
  const { text } = await run({ id: 4105, daysUntilDue: 30 }, (req, n) => (n === 1 ? order() : order({ daysUntilDue: 14 })));
  assert.match(text, /WARNING/);
  assert.match(text, /daysUntilDue: sent 30, stored 14/);
});

test("updating an order is reversible and transmits nothing", () => {
  assert.equal(tool().risk, "reversible");
  assert.ok(!tool().transmits);
  // In step with the raw call, so the curated tool is not a harder route than reai_request.
  assert.equal(classifyRequest("PUT", "/api/orders/7"), "reversible");
  assert.equal(classifyTransmission("PUT", "/api/orders/7"), "none");
  // And it does not offer the one field that would change that.
  assert.equal(tool().inputSchema.sendEhf, undefined, "sendEhf must not be an argument");
});

test("a sendEhf that only COERCES to true is still refused", async () => {
  // The backend is Jackson, whose default coercion binds "true", "1", 1, "yes" and "on" to boolean true —
  // the repo has a recorded case where `{"sendEhf": "true"}` armed a send the policy scored as sending
  // nothing. A `=== true` check here would read those records as unarmed and then re-send the flag on an
  // edit that had nothing to do with sending. This is the safety direction: ambiguous counts as armed.
  for (const value of [true, "true", "TRUE", " true ", "1", 1, "yes", "on"]) {
    const { calls, result, text } = await run({ id: 4105, comment: "ZZ" }, () => order({ sendEhf: value }));
    assert.equal(result.isError, true, `sendEhf ${JSON.stringify(value)} must be refused`);
    assert.deepEqual(calls.map((c) => c.method), ["GET"], `sendEhf ${JSON.stringify(value)} reached a write`);
    assert.match(text, /sendEhf/);
  }
  // And the genuinely-unarmed shapes still proceed, or the tool would refuse every order.
  for (const value of [false, "false", "0", 0, null, undefined]) {
    const { calls, result } = await run({ id: 4105, comment: "ZZ" }, (req, n) => (n === 1 ? order({ sendEhf: value }) : order()));
    assert.notEqual(result.isError, true, `sendEhf ${JSON.stringify(value)} must not block an ordinary edit`);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
    // Whatever the record said, the flag is never in the body this tool sends.
    assert.equal("sendEhf" in calls[1].body, false, "sendEhf must never be sent");
  }
});
