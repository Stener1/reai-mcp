import { test } from "node:test";
import assert from "node:assert/strict";
import { salesTools } from "../dist/tools/sales.js";
import { classifyRequest, classifyTransmission } from "../dist/policy.js";
import { z } from "zod";

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
  // Present because the handler prefers the API's own URL over a guessed deep link, and that is the branch
  // that fires live — the first version of this fixture omitted it, so only the fallback was ever exercised.
  webUrl: "https://app.reai.no/orders/4105",
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
      // The documented OrderLineAmountsRes shape, not an invented {net,vat,gross} — this is one of the four
      // fields the PUT does not accept, so getting its shape right is the point of having it here.
      amounts: { totalAmount: 1250, vatRate: 25, vat: 250, discountAmount: 0, subTotal: 1000, totalExclVatAmount: 1000 },
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
  const { calls, result, text } = await run({ id: 4105, comment: "ZZ" }, () => order({ invoiceId: 771, status: "closed" }));
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

test("a value stored differently from what was sent is flagged", async () => {
  const { text } = await run({ id: 4105, daysUntilDue: 30 }, (req, n) => (n === 1 ? order() : order({ daysUntilDue: 14 })));
  assert.match(text, /IGNORED by the API/);
  assert.match(text, /daysUntilDue \(sent 30, still 14\)/);
  assert.match(text, /Check the value is one the API accepts/, "a non-clearable field gets the generic hint");
});

