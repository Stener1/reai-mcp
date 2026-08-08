import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { salesTools } from "../dist/tools/sales.js";
import { ReaiApiError } from "../dist/reai/errors.js";
import { classifyRequest } from "../dist/policy.js";

/**
 * Contact persons on a customer.
 *
 * Everything the tools claim was measured against the live API on tenant 2783 on 2026-08-08, and
 * every probe record was deleted afterwards. What is pinned here is the part a stub can hold: the
 * three refusals the API words in its own way (one of them in Norwegian), the empty-update case,
 * and the phone renormalisation report — because that last one is a claim about the caller's input
 * versus the stored value, and a tool that reports "normalised" when nothing changed is worse than
 * one that says nothing.
 */

const tool = (name) => {
  const found = salesTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, { data, error } = {}) {
  const calls = [];
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2783, ...args });
  const result = await tool(name).handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        if (error) throw error;
        return { data, status: 200 };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "reversible", defaultTenantId: 2783, allowExternalSend: false },
    session: {},
  });
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const apiError = (status, detail) =>
  new ReaiApiError({
    status,
    method: "POST",
    path: "/api/customers/1/contact-persons",
    rawBody: JSON.stringify({ detail }),
    problem: { detail, status, title: "Invalid request" },
  });

test("a private customer is refused in the API's own terms, and pointed somewhere useful", async () => {
  await assert.rejects(
    () =>
      run(
        "reai_create_customer_contact",
        { customerId: 6020, name: "Ada" },
        { error: apiError(400, "Contact persons can only be added to company customers") },
      ),
    (err) => {
      // The refusal has to say WHICH customer and WHAT to do instead. An agent that has just created
      // a private customer and tried to name someone on it hits this first, and "400 Invalid
      // request" would leave it guessing at the body.
      assert.match(err.message, /6020 is a private individual/);
      assert.match(err.message, /reai_update_customer/);
      return true;
    },
  );
});

test("the Norwegian phone refusal is translated, and says which forms are accepted", async () => {
  await assert.rejects(
    () =>
      run(
        "reai_create_customer_contact",
        { customerId: 1, name: "Ada", phone: "12345678" },
        {
          error: apiError(
            400,
            "Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +47.",
          ),
        },
      ),
    (err) => {
      assert.match(err.message, /bare \(90123456\)/);
      assert.match(err.message, /E\.164/);
      // And it keeps the API's own sentence, so a Norwegian-speaking operator sees what was said.
      assert.match(err.message, /Skriv inn et gyldig telefonnummer/);
      return true;
    },
  );
});

test("a 404 on the customer explains the one way a working contact id stops working", async () => {
  await assert.rejects(
    () =>
      run(
        "reai_list_customer_contacts",
        { customerId: 999999 },
        { error: apiError(404, "Customer with id=999999 not found.") },
      ),
    (err) => {
      assert.match(err.message, /999999 does not exist in this tenant/);
      // Measured: deleting a customer deletes its contacts, and the list then 404s rather than
      // returning []. That is the reason a previously-good contact id starts failing here.
      assert.match(err.message, /deleting a customer deletes/);
      return true;
    },
  );
});

test("the phone renormalisation is reported only when the stored value really differs", async () => {
  // Sent bare, stored as E.164 — say so, because the caller's value is not what is on the record.
  const normalised = await run(
    "reai_create_customer_contact",
    { customerId: 1, name: "Ada", phone: "90123456" },
    { data: { id: 21, name: "Ada", email: null, phone: "+4790123456" } },
  );
  assert.match(normalised.text, /stored as \+4790123456, normalised from 90123456/);

  // Sent already in E.164 — nothing was normalised, so claiming it was would be noise.
  const unchanged = await run(
    "reai_create_customer_contact",
    { customerId: 1, name: "Ada", phone: "+4790123456" },
    { data: { id: 22, name: "Ada", email: null, phone: "+4790123456" } },
  );
  assert.doesNotMatch(unchanged.text, /normalised/);

  // No phone at all — likewise.
  const none = await run(
    "reai_create_customer_contact",
    { customerId: 1, name: "Ada" },
    { data: { id: 23, name: "Ada", email: null, phone: null } },
  );
  assert.doesNotMatch(none.text, /normalised/);
});

