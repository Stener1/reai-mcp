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

test("the phone refusal does not tell an agent to rewrite a foreign country code", async () => {
  // Codex's finding on PR #110, and it is right: the field is INTERNATIONAL. Measured — +46701234567,
  // +14155552671, +447911123456 and +4915112345678 are all accepted and stored exactly as sent — but
  // a malformed foreign number is refused with the same Norwegian sentence. The first translation read
  // that as "the number must be Norwegian and start with 4 or 9", which for a Swedish or American
  // contact points the agent at the one part of the number that was fine.
  await assert.rejects(
    () =>
      run(
        "reai_create_customer_contact",
        { customerId: 1, name: "Ada", phone: "+46123" },
        {
          error: apiError(
            400,
            "Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +47.",
          ),
        },
      ),
    (err) => {
      // Must not assert the number is Norwegian, or that it starts with 4 or 9.
      assert.doesNotMatch(err.message, /not a valid Norwegian number/);
      assert.doesNotMatch(err.message, /starts with 4 or 9/);
      // Foreign numbers work, with the evidence — which now travels in PHONE_RULE rather than being
      // paraphrased here, so the message and the constant cannot drift apart.
      assert.match(err.message, /\+46701234567/);
      assert.match(err.message, /do not "fix" a foreign number by changing its country code/);
      // Must explain that the Norwegian wording is not a signal about the number's country.
      assert.match(err.message, /worded in Norwegian whatever the number's country/);
      // And it keeps the API's own sentence, so a Norwegian-speaking operator sees what was said.
      assert.match(err.message, /Skriv inn et gyldig telefonnummer/);
      return true;
    },
  );
});

test("the bare-digits advice names the silent outcome, not just the refusal", async () => {
  // Codex's follow-up on PR #111, and the more dangerous half of the same fact. The fix for #111 said
  // "a bare foreign number is refused", which is categorical and wrong in the direction that costs
  // something: measured, the Danish mobile 40123456 is stored as +4740123456 with no warning, because
  // it is also valid Norwegian, while 20123456 is refused. A wrong number saved quietly beats a
  // rejection for harm — someone calls the wrong person — so the guidance has to lead with it.
  await assert.rejects(
    () =>
      run(
        "reai_create_customer_contact",
        { customerId: 1, name: "Ada", phone: "20123456" },
        {
          error: apiError(
            400,
            "Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +47.",
          ),
        },
      ),
    (err) => {
      // The categorical claim must be gone.
      assert.doesNotMatch(err.message, /a bare foreign number is refused/);
      // Both outcomes named, with the silent one called out as such. The wording lives in PHONE_RULE.
      assert.match(err.message, /with no warning/);
      assert.match(err.message, /40123456 became \+4740123456/);
      assert.match(err.message, /ALWAYS include the country code/);
      return true;
    },
  );
});

test("a missing CUSTOMER and a missing CONTACT are told apart, which they were not", async () => {
  // The bug this pins, found by the independent review of PR #110: the customer branch matched
  // /Customer with id=/i case-INSENSITIVELY, and the contact-not-found sentence is
  // "Contact person with id=22 not found for customer with id=6022" — which contains it. So the
  // commonest 404 on these endpoints was reported as "Customer N does not exist in this tenant",
  // about a customer that was fine.
  await assert.rejects(
    () =>
      run(
        "reai_list_customer_contacts",
        { customerId: 999999 },
        { error: apiError(404, "Customer with id=999999 not found.") },
      ),
    (err) => {
      assert.match(err.message, /999999 does not exist in this tenant/);
      return true;
    },
  );

  await assert.rejects(
    () =>
      run(
        "reai_get_customer_contact",
        { customerId: 6022, contactPersonId: 22 },
        {
          error: apiError(404, "Contact person with id=22 not found for customer with id=6022"),
        },
      ),
    (err) => {
      // Must NOT claim the customer is missing.
      assert.doesNotMatch(err.message, /does not exist in this tenant/);
      assert.match(err.message, /Contact person 22 is not on customer 6022/);
      // And it is genuinely ambiguous — measured, a deleted contact and a wrong-parent contact
      // answer with the identical sentence — so both readings are named.
      assert.match(err.message, /AMBIGUOUS/);
      assert.match(err.message, /belong to a DIFFERENT customer/);
      assert.match(err.message, /reai_list_customer_contacts/);
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

test("the delete's 404 is reported as the ambiguity it is, not as a job done", async () => {
  // The first version returned a flat success for ANY 404, which the review demonstrated is wrong:
  // DELETE /api/customers/<wrong>/contact-persons/<real id> answers 404 and the contact survives.
  // Measuring the wording then ruled out the obvious fix — a genuinely deleted contact answers the
  // SAME sentence as a wrong-parent one — so the tool reports both readings and how to settle it.
  const { text } = await run(
    "reai_delete_customer_contact",
    { customerId: 1, contactPersonId: 21 },
    { error: apiError(404, "Contact person with id=21 not found for customer with id=1") },
  );
  assert.match(text, /Nothing was changed/);
  assert.match(text, /AMBIGUOUS/);
  assert.match(text, /already removed \(or never existed\)/);
  assert.match(text, /belongs to a DIFFERENT customer/);
  assert.match(text, /reai_list_customer_contacts/);
});

test("but a nonexistent customer is not absorbed by the delete as success", async () => {
  // The 404 catch used to swallow this too, which made the customer translation dead code in this
  // tool — while the file's own comment claimed every tool reported the customer 404 distinctly.
  await assert.rejects(
    () =>
      run(
        "reai_delete_customer_contact",
        { customerId: 999999, contactPersonId: 21 },
        { error: apiError(404, "Customer with id=999999 not found.") },
      ),
    (err) => {
      assert.match(err.message, /Customer 999999 does not exist in this tenant/);
      return true;
    },
  );
});

test("every contact tool that can hit these errors is wired to the translator", async () => {
  // Two of the five had no behavioural test at all, so deleting their translateContactError call
  // changed nothing that failed. Each tool is checked through its own handler.
  const cases = [
    ["reai_list_customer_contacts", { customerId: 6022 }],
    ["reai_get_customer_contact", { customerId: 6022, contactPersonId: 22 }],
    ["reai_create_customer_contact", { customerId: 6022, name: "Ada" }],
    ["reai_update_customer_contact", { customerId: 6022, contactPersonId: 22, name: "Ada" }],
    ["reai_delete_customer_contact", { customerId: 6022, contactPersonId: 22 }],
  ];
  for (const [name, args] of cases) {
    await assert.rejects(
      () => run(name, args, { error: apiError(404, "Customer with id=6022 not found.") }),
      (err) => {
        assert.match(
          err.message,
          /Customer 6022 does not exist in this tenant/,
          `${name} does not translate the customer 404`,
        );
        return true;
      },
    );
  }
});

test("the private-customer refusal is gated on the status, not the phrase alone", async () => {
  // A phrase-only match turns a 500 carrying that sentence into a confident refusal about the
  // customer's type. toolsets.test.mjs pins exactly this for the reconciliation tools; there was no
  // analogue here, and removing the status gate broke nothing.
  const detail = "Contact persons can only be added to company customers";
  await assert.rejects(
    () => run("reai_create_customer_contact", { customerId: 1, name: "Ada" }, { error: apiError(400, detail) }),
    (err) => {
      assert.match(err.message, /is a private individual/);
      return true;
    },
  );
  await assert.rejects(
    () => run("reai_create_customer_contact", { customerId: 1, name: "Ada" }, { error: apiError(500, detail) }),
    (err) => {
      // A 500 must stay a 500: the write may have committed, and this repo treats a failed POST as
      // ambiguous rather than as a refusal.
      assert.doesNotMatch(err.message, /is a private individual/);
      return true;
    },
  );
});

test("a blank name is refused before the call, on create and on update", async () => {
  // The claim "a blank or whitespace-only one is refused" was unpinned on create: swapping
  // requiredName(75) for z.string().max(75) left the suite green.
  for (const [name, args] of [
    ["reai_create_customer_contact", { customerId: 1, name: "   " }],
    ["reai_update_customer_contact", { customerId: 1, contactPersonId: 2, name: "   " }],
  ]) {
    assert.throws(
      () => z.object(tool(name).inputSchema).parse({ tenantId: 2783, ...args }),
      `${name} accepted a whitespace-only name`,
    );
  }
});

test("null is accepted and stripped, which is what makes it mean unchanged", async () => {
  // Three descriptions promised null and the schema refused it, so an agent following them got
  // "Invalid arguments for tool". The API does accept null; it is stripped here so that null and
  // omitting take the same code path.
  const { calls } = await run(
    "reai_update_customer_contact",
    { customerId: 1, contactPersonId: 21, name: "Ada", email: null, phone: null },
    { data: { id: 21, name: "Ada", email: "kept@example.no", phone: "+4790123456" } },
  );
  assert.deepEqual(calls[0].body, { name: "Ada" }, "a null must not reach the API as a clear");
});

test("an empty email is accepted on create, because the API accepts it", async () => {
  // create used .email(), which refuses "" — while "" is the documented clear on the update. The two
  // tools disagreed about the same value, and create was stricter than both the spec and the API.
  const schema = z.object(tool("reai_create_customer_contact").inputSchema);
  assert.doesNotThrow(() => schema.parse({ customerId: 1, name: "Ada", email: "", tenantId: 2783 }));
  assert.throws(() => schema.parse({ customerId: 1, name: "Ada", email: "not-an-email", tenantId: 2783 }));
});

test("the empty list says which customer had none", async () => {
  const { text } = await run("reai_list_customer_contacts", { customerId: 6019 }, { data: [] });
  assert.match(text, /Customer 6019 has no contact persons recorded/);
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

/**
 * The phone rule, pinned structurally rather than by phrase.
 *
 * Three consecutive PRs got this text wrong in a new way each time — asserting Norwegian-only on an
 * international field, then that a bare foreign number is "refused" when the dangerous outcome is
 * silent acceptance, then that foreign numbers are "stored exactly as sent" when everything is
 * canonicalised. The reviews also showed why phrase assertions did not stop it: a `doesNotMatch` on
 * one sentence is satisfied by appending a contradicting one, and the earlier tests stubbed the error
 * so the input phone pinned nothing at all.
 *
 * So the guard is now that there is ONE source of truth and every phone-bearing argument uses it. A
 * contradiction then requires editing `PHONE_RULE` itself, where the measurements sit.
 */
test("every phone argument in the repo carries the one shared rule", async () => {
  const { PHONE_RULE } = await import("../dist/tools/registry.js");
  const { registeredTools } = await import("../dist/server.js");

  // The rule has to say the three things each wrong version got wrong.
  assert.match(PHONE_RULE, /canonicalised to E\.164/, "must not imply values are stored as sent");
  assert.match(PHONE_RULE, /ALWAYS include the country code/);
  assert.match(PHONE_RULE, /with no warning/, "the silent outcome is the one worth naming");
  assert.doesNotMatch(PHONE_RULE, /stored (exactly )?as sent/);
  assert.doesNotMatch(PHONE_RULE, /bare foreign number is refused/);

  const offenders = [];
  let checked = 0;
  for (const tool of registeredTools) {
    for (const [name, schema] of Object.entries(tool.inputSchema ?? {})) {
      // Only the fields that actually carry a phone NUMBER. `requirePhone` on the lead search is a
      // boolean filter, and `hasPhone` likewise — they say nothing about formatting.
      if (!/^(phone|mobile|phoneNumber)$/i.test(name)) continue;
      checked += 1;
      const description = schema?.description ?? "";
      if (!description.includes("canonicalised to E.164") && !description.includes("E.164")) {
        offenders.push(`${tool.name}.${name}`);
      }
    }
  }
  // A floor on the work, since a rename of the argument would otherwise empty this sweep silently.
  assert.ok(checked >= 4, `only ${checked} phone arguments found — the name filter has stopped matching`);
  assert.deepEqual(
    offenders,
    [],
    "these phone arguments describe the format in their own words instead of using PHONE_RULE",
  );
});

test("the phone refusal does not claim to know which country was resolved", async () => {
  // The previous version said the number was "refused, as here" because bare digits are read as
  // Norwegian — but the same 400 answers a number sent WITH a country code that is merely malformed,
  // which is the entire reason the international fix existed. Asserting the negative alone was not
  // enough (a contradicting sentence could be appended), so this also pins the positive claim.
  await assert.rejects(
    () =>
      run(
        "reai_create_customer_contact",
        { customerId: 1, name: "Ada", phone: "+46123" },
        {
          error: apiError(
            400,
            "Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +47.",
          ),
        },
      ),
    (err) => {
      assert.match(err.message, /does NOT tell you which country was resolved/);
      assert.doesNotMatch(err.message, /refused, as here/);
      // And the shared rule travels with it, so the advice cannot drift from the constant.
      assert.match(err.message, /ALWAYS include the country code/);
      return true;
    },
  );
});
