import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { salesTools } from "../dist/tools/sales.js";
import { classifyRequest } from "../dist/policy.js";
import { omittedReplacementFields, findOperation } from "../dist/reai/spec.js";

/**
 * `reai_update_offer`.
 *
 * The same response/request mismatch as orders, measured on offer 81 on 2783:
 *
 *   GET returns  lines:      [{ id, rowNumber, itemName, comment, quantity, unitPrice, discount,
 *                               vatCode, vatRate, variantId, lineTotal, lineTotalExclVat, lineVat,
 *                               lineDiscount }]
 *   PUT requires offerLines: [{ itemName, comment, quantity, unitPrice, discount, vatCode, variantId }]
 *
 * Seven unaccepted fields against four on an order, and `itemName`/`vatCode` required per line.
 */

const tool = () => {
  const found = salesTools.find((t) => t.name === "reai_update_offer");
  assert.ok(found, "reai_update_offer is not registered");
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
      config: { writeMode: "reversible", tenantId: 2783, allowExternalSend: false },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

/** An offer as the live API returns one, including the seven line fields the PUT does not accept. */
const offer = (overrides = {}) => ({
  id: 81,
  number: "TB-81",
  webUrl: "https://app.reai.no/offers/81",
  currencyCode: "NOK",
  customerId: 5941,
  daysUntilDue: 14,
  issueDate: "2026-08-09",
  comment: "ZZ customer-visible",
  internalComment: "ZZ internal",
  email: "zz@example.invalid",
  projectId: null,
  deliveryAddress: { id: 9, countryCode: "NO", province: null, city: "Oslo", postalCode: "0150", addressPart1: "Prøvegata 1", addressPart2: null },
  lines: [
    {
      id: 501,
      rowNumber: 1,
      itemName: "ZZ line",
      comment: null,
      quantity: 2,
      unitPrice: 300,
      discount: 0,
      vatCode: "0",
      vatRate: 0,
      variantId: null,
      lineTotal: 600,
      lineTotalExclVat: 600,
      lineVat: 0,
      lineDiscount: 0,
    },
  ],
  ...overrides,
});

test("changing one field sends the lines back under the name the PUT wants, stripped", async () => {
  const { calls, text } = await run({ id: 81, daysUntilDue: 30 }, (req, n) => (n === 1 ? offer() : offer({ daysUntilDue: 30 })));
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.equal(calls[1].path, "/api/offers/81");
  const body = calls[1].body;
  assert.ok(Array.isArray(body.offerLines), "the lines must be sent as offerLines");
  assert.equal(body.lines, undefined, "`lines` is not a field the PUT declares");
  // All SEVEN, which is the difference from an order line's four.
  for (const forbidden of ["id", "rowNumber", "vatRate", "lineTotal", "lineTotalExclVat", "lineVat", "lineDiscount"]) {
    assert.equal(body.offerLines[0][forbidden], undefined, `${forbidden} must not be sent back`);
  }
  // The four the PUT requires per line all survive.
  for (const [k, v] of [["itemName", "ZZ line"], ["quantity", 2], ["unitPrice", 300], ["vatCode", "0"]]) {
    assert.equal(body.offerLines[0][k], v, `${k} must survive`);
  }
  assert.equal(body.daysUntilDue, 30, "the caller's change wins");
  assert.match(text, /1 existing line\(s\) read and sent back unchanged/);
});

test("every carryable field is carried, which is what makes the default write mode honest", async () => {
  // The tier claim, asserted rather than described: if this tool ever stopped carrying a field, its body
  // would start omitting one and `reversible` would become the soft route around the omission gate — the
  // exact mistake reai_update_order was corrected for.
  const { calls } = await run({ id: 81, daysUntilDue: 30 }, (req, n) => (n === 1 ? offer() : offer()));
  const body = calls[1].body;
  const omitted = omittedReplacementFields(findOperation("PUT", "/api/offers/{id}"), body);
  assert.deepEqual(omitted.fields, [], "the body this tool sends must omit nothing the PUT declares");
  assert.ok(omitted.documented > 0, "and the gate must actually know this endpoint's fields");
  // A partial body, by contrast, omits six — which is what the raw call is refused for by default.
  const partial = omittedReplacementFields(findOperation("PUT", "/api/offers/{id}"), {
    currencyCode: "NOK", customerId: 1, daysUntilDue: 14, offerLines: [{ itemName: "x", quantity: 1, unitPrice: 1, vatCode: "0" }],
  });
  assert.equal(partial.fields.length, 6, `a partial body should omit six, omitted ${partial.fields.join(",")}`);
  assert.equal(tool().risk, "reversible");
  assert.equal(classifyRequest("PUT", "/api/offers/7"), "reversible");
  // deliveryAddress carries verbatim, request and response being property-for-property identical.
  assert.deepEqual(body.deliveryAddress, offer().deliveryAddress);
  assert.equal(body.email, "zz@example.invalid");
});

test("no changes is refused without even reading", async () => {
  const { calls, result, text } = await run({ id: 81 }, () => offer());
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(text, /nothing was written/i);
});

test("a response that is not an offer is not accepted as a base to merge into", async () => {
  for (const shape of [{}, { data: offer() }, { content: [] }, "not an object"]) {
    const { calls, result, text } = await run({ id: 81, comment: "ZZ" }, () => shape);
    assert.equal(result.isError, true, `${JSON.stringify(shape).slice(0, 30)} must not be a merge base`);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    assert.match(text, /could not be read/);
  }
});

test("issueDate is not required from the record, unlike an order", async () => {
  // The measured asymmetry: OfferReq requires currencyCode, customerId, daysUntilDue and offerLines only.
  const { calls, result } = await run({ id: 81, comment: "ZZ" }, (req, n) => (n === 1 ? offer({ issueDate: null }) : offer()));
  assert.notEqual(result.isError, true, "a missing issueDate must not block an offer update");
  assert.equal(calls.length, 2);
  const required = findOperation("PUT", "/api/offers/{id}").body.required;
  assert.deepEqual([...required].sort(), ["currencyCode", "customerId", "daysUntilDue", "offerLines"]);
});

test("a field the PUT requires but the record lacks is named, not sent as undefined", async () => {
  const { calls, result, text } = await run({ id: 81, comment: "ZZ" }, () => offer({ daysUntilDue: null }));
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /daysUntilDue/);
});

