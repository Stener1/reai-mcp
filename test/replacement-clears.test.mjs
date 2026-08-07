import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRequest, classifyPaymentRouting, paymentRoutingFieldNames } from "../dist/policy.js";
import { getSpecIndex } from "../dist/reai/spec.js";
import { quirksFor } from "../dist/reai/quirks.js";
import { allTools } from "../dist/server.js";

/**
 * A full-replacement write that CARRIES a payment destination can erase it by omission.
 *
 * Found by sweeping the document for the shape that bit on agreements — a PUT with no PATCH
 * sibling — and then asking which of them the payment-routing guard cannot see. That guard
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
    // The index marks an optional field with a trailing "?"; anything else is required.
    const clearable = destinations.filter((d) => String(fields[d]).endsWith("?"));
    out.push({ path: op.path, destinations, clearable });
  }
  return out;
}

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

test("creating either record stays reversible, because adding diverts nothing", () => {
  // The whole class is about REPLACING. A company bank is already exempted from routing
  // escalation on POST for the same reason, and gating creation would make adding an account
  // need `full` for no gain.
  assert.equal(classifyRequest("POST", "/api/company-banks"), "reversible");
  assert.equal(classifyRequest("POST", "/api/creditors"), "reversible");
  assert.equal(classifyRequest("PUT", "/api/company-banks/7"), "irreversible");
  assert.equal(classifyRequest("PUT", "/api/creditors/7"), "irreversible");
  // And the rule must not spread to neighbours that carry no destination.
  assert.equal(classifyRequest("PUT", "/api/debtors/7"), "reversible");
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
