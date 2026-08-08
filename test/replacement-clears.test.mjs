import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRequest, classifyPaymentRouting, paymentRoutingFieldNames } from "../dist/policy.js";
import { getSpecIndex, omittedReplacementFields, resolveOperation } from "../dist/reai/spec.js";
import { quirksFor } from "../dist/reai/quirks.js";
import { allTools } from "../dist/server.js";

const rawRequest = () => allTools.find((x) => x.name === "reai_request");

/**
 * A full-replacement write that CARRIES a payment destination can erase it by omission.
 *
 * Found by sweeping the document for full-replacement writes and asking which of them the
 * payment-routing guard cannot see. Worth stating what actually narrowed it, because the first
 * account of this claimed more method than there was: "a PUT with no PATCH sibling" selected
 * every PUT in the API, since no path here has both verbs. The discriminating filter was
 * carrying a payment-destination field that is not required. That guard
 * escalates a body that CONTAINS a destination, so a body whose danger is leaving one out is
 * invisible to it. Two paths turned out to do exactly that, measured on a live tenant:
 *
 *   PUT /api/company-banks/{id} {name, countryCode, currency} → 200, bban AND iban emptied
 *   PUT /api/creditors/{id} {name}                            → 200, bankAccountNumber null
 *
 * Both intents were a rename.
 */

const ROUTING = new Set([...paymentRoutingFieldNames]);
const concrete = (path) => path.replace(/\{[^}]+\}/g, "7");

/** Request schemas reachable by a PUT, with the destinations they carry and what is required. */
function replacementsCarryingADestination() {
  const index = getSpecIndex();
  const out = [];
  for (const op of index.operations) {
    if (op.method !== "PUT" || op.internal) continue;
    const fields = op.body?.fields ?? {};
    const destinations = Object.keys(fields).filter((f) => ROUTING.has(f.toLowerCase()));
    if (destinations.length === 0) continue;
    // The REQUIRED list, which is the only thing that decides whether a field can be left out.
    //
    // The first version read a trailing "?" on the field descriptor as "optional". It is not:
    // build-spec-index.mjs writes that from whether the type includes null, so it means NULLABLE.
    // CompanyBankReq.bban is optional and indexed as "string" — so the sweep called it required
    // and caught company-banks only because `swiftCode` happens to be nullable. It reached the
    // right answer for the wrong reason, and a schema with an optional non-nullable destination
    // and nothing else would have been skipped entirely.
    const required = new Set(op.body?.required ?? []);
    const clearable = destinations.filter((d) => !required.has(d));
    out.push({ path: op.path, destinations, clearable });
  }
  return out;
}

test("the sweep reads optionality from the required list, not from nullability", () => {
  // The two are different and this file conflated them. CompanyBankReq.bban is the witness:
  // omittable, and NOT nullable, so a nullability test calls it required.
  const bank = getSpecIndex().operations.find(
    (o) => o.method === "PUT" && o.path === "/api/company-banks/{id}",
  );
  assert.ok(bank, "expected the company-bank PUT in the index");
  assert.equal(bank.body.fields.bban, "string", "bban is not nullable — that is the whole trap");
  assert.ok(!(bank.body.required ?? []).includes("bban"), "yet it is not required");
  const found = replacementsCarryingADestination().find((r) => r.path === "/api/company-banks/{id}");
  assert.ok(found.clearable.includes("bban"), "so the sweep must call bban clearable");
});

test("the sweep still finds the shape it is about", () => {
  const found = replacementsCarryingADestination();
  assert.ok(
    found.length >= 3,
    `expected PUTs carrying a payment destination; found ${found.length} — if the spec or the ` +
      `field set changed shape this sweep may be looking at nothing`,
  );
});

test("every full-replacement PUT that can lose a payment destination is irreversible", () => {
  const exposed = [];
  for (const { path, clearable } of replacementsCarryingADestination()) {
    if (clearable.length === 0) continue; // required, so it cannot be omitted
    if (classifyRequest("PUT", concrete(path)) !== "irreversible") {
      exposed.push(`${path} can clear ${clearable.join(", ")} by omission`);
    }
  }
  assert.deepEqual(
    exposed,
    [],
    "a body that satisfies the schema without naming the account clears it, and the " +
      "payment-routing rule cannot see an omission — so the path itself has to be gated",
  );
});