test("nullable fields can be cleared, and null reaches the body", async () => {
  const schema = z.object(tool().inputSchema);
  for (const field of ["comment", "internalComment", "email", "projectId", "issueDate"]) {
    const parsed = schema.safeParse({ id: 81, [field]: null });
    assert.equal(parsed.success, true, `${field} must accept null`);
    assert.equal(parsed.data[field], null, `${field}: null must survive parsing`);
  }
  const { calls } = await run({ id: 81, comment: null }, (req, n) => (n === 1 ? offer() : offer()));
  assert.equal(calls[1].body.comment, null);
});

test("an offer line must carry itemName and vatCode, which order lines do not require", async () => {
  const schema = z.object(tool().inputSchema);
  assert.equal(schema.safeParse({ id: 81, offerLines: [{ quantity: 1, unitPrice: 5 }] }).success, false,
    "offer lines require itemName and vatCode");
  assert.equal(schema.safeParse({ id: 81, offerLines: [{ itemName: "x", quantity: 1, unitPrice: 5, vatCode: "0" }] }).success, true);
});

test("a null line element is refused rather than thrown", async () => {
  const { calls, result, text } = await run({ id: 81, comment: "ZZ" }, () => offer({ lines: [null] }));
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /cannot read/);
});

test("the lost-update window is disclosed", () => {
  assert.match(tool().description, /lost-update|between the read and the write/i);
  assert.match(tool().description, /ETag|If-Match|version field/);
});
