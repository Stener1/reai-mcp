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

test("a value the API ignored is not reported as a change", async () => {
  // Measured on 2783, and it is two families rather than one rule:
  //   comment, internalComment          omitted KEPT   null KEPT   "" CLEARS
  //   buyerReference, externalReference  omitted EMPTIED  null CLEARS
  // An earlier version REFUSED a null on the first family. A review argued the better fix is to stop
  // claiming a change the API discarded — that covers every ignored field rather than two hardcoded ones,
  // and cannot refuse a call whose intent was already satisfied (a null against an already-empty comment).
  const schema = z.object(tool().inputSchema);
  for (const field of ["comment", "internalComment"]) {
    assert.equal(schema.safeParse({ id: 81, [field]: null }).success, true, `${field} must still parse`);
    // The field must HAVE a value, or a null genuinely matches what is stored and reporting it as applied is
    // correct — that "already empty" case is exactly what the removed refusal got wrong.
    const populated = offer({ [field]: "ZZ has a value" });
    const { calls, result, text } = await run({ id: 81, [field]: null }, () => populated);
    assert.notEqual(result.isError, true, "the write is harmless, so it is not refused");
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
    assert.match(text, /Changed NOTHING/, "the headline must not claim a change the API discarded");
    assert.match(text, /IGNORED by the API/);
    assert.match(text, /EMPTY STRING/, "and must name what actually works");
  }

  // A legitimate change alongside an ignored one is still reported as having happened.
  const mixed = await run({ id: 81, daysUntilDue: 30, comment: null }, (req, n) =>
    n === 1 ? offer() : offer({ daysUntilDue: 30 }),
  );
  assert.match(mixed.text, /Changed daysUntilDue on/);
  assert.doesNotMatch(mixed.text, /Changed daysUntilDue, comment/);

  // And the empty string, which is what clears, must NOT carry a doubt-yourself warning: the API stores it
  // back as null, and comparing "" against null naively flagged every successful clear.
  const emptied = await run({ id: 81, comment: "" }, (req, n) => (n === 1 ? offer() : offer({ comment: null })));
  assert.notEqual(emptied.result.isError, true);
  assert.equal(emptied.calls[1].body.comment, "");
  assert.doesNotMatch(emptied.text, /IGNORED by the API/, "clearing with \"\" must not be reported as ignored");
  assert.match(emptied.text, /Changed comment on/);
});