test("a required destination is NOT swept up, because it cannot be omitted", () => {
  // /api/reconciliation-rules/{id} carries accountNumber and requires it. It is irreversible for
  // its own reasons; the point here is that the sweep distinguishes the two cases rather than
  // gating every path that mentions an account.
  const rules = replacementsCarryingADestination().find((r) => r.path.includes("reconciliation-rules"));
  assert.ok(rules, "expected the reconciliation-rule PUT to carry a destination");
  assert.deepEqual(rules.clearable, [], "accountNumber is required there, so omission is impossible");
});

test("the rule covers replacement only, and does not spread", () => {
  // The class is REPLACING. Creating cannot clear what is not there yet.
  assert.equal(classifyRequest("POST", "/api/company-banks"), "reversible");
  assert.equal(classifyRequest("POST", "/api/creditors"), "reversible");
  assert.equal(classifyRequest("PUT", "/api/company-banks/7"), "irreversible");
  assert.equal(classifyRequest("PUT", "/api/creditors/7"), "irreversible");
  // And it must not reach a neighbour carrying no destination.
  assert.equal(classifyRequest("PUT", "/api/debtors/7"), "reversible");
});

test("what a create is classified as depends on its BODY, which the path test cannot see", () => {
  // "Creating stays reversible" is true of the PATH and not of the effective classification: a
  // creditor created with an account number escalates on the routing axis, because
  // /api/creditors is not in ADDING_IS_ORDINARY and a company bank is. The first version of the
  // test above asserted the path only and read as a claim about the whole pipeline.
  const routed = (method, path, body) =>
    classifyPaymentRouting(classifyRequest(method, path), path, body, method);
  assert.equal(routed("POST", "/api/creditors", { name: "x" }), "reversible");
  assert.equal(
    routed("POST", "/api/creditors", { name: "x", bankAccountNumber: "15201353103" }),
    "irreversible",
    "an account number arriving at creation is still a destination the routing axis escalates",
  );
  // The company-bank exemption is the deliberate asymmetry, and it is load-bearing for the
  // live suite, which creates one in the default mode.
  assert.equal(
    routed("POST", "/api/company-banks", { name: "x", bban: "15201353103" }),
    "reversible",
    "ADDING_IS_ORDINARY exempts this one; if that changes, smoke-write can no longer create a bank",
  );
});

test("PATCH is left to the routing rule because it does not replace", () => {
  // Measured on a live tenant: a name-only PATCH on a supplier left bankAccountNumber, iban and
  // swiftCode untouched — with the precondition asserted first, since an earlier attempt at this
  // compared null to null and proved nothing. So the PUT-only scope is evidence, not assumption.
  const routed = (method, path, body) =>
    classifyPaymentRouting(classifyRequest(method, path), path, body, method);
  assert.equal(classifyRequest("PATCH", "/api/suppliers/7"), "reversible");
  assert.equal(routed("PATCH", "/api/suppliers/7", { name: "x" }), "reversible");
  assert.equal(routed("PATCH", "/api/suppliers/7", { iban: "NO16" }), "irreversible");
});

test("the routing guard still escalates when a destination IS present", () => {
  // The new path rule must not become the only protection: a body that names an account is still
  // caught on the routing axis, which is what covers PATCH and the paths this rule leaves alone.
  for (const field of ["bban", "bankAccountNumber"]) {
    assert.equal(
      classifyPaymentRouting("reversible", "/api/company-banks/7", { [field]: "15201353103" }, "PUT"),
      "irreversible",
      field,
    );
  }
});

test("a reai_request caller is told, since a 200 says nothing", () => {
  // The quirk is the only warning a raw caller gets, and this write SUCCEEDS — so nothing else
  // would tell them the account number is gone.
  for (const path of ["/api/company-banks/{id}", "/api/creditors/{id}"]) {
    const ids = quirksFor("PUT", path).map((q) => q.id);
    assert.ok(
      ids.includes("full-replacement-clears-a-payment-destination"),
      `${path} has no quirk about clearing a destination: ${ids.join(", ")}`,
    );
  }
  const note = quirksFor("PUT", "/api/company-banks/{id}").find(
    (q) => q.id === "full-replacement-clears-a-payment-destination",
  ).note;
  assert.match(note, /bban AND iban emptied/);
  assert.match(note, /defeats/);
});