test("an update with nothing to change is refused locally, and explains the blank-vs-omitted rule", async () => {
  const { calls, text } = await run("reai_update_customer_contact", {
    customerId: 1,
    contactPersonId: 21,
  });
  assert.deepEqual(calls, [], "an empty PATCH must not reach the API");
  // The API accepts `{}` and changes nothing, so a silent success would read as "done".
  assert.match(text, /Nothing to change/);
  // And the one rule that decides whether a field survives is stated where it is needed.
  assert.match(text, /CLEARS a field while omitting it leaves it alone/);
});

test("a cleared field is named in the note, so the caller sees which one went", async () => {
  const { calls, text } = await run(
    "reai_update_customer_contact",
    { customerId: 1, contactPersonId: 21, email: "" },
    { data: { id: 21, name: "Ada", email: null, phone: "+4790123456" } },
  );
  assert.deepEqual(calls[0].body, { email: "" }, "an empty string is the API's clear, so send it");
  assert.match(text, /Cleared: email/);
});

test("omitting a field does not send it, which is what leaves it unchanged", async () => {
  const { calls } = await run(
    "reai_update_customer_contact",
    { customerId: 1, contactPersonId: 21, name: "Ada Renamed" },
    { data: { id: 21, name: "Ada Renamed", email: "a@b.no", phone: null } },
  );
  // Measured: omitted and null both leave a field alone. Sending `email: undefined` would serialise
  // the key away anyway, but sending `email: ""` would CLEAR it — so the body must carry name only.
  assert.deepEqual(calls[0].body, { name: "Ada Renamed" });
});

test("deleting a contact that is already gone is reported as such, not as a failure", async () => {
  const { text } = await run(
    "reai_delete_customer_contact",
    { customerId: 1, contactPersonId: 21 },
    { error: apiError(404, "not found") },
  );
  // 204 the first time and 404 the second, measured. A 404 here means the caller's goal is met.
  assert.match(text, /already removed, or it never existed/);
  assert.match(text, /Nothing was changed/);
});

test("the contact writes classify no softer than the endpoints they call", () => {
  for (const name of [
    "reai_create_customer_contact",
    "reai_update_customer_contact",
    "reai_delete_customer_contact",
  ]) {
    const t = tool(name);
    assert.equal(t.risk, "reversible", `${name} should be reversible: a contact can be deleted again`);
    for (const [method, path] of t.apiPaths) {
      const concrete = path.replace(/\{[^}]+\}/g, "7");
      const fromPolicy = classifyRequest(method, concrete);
      assert.ok(
        fromPolicy === "reversible" || fromPolicy === "read",
        `${name}: ${method} ${concrete} classifies as ${fromPolicy}, so the tool would be offered in a mode that refuses it`,
      );
    }
  }
  // The delete carries the annotation a client asks on, since it removes a record.
  assert.equal(tool("reai_delete_customer_contact").destructive, true);
});

test("every contact tool declares the customer id as a positive integer", () => {
  // The path placeholder sweep in spec-bounds attributes `{id}` to `customerId` through the owning
  // segment; this pins the bound itself, since a 0 or a negative would build a nonsense path.
  for (const name of [
    "reai_list_customer_contacts",
    "reai_get_customer_contact",
    "reai_create_customer_contact",
    "reai_update_customer_contact",
    "reai_delete_customer_contact",
  ]) {
    const schema = z.object(tool(name).inputSchema);
    assert.throws(() => schema.parse({ customerId: 0, contactPersonId: 1, name: "x", tenantId: 2783 }));
    assert.throws(() => schema.parse({ customerId: -1, contactPersonId: 1, name: "x", tenantId: 2783 }));
  }
});