test("an offer line needs vatCode where an order line does not — and itemName on both", async () => {
  // The title used to claim "which order lines do not require", asserted nothing about order lines, and was
  // FALSE for itemName: `offer-lines-stricter` re-measured it on 2026-08-09 and an order line without
  // itemName is refused with 400 "Produkt er obligatorisk for alle ordrelinjer.". Both schemas are checked
  // here so the asymmetry cannot be restated wrongly again.
  const { salesTools: tools } = await import("../dist/tools/sales.js");
  const offerSchema = z.object(tool().inputSchema);
  const orderSchema = z.object(tools.find((t) => t.name === "reai_update_order").inputSchema);

  // vatCode: required on an offer line, optional on an order line. THIS is the difference.
  assert.equal(offerSchema.safeParse({ id: 81, offerLines: [{ itemName: "x", quantity: 1, unitPrice: 5 }] }).success, false,
    "an offer line without vatCode must be refused");
  assert.equal(orderSchema.safeParse({ id: 1, orderLines: [{ itemName: "x", quantity: 1, unitPrice: 5 }] }).success, true,
    "an order line without vatCode is accepted — vatCode is the one field offers add");

  // itemName: required by the API on BOTH, so neither schema may present it as dispensable.
  assert.equal(offerSchema.safeParse({ id: 81, offerLines: [{ quantity: 1, unitPrice: 5, vatCode: "0" }] }).success, false,
    "an offer line without itemName must be refused");
  const { QUIRKS } = await import("../dist/reai/quirks.js");
  const quirk = QUIRKS.find((q) => q.id === "offer-lines-stricter");
  assert.ok(quirk, "offer-lines-stricter must exist — it is what this asymmetry rests on");
  assert.match(quirk.note, /only in ONE field/);
  assert.match(quirk.note, /Produkt er obligatorisk/, "the order-line refusal must stay recorded");
  // And a valid line on each still parses.
  assert.equal(offerSchema.safeParse({ id: 81, offerLines: [{ itemName: "x", quantity: 1, unitPrice: 5, vatCode: "0" }] }).success, true);
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

test("the body omits nothing even when the RESPONSE omits keys", async () => {
  // The tier claim must depend on this tool's shape, not the API's. Filtering the carry on Object.hasOwn made
  // it depend on the response: measured, a GET omitting `email` produced a body omitting `email`, and the
  // omission gate names that — which is the soft-route mistake reai_update_order was corrected for. Absent
  // keys are now stated as null, which every carried field accepts.
  const op = findOperation("PUT", "/api/offers/{id}");
  const shapes = [
    ["all keys present", offer()],
    ["email absent", (() => { const o = offer(); delete o.email; return o; })()],
    ["deliveryAddress absent", (() => { const o = offer(); delete o.deliveryAddress; return o; })()],
    ["every optional absent", (() => {
      const o = offer();
      for (const f of ["projectId", "issueDate", "comment", "internalComment", "email", "deliveryAddress"]) delete o[f];
      return o;
    })()],
  ];
  for (const [label, response] of shapes) {
    const { calls } = await run({ id: 81, daysUntilDue: 30 }, () => response);
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put, `${label}: no PUT was issued`);
    assert.deepEqual(
      omittedReplacementFields(op, put.body).fields,
      [],
      `${label}: the body omitted a field the replacement-omission gate names`,
    );
  }
});

test("an unreadable existing line does not block the replacement that is meant to fix it", async () => {
  // The refusal for a null line names "pass offerLines explicitly" as the way past it — and the mapper ran
  // unconditionally, so `line[f]` on null threw a TypeError and that recovery path never reached the PUT.
  const lines = [{ itemName: "ZZ new", quantity: 1, unitPrice: 250, vatCode: "0" }];
  const { calls, result } = await run({ id: 81, offerLines: lines }, () => offer({ lines: [null] }));
  assert.notEqual(result.isError, true, "supplying replacements must work even when the old lines are unreadable");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.deepEqual(calls[1].body.offerLines, lines);
});

test("moving an offer to another customer says whose payment terms it kept", async () => {
  const { calls, text } = await run({ id: 81, customerId: 6000 }, (req, n) => {
    if (n === 1) return offer();
    if (req.method === "PUT") return offer({ customerId: 6000 });
    return { daysUntilDue: 45 };
  });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /api/offers/81",
    "PUT /api/offers/81",
    "GET /api/customers/6000",
  ]);
  assert.match(text, /KEPT payment terms of 14 days/);
  assert.match(text, /new customer's own terms are 45 days/);
});

test("a value stored differently from what was sent is flagged", async () => {
  // reai_update_offer: named in test/confirm-against-response.test.mjs as the proof for this tool.
  const { text } = await run({ id: 81, daysUntilDue: 30 }, (req, n) => (n === 1 ? offer() : offer({ daysUntilDue: 14 })));
  assert.match(text, /IGNORED by the API/);
  assert.match(text, /daysUntilDue \(sent 30, still 14\)/);
  assert.match(text, /Check the value is one the API accepts/, "a non-clearable field gets the generic hint");
});

test("an offer with no readable lines is refused rather than having its contents invented", async () => {
  for (const lines of [[], undefined]) {
    const { calls, result, text } = await run({ id: 81, comment: "ZZ" }, () => offer({ lines }));
    assert.equal(result.isError, true, `lines=${JSON.stringify(lines)} must be refused`);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    assert.match(text, /no readable lines/);
  }
});