/**
 * The same blindness on the OTHER presence-only axis, recorded rather than fixed.
 *
 * INVOICE_DELIVERY_FIELDS escalates a body that contains `invoiceEmail` exactly as the routing
 * rule escalates a destination — so it is equally blind to omission, and `PUT /api/orders/{id}`
 * and `PUT /api/subscriptions/{id}` are both full replacements carrying an optional
 * `invoiceEmail`, both reversible. Omitting it stops delivery rather than sending an invoice to
 * the wrong party, which is why this is named and not gated: making an ordinary order edit need
 * `full` is a large cost for a smaller harm, and that is a judgement worth being explicit about
 * rather than leaving the reader to infer the class was closed.
 */
test("the invoice-delivery axis has the same omission blindness, and it is known", async () => {
  const { invoiceDeliveryFields } = await import("../dist/policy.js");
  // Presence-only, like the routing rule — that is the shared shape.
  assert.deepEqual(invoiceDeliveryFields({ invoiceEmail: "a@b.invalid" }), ["invoiceEmail"]);
  assert.deepEqual(invoiceDeliveryFields({ name: "x" }), []);

  const index = getSpecIndex();
  const affected = [];
  for (const path of ["/api/orders/{id}", "/api/subscriptions/{id}"]) {
    const op = index.operations.find((o) => o.method === "PUT" && o.path === path);
    assert.ok(op, `${path} should be in the index`);
    const required = new Set(op.body?.required ?? []);
    if ("invoiceEmail" in (op.body?.fields ?? {}) && !required.has("invoiceEmail")) affected.push(path);
  }
  assert.deepEqual(
    affected.sort(),
    ["/api/orders/{id}", "/api/subscriptions/{id}"],
    "if this set changes, revisit the decision not to gate it",
  );
  // Stated as it stands today: reversible, so the default mode can drop a delivery address.
  for (const path of affected) assert.equal(classifyRequest("PUT", concrete(path)), "reversible");
});

/** Drives reai_request with a client that makes any HTTP attempt loud. */
async function raw(method, path, body, writeMode, extra = {}) {
  let called = false;
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode, allowExternalSend: false },
    session: {},
    client: {
      deepLink: () => "",
      request: async () => {
        called = true;
        return { data: { id: 7, name: "x" }, status: 200 };
      },
    },
  };
  try {
    const res = await rawRequest().handler({ method, path, body, ...extra }, ctx);
    return { called, text: res.content.map((c) => c.text).join("\n"), refused: res.isError === true };
  } catch (err) {
    return { called, text: err?.message ?? String(err), refused: true };
  }
}

test("the refusal says why THIS endpoint is irreversible, not what the class usually means", async () => {
  // "Operations in this class post to the general ledger, issue legal documents, run payroll" is
  // false of renaming a bank account, and the harm is directional: an agent told that asks its
  // operator for REAI_WRITE_MODE=full — which unlocks real ledger writes — when what the call
  // needed was to send the account number back.
  const r = await raw("PUT", "/api/company-banks/7", { name: "x" }, "reversible");
  assert.equal(r.refused, true);
  assert.equal(r.called, false);
  assert.match(r.text, /REPLACES the record/);
  assert.match(r.text, /send the missing fields rather than to raise the write mode/);

  // A path that IS in the class for the usual reasons must still read sensibly.
  const voucher = await raw("POST", "/api/vouchers", {}, "reversible");
  assert.equal(voucher.refused, true);
  assert.match(voucher.text, /classified "irreversible"/);
});