test("updating an order sits at the tier the omission gate already imposes, and transmits nothing", async () => {
  // NOT reversible, though `classifyRequest` says the path is. The body this tool sends omits `invoiceEmail`
  // — it cannot read it — and `omittedReplacementFields` refuses exactly that omission for a raw PUT in the
  // default mode. A reversible curated tool would therefore have been the soft route around a gate the
  // escape hatch is subject to, which is the one thing a curated tool must never be.
  assert.equal(tool().risk, "irreversible");
  assert.ok(!tool().transmits);
  // The path itself is reversible; the omission is what escalates it. Both asserted, since the gap between
  // them is the whole reason for the tier.
  assert.equal(classifyRequest("PUT", "/api/orders/7"), "reversible");
  const { omittedReplacementFields, findOperation } = await import("../dist/reai/spec.js");
  const omitted = omittedReplacementFields(findOperation("PUT", "/api/orders/{id}"), {
    currencyCode: "NOK", customerId: 1, daysUntilDue: 14, issueDate: "2026-08-09", orderLines: [{ quantity: 1, unitPrice: 1 }],
  });
  assert.ok(omitted.fields.includes("invoiceEmail"), "the gate this tier answers to must still name invoiceEmail");
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

test("invoiceEmail is an argument because it can never be read back", async () => {
  // UpdateOrderReq declares it; OrderRes does not. So it cannot be carried, and listing it among the
  // carried fields would have looked like preservation while preserving nothing.
  const { findOperation } = await import("../dist/reai/spec.js");
  assert.ok(findOperation("PUT", "/api/orders/{id}")?.body?.fields?.invoiceEmail, "the PUT should accept it");
  const live = order();
  assert.equal("invoiceEmail" in live, false, "the response does not carry it — that is the whole problem");

  assert.ok(tool().inputSchema.invoiceEmail, "so it must be settable explicitly");
  const { calls, text } = await run({ id: 4105, invoiceEmail: "zz@example.invalid" }, (req, n) => (n === 1 ? order() : order()));
  assert.equal(calls[1].body.invoiceEmail, "zz@example.invalid");
  assert.match(text, /invoiceEmail/, "every update must say it cannot be preserved");
});

test("a value the API ignored is not reported as a change", async () => {
  // Measured on 2783, and it is two families rather than one rule:
  //   comment, internalComment          omitted KEPT   null KEPT   "" CLEARS
  //   buyerReference, externalReference  omitted EMPTIED  null CLEARS
  // An earlier version REFUSED a null on the first family. A review argued the better fix is to stop
  // claiming a change the API discarded — that covers every ignored field rather than two hardcoded ones,
  // and cannot refuse a call whose intent was already satisfied (a null against an already-empty comment).
  const schema = z.object(tool().inputSchema);
  for (const field of ["comment", "internalComment"]) {
    assert.equal(schema.safeParse({ id: 4105, [field]: null }).success, true, `${field} must still parse`);
    // The field must HAVE a value, or a null genuinely matches what is stored and reporting it as applied is
    // correct — that "already empty" case is exactly what the removed refusal got wrong.
    const populated = order({ [field]: "ZZ has a value" });
    const { calls, result, text } = await run({ id: 4105, [field]: null }, () => populated);
    assert.notEqual(result.isError, true, "the write is harmless, so it is not refused");
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
    assert.match(text, /Changed NOTHING/, "the headline must not claim a change the API discarded");
    assert.match(text, /IGNORED by the API/);
    assert.match(text, /EMPTY STRING/, "and must name what actually works");
  }

  // A legitimate change alongside an ignored one is still reported as having happened.
  const mixed = await run({ id: 4105, daysUntilDue: 30, comment: null }, (req, n) =>
    n === 1 ? order() : order({ daysUntilDue: 30 }),
  );
  assert.match(mixed.text, /Changed daysUntilDue on/);
  assert.doesNotMatch(mixed.text, /Changed daysUntilDue, comment/);

  // buyerReference and externalReference DO honour a null — measured — so it must reach the body.
  const cleared = await run(
    { id: 4105, buyerReference: null, externalReference: null },
    (req, n) => (n === 1 ? order({ buyerReference: "ZZ-REF", externalReference: "ZZ-EXT" }) : order()),
  );
  assert.equal(cleared.calls[1].body.buyerReference, null);
  assert.equal(cleared.calls[1].body.externalReference, null);

  // And the empty string, which is what clears, must NOT carry a doubt-yourself warning: the API stores it
  // back as null, and comparing "" against null naively flagged every successful clear.
  const emptied = await run({ id: 4105, comment: "" }, (req, n) => (n === 1 ? order() : order({ comment: null })));
  assert.notEqual(emptied.result.isError, true);
  assert.equal(emptied.calls[1].body.comment, "");
  assert.doesNotMatch(emptied.text, /IGNORED by the API/, "clearing with \"\" must not be reported as ignored");
  assert.match(emptied.text, /Changed comment on/);
});

test("replacement lines can carry accrual settings", async () => {
  // Same trap: without a safeParse this passed with `orderLine` restored in place of `orderLineReplacement`,
  // because the handler never strips anything.
  const line = { itemName: "ZZ", quantity: 1, unitPrice: 100, vatCode: "0", accrualEnabled: true, accrualPeriod: "2026-08", accrualPeriodCount: 3 };
  const parsed = z.object(tool().inputSchema).safeParse({ id: 4105, orderLines: [line] });
  assert.equal(parsed.success, true);
  assert.deepEqual(
    parsed.data.orderLines[0],
    line,
    "zod strips what it does not declare, so an undeclared accrual field would vanish here",
  );

  const { calls } = await run({ id: 4105, orderLines: [line] }, () => order());
  assert.equal(calls[1].body.orderLines[0].accrualEnabled, true);
  assert.equal(calls[1].body.orderLines[0].accrualPeriodCount, 3);
});

test("a response that is not an order is not accepted as a base to merge into", async () => {
  for (const shape of [{}, { data: order() }, { content: [] }, "not an object"]) {
    const { calls, result, text } = await run({ id: 4105, comment: "ZZ" }, () => shape);
    assert.equal(result.isError, true, `${JSON.stringify(shape).slice(0, 30)} must not be a merge base`);
    assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
    assert.match(text, /could not be read/);
  }
});

test("the lost-update window is disclosed rather than papered over", () => {
  assert.match(tool().description, /lost-update|between the read and the write/i);
  assert.match(tool().description, /ETag|If-Match|version field/);
});

test("moving an order to another customer says whose payment terms it kept", async () => {
  // daysUntilDue is required and non-nullable, so the replacement carries the number the order already had —
  // which belonged to the previous customer. Changing it silently would be a money decision the caller did
  // not ask for, so the tool names the discrepancy instead.
  const { calls, text } = await run({ id: 4105, customerId: 6000 }, (req, n) => {
    if (n === 1) return order();
    if (req.method === "PUT") return order({ customerId: 6000 });
    return { daysUntilDue: 30 };
  });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /api/orders/4105",
    "PUT /api/orders/4105",
    "GET /api/customers/6000",
  ]);
  assert.match(text, /KEPT payment terms of 14 days/);
  assert.match(text, /new customer's own terms are 30 days/);
});

test("a failed customer read does not undo a write that already succeeded", async () => {
  const { result, text } = await run({ id: 4105, customerId: 6000 }, (req, n) => {
    if (n === 1) return order();
    if (req.method === "PUT") return order({ customerId: 6000 });
    throw new Error("customer read failed");
  });
  assert.notEqual(result.isError, true, "the PUT succeeded; a failed follow-up read must not report failure");
  assert.match(text, /could not be read/);
});

test("the link comes from the API's own URL when it returns one", async () => {
  // The handler prefers res.data.webUrl over a guessed deep link, and that is the branch that fires live.
  const { result } = await run({ id: 4105, comment: "ZZ" }, (req, n) => (n === 1 ? order() : order()));
  const link = JSON.stringify(result);
  assert.match(link, /https:\/\/app\.reai\.no\/orders\/4105/, "the API's own URL must win over a guess");
});

test("an unreadable existing line does not block the replacement that is meant to fix it", async () => {
  // The refusal for a null line names "pass orderLines explicitly" as the way past it — and the mapper ran
  // unconditionally, so `line[f]` on null threw a TypeError and that recovery path never reached the PUT.
  // Found by Codex on the offer sibling; the same bug was here.
  const lines = [{ itemName: "ZZ new", quantity: 1, unitPrice: 250, vatCode: "0" }];
  const { calls, result } = await run({ id: 4105, orderLines: lines }, () => order({ lines: [null] }));
  assert.notEqual(result.isError, true, "supplying replacements must work even when the old lines are unreadable");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.deepEqual(calls[1].body.orderLines, lines);
});

test("a null against an already-empty field is reported as applied, not refused", async () => {
  // The removed refusal fired on this: an idempotent caller that always sends the desired state (nulls for
  // empty fields) was told to send "" to clear a field that was already clear, and could never succeed.
  const { calls, result, text } = await run({ id: 4105, internalComment: null }, () => order({ internalComment: null }));
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.doesNotMatch(text, /IGNORED by the API/, "the outcome is what was asked for");
});