test("every gate that could make this a softer route is checked, not just the omission one", async () => {
  // The PR's whole claim is "not a softer route than reai_request", and the first version of this file
  // asserted only the omission gate and classifyRequest — leaving half the ladder unchecked.
  const { curatedArgsEscalate, classifyTransmission } = await import("../dist/policy.js");
  assert.equal(classifyTransmission("PUT", "/api/offers/7"), "none");
  assert.ok(!tool().transmits, "an offer update must not be marked as transmitting");
  // No argument may escalate the call, or the tool would be unusable in the default mode for that argument
  // and the description says nothing about it — the trap reai_update_order fell into with invoiceEmail.
  const probes = [{}, ...Object.keys(tool().inputSchema).flatMap((k) => [{ [k]: "probe" }, { [k]: null }, { [k]: 1 }, { [k]: true }])];
  for (const args of probes) {
    assert.equal(
      curatedArgsEscalate(tool().apiPaths, args),
      undefined,
      `${JSON.stringify(args)} escalates the call, which the description does not mention`,
    );
  }
});

test("the link prefers the API's own URL and falls back when it is absent", async () => {
  const withUrl = await run({ id: 81, comment: "ZZ" }, () => offer());
  assert.match(withUrl.text, /https:\/\/app\.reai\.no\/offers\/81/);
  const without = await run({ id: 81, comment: "ZZ" }, () => { const o = offer(); delete o.webUrl; return o; });
  assert.match(without.text, /Open in ReAI: link/, "the deep-link fallback must fire when webUrl is absent");
});

test("the note names only the fields that actually carried a value", async () => {
  // Every carryable field is SENT, nulls included, to satisfy the omission gate — but naming all six told a
  // caller six fields were carried over when all six were null and stayed null.
  const bare = (() => {
    const o = offer();
    for (const f of ["projectId", "issueDate", "internalComment", "email", "deliveryAddress"]) o[f] = null;
    return o;
  })();
  const { calls, text } = await run({ id: 81, daysUntilDue: 30 }, () => bare);
  // The body still states them all, or the tier claim breaks.
  for (const f of ["projectId", "issueDate", "internalComment", "email", "deliveryAddress"]) {
    assert.ok(f in calls[1].body, `${f} must still be sent`);
  }
  assert.doesNotMatch(text, /projectId.*carried over/, "a null field must not be reported as carried over");
  assert.match(text, /comment carried over/, "the one field with a value is still named");
});

test("a carried line missing a required field is refused, not sent as a 400", async () => {
  const { calls, result, text } = await run({ id: 81, comment: "ZZ" }, () =>
    offer({ lines: [{ id: 1, quantity: 1, unitPrice: 5 }] }),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /itemName/);
  assert.match(text, /vatCode/);
  // And passing lines explicitly is the way past it.
  const ok = await run({ id: 81, offerLines: [{ itemName: "x", quantity: 1, unitPrice: 5, vatCode: "0" }] }, () =>
    offer({ lines: [{ id: 1, quantity: 1, unitPrice: 5 }] }),
  );
  assert.notEqual(ok.result.isError, true);
});

test("an array line element is not mistaken for a readable line", async () => {
  // typeof [] === "object", so it passed the old guard and produced offerLines: [{}].
  const { calls, result } = await run({ id: 81, comment: "ZZ" }, () => offer({ lines: [[]] }));
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

test("a null against an already-empty field is reported as applied, not refused", async () => {
  // The removed refusal fired on this: an idempotent caller that always sends the desired state (nulls for
  // empty fields) was told to send "" to clear a field that was already clear, and could never succeed.
  const { calls, result, text } = await run({ id: 81, internalComment: null }, () => offer({ internalComment: null }));
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.doesNotMatch(text, /IGNORED by the API/, "the outcome is what was asked for");
});

test("the kept-terms note states what the record says, not what was sent", async () => {
  // Same principle as reai_update_creditor: a note about money reads from the response. If the API ever
  // stored a different daysUntilDue than was sent, this note would have quoted the request.
  const { text } = await run({ id: 81, customerId: 6000 }, (req, n) => {
    if (n === 1) return offer();
    if (req.method === "PUT") return offer({ customerId: 6000, daysUntilDue: 21 });
    return { daysUntilDue: 45 };
  });
  assert.match(text, /KEPT payment terms of 21 days/, "21 is what the record came back with; 14 was sent");
});