test("a SUCCESSFUL raw write carries the quirk, since a 200 is the only other signal", async () => {
  // quirksFor was consulted only when the request FAILED. That is right for notes explaining an
  // error and useless for the ones whose whole point is that the call succeeds and does something
  // unexpected — which is exactly this endpoint.
  //
  // clearOmittedFields is passed because the omission gate now refuses this body outright, which
  // is a better answer than a note on a completed clobber. The property under test here is the one
  // that still matters once a caller has deliberately acknowledged the clearing: the quirk has to
  // be attached to the SUCCESS, since the 200 is otherwise the only thing they see.
  const ok = await raw("PUT", "/api/company-banks/7", { name: "x" }, "full", {
    clearOmittedFields: true,
  });
  assert.equal(ok.called, true, "in full mode, with the clearing acknowledged, the write proceeds");
  assert.match(ok.text, /Known quirk/);
  assert.match(ok.text, /CLEARS it/);

  // A read cannot surprise anyone this way, so it stays quiet.
  const read = await raw("GET", "/api/company-banks/7", undefined, "full");
  assert.doesNotMatch(read.text, /Known quirk/);
});

// ---------------------------------------------------------------------------
// The same shape on addresses, where a curated tool now merges
// ---------------------------------------------------------------------------

async function setAddress(args, existing) {
  const calls = [];
  const tool = allTools.find((t) => t.name === "reai_set_customer_address");
  const result = await tool.handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => {
          calls.push(req);
          return { data: req.method === "GET" ? existing : { ok: true }, status: 200 };
        },
        deepLink: () => "",
      },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const STORED = {
  address: {
    addressPart1: "Gata 1",
    addressPart2: "Oppgang B",
    postalCode: "0150",
    city: "Oslo",
    province: "Oslo",
    countryCode: "NO",
  },
  deliveryAddress: { addressPart1: "Lager 9", city: "Bergen", countryCode: "NO" },
};

test("changing one part of an address keeps the others", async () => {
  const { calls, text } = await setAddress({ id: 7, addressPart1: "Gata 2" }, STORED);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"], "it must read before replacing");
  assert.deepEqual(calls[1].body, { ...STORED.address, addressPart1: "Gata 2" });
  // The measured loss: these three are not required, so a bare PUT empties them.
  assert.equal(calls[1].body.postalCode, "0150");
  assert.equal(calls[1].body.province, "Oslo");
  assert.equal(calls[1].body.addressPart2, "Oppgang B");
  assert.match(text, /read first and sent back/);
});

test("the delivery address is read from its own field, not the postal one", async () => {
  const { calls } = await setAddress({ id: 7, kind: "delivery", addressPart1: "Lager 10" }, STORED);
  assert.equal(calls[1].path, "/api/customers/7/delivery-address");
  assert.equal(calls[1].body.city, "Bergen", "merging the postal address in would move the warehouse to Oslo");
  assert.equal(calls[1].body.postalCode, undefined);
});

test("null clears a part deliberately, and undefined keeps it", async () => {
  const { calls } = await setAddress({ id: 7, province: null }, STORED);
  assert.equal(calls[1].body.province, null);
  assert.equal(calls[1].body.postalCode, "0150", "the parts not mentioned are untouched");
});

test("a change the API would reject for a missing required part is refused locally", async () => {
  // city is required and neither the change nor the stored address supplies it.
  const { calls, result, text } = await setAddress(
    { id: 7, addressPart1: "Gata 2" },
    { address: { addressPart1: "Gata 1", countryCode: "NO" } },
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.match(text, /requires city/);
});

test("an empty change set is refused rather than replacing the address with nothing", async () => {
  const { calls, result } = await setAddress({ id: 7 }, STORED);
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

// `?? {}` collapsed "no address yet" and "I could not read the response" into one, so a body
// that came back as text or with the key renamed produced an empty base — the PUT then sent the
// caller's fields alone, which is the wipe this tool exists to prevent, and the note claimed
// "Nothing else was set on it beforehand". reai_update_agreement refuses in this situation.
test("a read it cannot understand is refused, not treated as an empty address", async () => {
  const unreadable = [
    ["a text body", "Gata 1, 0150 Oslo"],
    ["an array", [{ address: { addressPart1: "Gata 1" } }]],
    ["an address that is not an object", { address: "Gata 1, 0150 Oslo" }],
  ];
  for (const [label, body] of unreadable) {
    // The change SATISFIES the required set on purpose. With an incomplete change the
    // missing-required check refuses anyway, so the test would pass with the fail-closed branch
    // removed — which is what a first version of it did.
    const { calls, result, text } = await setAddress(
      { id: 7, addressPart1: "Gata 2", city: "Oslo", countryCode: "NO" },
      body,
    );
    assert.equal(result.isError, true, label);
    assert.deepEqual(calls.map((c) => c.method), ["GET"], `${label}: nothing may be written`);
    assert.match(text, /Nothing was written/);
    assert.doesNotMatch(text, /Nothing else was set on it beforehand/, `${label}: must not claim the address was empty`);
  }
});

// The limit of the check above, stated rather than papered over: an `address` key that is ABSENT
// is read as "no address set yet". That is the right reading for the ordinary case — a customer
// created without one — and it is indistinguishable from the response having been renamed
// upstream, since both leave the key missing. So a rename would be treated as an empty address
// and the merge would have nothing to carry over. Nothing in the response can tell the two
// apart; what can is the tool's own note, which says plainly that nothing was set beforehand.
test("an absent address key is read as 'none yet', which is a limit and not a check", async () => {
  const { calls, text } = await setAddress(
    { id: 7, addressPart1: "Gata 1", city: "Oslo", countryCode: "NO" },
    { postalAddress: { addressPart1: "Ignored", city: "Bergen", countryCode: "NO" } },
  );
  assert.equal(calls[1].method, "PUT");
  assert.deepEqual(calls[1].body, { addressPart1: "Gata 1", city: "Oslo", countryCode: "NO" });
  assert.match(text, /Nothing else was set on it beforehand/, "the note is what makes this visible");
});

test("a customer with no address yet can still have one set", async () => {
  const { calls, text } = await setAddress(
    { id: 7, addressPart1: "Gata 1", city: "Oslo", countryCode: "NO" },
    { address: null },
  );
  assert.deepEqual(calls[1].body, { addressPart1: "Gata 1", city: "Oslo", countryCode: "NO" });
  assert.match(text, /Nothing else was set on it beforehand/);
});

test("only the parts this endpoint accepts are sent back", async () => {
  // The customer record carries more than the address request takes, and an unknown field is
  // refused outright ("Unknown field: ..."), so echoing the whole stored object would 400.
  const { calls } = await setAddress(
    { id: 7, addressPart1: "Gata 2" },
    { address: { ...STORED.address, id: 99, formatted: "Gata 1, 0150 Oslo", latitude: 59.9 } },
  );
  assert.deepEqual(
    Object.keys(calls[1].body).sort(),
    ["addressPart1", "addressPart2", "city", "countryCode", "postalCode", "province"],
    "an unknown field would be rejected by the API",
  );
});

// ---------------------------------------------------------------------------
// The omission gate: refuse a PUT that would clear what it does not mention
// ---------------------------------------------------------------------------
//
// Sixteen of the thirty-one replacement endpoints in this document have no curated tool, so they
// are reached through reai_request — which cannot merge on the caller's behalf. Every instance of
// this bug in this repo was found AFTER the write, on a live tenant, so the gate refuses rather
// than reports.

test("a PUT that omits documented optional fields is refused, naming them", async () => {
  const r = await raw("PUT", "/api/company-banks/7", { name: "Renamed AS" }, "full");
  assert.equal(r.called, false, "nothing may be sent");
  assert.match(r.text, /REPLACES the record, and this body leaves out/);
  assert.match(r.text, /bban/, "the account number is the field that matters here");
  assert.match(r.text, /Nothing was sent/);
  assert.match(r.text, /clearOmittedFields: true/);
  // And it points at the merge, which is the answer most of the time.
  assert.match(r.text, /GET the record first/);
});

test("the gate covers the replacement endpoints that have no curated tool", async () => {
  // These are the ones the curated set does not reach, so the hatch is the only route to them.
  for (const [path, field] of [
    ["/api/loans/7", "maturityDate"],
    ["/api/orders/7", "invoiceEmail"],
    ["/api/products/7", "description"],
    ["/api/offers/7", "comment"],
    ["/api/share-investments/7", "isin"],
  ]) {
    const r = await raw("PUT", path, { name: "x" }, "full");
    assert.equal(r.called, false, `${path} must not be sent`);
    assert.match(r.text, new RegExp(field), `${path} should name ${field}`);
  }
});

test("acknowledging the clearing lets the exact call through", async () => {
  const r = await raw("PUT", "/api/company-banks/7", { name: "x" }, "full", {
    clearOmittedFields: true,
  });
  assert.equal(r.called, true);
});

test("a complete body is not flagged, so the gate costs nothing when nothing is omitted", async () => {
  const index = getSpecIndex();
  const op = index.operations.find((o) => o.method === "PUT" && o.path === "/api/company-banks/{id}");
  const body = Object.fromEntries(Object.keys(op.body?.fields ?? {}).map((f) => [f, "x"]));
  const r = await raw("PUT", "/api/company-banks/7", body, "full");
  assert.equal(r.called, true, "every documented field was supplied");
});

test("PATCH is never flagged, because PATCH on this API really patches", async () => {
  // Measured: a PATCH carrying only `phone` left an employee's address, bank account, start date
  // and employment lines untouched. Gating PATCH would refuse ordinary partial updates.
  const r = await raw("PATCH", "/api/employees/7", { phone: "22334455" }, "full");
  assert.equal(r.called, true);
  assert.doesNotMatch(r.text, /REPLACES the record/);
});

test("a single-field PUT is not flagged, and neither is a body the gate cannot read", async () => {
  const rename = await raw("PUT", "/api/warehouses/7", { name: "x" }, "full");
  assert.equal(rename.called, true, "one required field, nothing optional to lose");

  // A malformed body is the API's to reject. Listing every documented field here would read as
  // this server's rule rather than as the body being the wrong shape.
  //
  // Asserted on a GATE-specific phrase, not on "REPLACES the record": that sentence also appears
  // in the company-bank quirk, which is attached to successful writes on this very path, so the
  // looser match passed for the wrong reason and then failed for the right one.
  for (const body of [undefined, "nope", [1, 2]]) {
    const r = await raw("PUT", "/api/company-banks/7", body, "full");
    assert.doesNotMatch(r.text, /Nothing was sent/, JSON.stringify(body ?? null));
    assert.equal(r.called, true, `${JSON.stringify(body ?? null)} is the API's to reject`);
  }
});

test("the write policy still speaks first when it would refuse anyway", async () => {
  // A call the write mode forbids must be refused for THAT reason: telling an agent to acknowledge
  // a field clearing, when the real answer is that this deployment does not permit the write at
  // all, sends it after the wrong permission.
  const r = await raw("PUT", "/api/company-banks/7", { name: "x" }, "read-only");
  assert.equal(r.refused, true);
  assert.equal(r.called, false);
  assert.doesNotMatch(r.text, /clearOmittedFields/);
});

test("a missing REQUIRED field is not the gate's business, and is not listed as omitted", async () => {
  // Required fields are excluded on purpose: the API rejects a body missing one, missingRequired
  // already explains that, and naming it here would bury the fields that get silently dropped —
  // which are the only ones a caller cannot find out about any other way.
  //
  // Every OPTIONAL field supplied, `name` (required) left out. The gate must stay silent and let
  // the API answer, and the refusal text must not mention the required field.
  const r = await raw(
    "PUT",
    "/api/company-banks/7",
    { countryCode: "NO", currency: "NOK", bban: "15201353103", swiftCode: "DNBANOKK", excludeFromReconciliationTodos: false },
    "full",
  );
  assert.equal(r.called, true, "a missing required field is the API's to reject");
  assert.doesNotMatch(r.text, /Nothing was sent/);
  assert.doesNotMatch(r.text, /leaves out 1 of its 6/);
});

test("the omitted list is exactly the optional fields, for a body that omits both kinds", async () => {
  // Directly on the helper, since through the tool the required-field case is indistinguishable
  // from the optional one in the refusal text.
  const op = resolveOperation("PUT", "/api/company-banks/7");
  const { fields, documented } = omittedReplacementFields(op, { currency: "NOK" });
  assert.equal(documented, 6);
  // name and countryCode are required and omitted; they must NOT appear.
  assert.deepEqual(fields.sort(), ["bban", "excludeFromReconciliationTodos", "swiftCode"]);
});
