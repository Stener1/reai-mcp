import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { leadTools } from "../dist/tools/leads.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest, classifyTransmission } from "../dist/policy.js";
import { quirksFor } from "../dist/reai/quirks.js";

const tool = (name) => {
  const found = leadTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, data) {
  const calls = [];
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2634, ...args });
  const result = await tool(name).handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        return { data, status: 200 };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "read-only", tenantId: 2634, allowExternalSend: false },
    session: {},
  });
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const row = (o = {}) => ({
  id: null,
  orgNumber: "938225605",
  companyName: "AARSKOG ELEKTRO HOLDING AS",
  city: "FITJAR",
  hasAccountant: false,
  hasEmail: true,
  hasPhone: false,
  status: null,
  ...o,
});
const page = (items, o = {}) => ({ items, page: 1, hasPrevious: false, hasNext: true, ...o });

test("both lead tools are reads, and neither can contact anybody", () => {
  const registered = new Set(registeredTools.map((t) => t.name));
  for (const name of ["reai_search_leads", "reai_get_lead"]) {
    assert.ok(registered.has(name), name);
    assert.equal(tool(name).risk, "read");
    for (const [method, path] of tool(name).apiPaths) {
      assert.equal(method, "GET");
      assert.equal(classifyRequest("GET", path.replace("{orgNumber}", "1")), "read");
    }
  }
  // Placing a call is a separate endpoint, and it stays classified as an external send.
  assert.equal(classifyTransmission("POST", "/lead/company/938225605/phone-call", undefined), "external");
});

test("the search says how many rows it got and never invents a total", async () => {
  const { text } = await run("reai_search_leads", { pageSize: 5 }, page([row(), row({ orgNumber: "2" })]));
  assert.match(text, /2 row\(s\) on page 1, and there are more/);
  assert.match(text, /no total, so how many match altogether is not something this call can say/);
});

test("the last page is reported as the last page", async () => {
  const { text } = await run("reai_search_leads", {}, page([row()], { hasNext: false }));
  assert.match(text, /this is the last page/);
});

// Most results are register entries nobody has touched, and they have no id — the reason the get
// tool is addressed by organisation number.
test("unsaved register entries are counted and explained", async () => {
  const { text } = await run(
    "reai_search_leads",
    {},
    page([row(), row({ id: 55, orgNumber: "2", status: "active" })]),
  );
  assert.match(text, /1 of them are UNSAVED register entries/);
  assert.match(text, /addressed by orgNumber, not by id/);
  assert.match(text, /leadFilter: "saved"/);
});

test("a page of saved leads says nothing about unsaved ones", async () => {
  const { text } = await run("reai_search_leads", { leadFilter: "saved" }, page([row({ id: 55, status: "active" })]));
  assert.ok(!/UNSAVED/.test(text));
});

test("the register flags are attributed to the register, not to this tenant", async () => {
  const { text } = await run(
    "reai_search_leads",
    {},
    page([row(), row({ orgNumber: "2", hasAccountant: true, hasEmail: false })]),
  );
  assert.match(text, /1 of these have no accountant registered in Brreg/);
  assert.match(text, /come from the register, not from this tenant/);
});

test("a response without items is unknown, not empty", async () => {
  // For a prospecting question, "no companies match" invented from a shape surprise is a confidently
  // wrong answer about the whole register.
  for (const data of [null, {}, { content: [] }, "nope"]) {
    const { text } = await run("reai_search_leads", {}, data);
    assert.match(text, /UNKNOWN/, JSON.stringify(data));
    assert.match(text, /do not read that as none/);
  }
});

test("an empty items array is reported as empty", async () => {
  const { text } = await run("reai_search_leads", {}, page([], { hasNext: false }));
  assert.match(text, /0 row\(s\)/);
  assert.ok(!/UNKNOWN/.test(text));
});

test("pageSize is bounded locally, because the API's refusal names no field", () => {
  const shape = tool("reai_search_leads").inputSchema;
  assert.equal(shape.pageSize.safeParse(200).success, true);
  assert.equal(shape.pageSize.safeParse(201).success, false);
  assert.match(shape.pageSize.safeParse(500).error.issues[0].message, /Validation failed/);
});

test("the get tool takes an organisation number and validates its shape", async () => {
  const shape = tool("reai_get_lead").inputSchema;
  assert.equal(shape.orgNumber.safeParse("938225605").success, true);
  for (const bad of ["93822560", "9382256050", "abcdefghi", ""]) {
    assert.equal(shape.orgNumber.safeParse(bad).success, false, bad);
  }
  const { calls } = await run("reai_get_lead", { orgNumber: "938225605" }, row());
  assert.deepEqual(calls.map((c) => c.path), ["/api/leads/org/938225605"]);
});

test("the get tool distinguishes a saved lead from a bare register entry", async () => {
  const unsaved = await run("reai_get_lead", { orgNumber: "938225605" }, row());
  assert.match(unsaved.text, /a register entry with NO lead state/);
  assert.match(unsaved.text, /Brreg lists no accountant/);

  const saved = await run(
    "reai_get_lead",
    { orgNumber: "938225605" },
    row({ id: 55, status: "active", followUpAt: "2026-09-01", hasAccountant: true }),
  );
  assert.match(saved.text, /a SAVED lead, id 55, status "active", follow-up 2026-09-01/);
  assert.match(saved.text, /Brreg lists an accountant/);
});

test("the quirk carries the register/records distinction and both traps", () => {
  const q = quirksFor("GET", "/api/leads").find(
    (x) => x.id === "leads-are-the-company-register-not-your-records",
  );
  assert.ok(q);
  assert.match(q.note, /not a list of records the tenant owns/);
  assert.match(q.note, /Failed to convert/);
  assert.match(q.note, /no\s+TOTAL/);
  assert.match(q.note, /Validation failed/);
  // EXACT, not descendants: this note is about the collection's envelope and pageSize, neither of
  // which the detail endpoints have. Attached to descendants it gave confident, wrong response
  // guidance for them.
  const detail = quirksFor("GET", "/api/leads/org/{orgNumber}").map((x) => x.id);
  assert.ok(!detail.includes("leads-are-the-company-register-not-your-records"));
  assert.ok(detail.includes("lead-detail-nests-what-the-search-flattens"));
});

// The P1 from review, and the reason it survived my own test: I mocked the flattened SEARCH row for
// a DETAIL response. LeadRes nests lead state under `lead`, so reading the top level reported every
// saved lead as untouched — coincidentally right for an untouched company, wrong for a worked one.
test("the get tool reads lead state from the nested `lead` object", async () => {
  const saved = await run("reai_get_lead", { orgNumber: "938225605" }, {
    orgNumber: "938225605",
    companyName: "AARSKOG ELEKTRO HOLDING AS",
    city: "FITJAR",
    hasAccountant: true,
    lead: { id: 55, status: "active", followUpAt: "2026-09-01", convertedCustomerId: null },
    contactEvents: [],
  });
  assert.match(saved.text, /a SAVED lead, id 55, status "active", follow-up 2026-09-01/);
  assert.ok(!/NO lead state/.test(saved.text));

  // An untouched company still RETURNS the object, with every field null — measured live.
  const untouched = await run("reai_get_lead", { orgNumber: "938225605" }, {
    orgNumber: "938225605",
    companyName: "AARSKOG ELEKTRO HOLDING AS",
    lead: { id: null, status: null, notes: null, followUpAt: null },
    contactEvents: [],
  });
  assert.match(untouched.text, /NO lead state on this tenant — its lead.id is null/);

  // A converted lead names the customer it became.
  const converted = await run("reai_get_lead", { orgNumber: "938225605" }, {
    orgNumber: "938225605",
    lead: { id: 55, status: "converted", convertedCustomerId: 4242 },
  });
  assert.match(converted.text, /already converted to customer 4242/);
});

test("and still works if a response ever arrives flattened", async () => {
  // The search row shape, kept as a fallback rather than assumed impossible — two endpoints in one
  // domain already disagree, so a third shape is not unthinkable.
  const { text } = await run("reai_get_lead", { orgNumber: "938225605" }, {
    orgNumber: "938225605",
    id: 55,
    status: "active",
  });
  assert.match(text, /a SAVED lead, id 55/);
});

test("the documented query-parameter maxima are enforced locally", () => {
  // Kept after test/spec-bounds.test.mjs grew a query sweep of its own: that one proves every
  // parameter agrees with the spec, this one pins the four values a reader would otherwise have to
  // regenerate the index to see.
  const shape = tool("reai_search_leads").inputSchema;
  for (const [field, cap] of [["query", 200], ["legalFormCode", 500], ["industryCodePrefix", 500], ["city", 1000]]) {
    assert.equal(shape[field].safeParse("x".repeat(cap)).success, true, `${field} at ${cap}`);
    assert.equal(shape[field].safeParse("x".repeat(cap + 1)).success, false, `${field} over ${cap}`);
  }
});

/**
 * Lead writes.
 *
 * The fake below is not a stub that returns 200: it is the measured behaviour of the live endpoints,
 * which is the only reason these tests can fail for the right reason. Two rules matter, both taken
 * from tenant 2783:
 *
 *   - PATCH ignores null. Collapsing reai_update_lead into "one PATCH with everything" therefore
 *     leaves the fields the caller asked to clear exactly as they were, and the assertions here
 *     catch that instead of watching a mocked 200 go by.
 *   - PUT .../contact does not create the lead. A tool that writes contact details to an unsaved
 *     company gets a 200 and stores nothing, so the fake keeps the id null for that one call.
 *
 * PUT .../status is deliberately NOT modelled. Status is routed through PATCH, so nothing should ever
 * call it, and the fake's unknown-path throw is a stronger guard than a model would be: route status
 * there by mistake and every test using this fake fails loudly.
 */
const ORG = "938225605";

function fakeLead(initial = {}) {
  const state = {
    id: null,
    status: null,
    notes: null,
    email: null,
    phone: null,
    followUpAt: null,
    convertedCustomerId: null,
    convertedAt: null,
    ...initial,
  };
  const calls = [];
  let nextId = 53797;
  const materialise = () => {
    if (state.id === null) state.id = nextId++;
  };
  const client = {
    deepLink: () => "link",
    request: async (req) => {
      calls.push(req);
      const { method, path, body } = req;
      if (method === "GET") {
        return { data: { orgNumber: ORG, companyName: "AARSKOG ELEKTRO HOLDING AS", lead: { ...state } }, status: 200 };
      }
      if (method === "POST" && path === "/api/leads") {
        materialise();
        return { data: {}, status: 200 };
      }
      if (method === "PATCH") {
        materialise();
        // Null LEAVES THE VALUE ALONE. This is the whole trap.
        for (const [k, v] of Object.entries(body ?? {})) if (v !== null && v !== undefined) state[k] = v;
        return { data: {}, status: 200 };
      }
      if (method === "PUT" && path.endsWith("/notes")) {
        materialise();
        state.notes = body?.notes ?? null;
        return { data: {}, status: 200 };
      }
      if (method === "PUT" && path.endsWith("/follow-up")) {
        materialise();
        state.followUpAt = body?.followUpAt ?? null;
        return { data: {}, status: 200 };
      }
      if (method === "PUT" && path.endsWith("/contact")) {
        // A single-key body is rejected outright rather than modelled, because the live endpoint
        // does not have one behaviour for it: measured as a total no-op in isolation, and as a full
        // replacement that cleared the omitted field when sent after the other setters. Neither
        // reading is safe to build on, so sending one is the defect.
        const keys = Object.keys(body ?? {});
        if (keys.length !== 2 || !keys.includes("email") || !keys.includes("phone")) {
          throw new Error(`single-key contact write: ${JSON.stringify(body)}`);
        }
        // Deliberately NOT materialised: measured, this answers 200 against an unsaved company,
        // leaves lead.id null, and stores nothing.
        if (state.id !== null) for (const k of ["email", "phone"]) state[k] = body[k];
        return { data: {}, status: 200 };
      }
      if (method === "POST" && path.endsWith("/contact-events")) {
        materialise();
        return { data: { id: 66150 }, status: 200 };
      }
      if (method === "POST" && path.endsWith("/convert")) {
        materialise();
        state.convertedCustomerId ??= 5983;
        state.status = "converted";
        return { data: { orgNumber: ORG, companyName: "AARSKOG ELEKTRO HOLDING AS" }, status: 200 };
      }
      if (method === "DELETE") {
        for (const k of Object.keys(state)) state[k] = null;
        return { data: {}, status: 200 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { state, calls, client };
}

async function runLive(name, args, fake) {
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2783, ...args });
  const result = await tool(name).handler(validated, {
    client: fake.client,
    config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
    session: {},
  });
  return { result, text: result.content.find((c) => c.type === "text").text };
}

test("every lead write is classified no more permissively than the escape hatch would be", () => {
  const registered = new Set(registeredTools.map((t) => t.name));
  for (const name of [
    "reai_save_lead",
    "reai_update_lead",
    "reai_log_lead_contact",
    "reai_convert_lead",
    "reai_delete_lead",
  ]) {
    assert.ok(registered.has(name), name);
    assert.equal(tool(name).risk, "reversible");
    for (const [method, path] of tool(name).apiPaths) {
      const concrete = path.replace("{orgNumber}", ORG).replace("{id}", "1");
      assert.equal(classifyRequest(method, concrete), "reversible", `${method} ${concrete}`);
      // A lead write must never look like an external send. The body is the interesting part: these
      // tools carry an email address and a phone number, which is exactly the shape that earns an
      // external classification elsewhere in this API, so the bodyless call proves little on its own.
      for (const body of [undefined, { email: "someone@example.com", phone: "+4740000000" }]) {
        assert.notEqual(
          classifyTransmission(method, concrete, body),
          "external",
          `${method} ${concrete} with ${JSON.stringify(body)}`,
        );
      }
    }
  }
  assert.equal(tool("reai_delete_lead").destructive, true);
});

test("reai_update_lead clears through the setters, because PATCH cannot", async () => {
  const fake = fakeLead({ id: 700, status: "active", notes: "keep me", email: "a@b.no", phone: "+4740000000", followUpAt: "2026-09-01" });
  const { text } = await runLive(
    "reai_update_lead",
    { orgNumber: ORG, notes: null, followUpAt: null, phone: null, email: "new@b.no" },
    fake,
  );
  // The end state is what matters: against the measured PATCH semantics, a single PATCH carrying
  // these nulls would have left all three values in place.
  assert.equal(fake.state.notes, null, "notes should be cleared");
  assert.equal(fake.state.followUpAt, null, "follow-up should be cleared");
  assert.equal(fake.state.phone, null, "phone should be cleared");
  assert.equal(fake.state.email, "new@b.no", "email set in the same call");
  assert.equal(fake.state.status, "active", "status was not mentioned, so it must not move");

  // And no null was sent through PATCH, where it would have been silently ignored.
  for (const c of fake.calls.filter((c) => c.method === "PATCH")) {
    assert.ok(
      !Object.values(c.body ?? {}).includes(null),
      `PATCH carried a null, which does nothing: ${JSON.stringify(c.body)}`,
    );
  }
  assert.match(text, /PUT \.\.\.\/notes with null to clear the notes/);
  assert.match(text, /PUT \.\.\.\/contact with email set and phone cleared/);
});

test("reai_update_lead sends the values it is setting in a single PATCH", async () => {
  const fake = fakeLead({ id: 700 });
  await runLive(
    "reai_update_lead",
    { orgNumber: ORG, status: "disqualified", notes: "no budget", followUpAt: "2026-12-01" },
    fake,
  );
  const patches = fake.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1, "three set fields should not cost three calls");
  assert.deepEqual(patches[0].body, { status: "disqualified", notes: "no budget", followUpAt: "2026-12-01" });
  assert.equal(fake.calls.filter((c) => c.method === "PUT").length, 0, "nothing was being cleared");
  assert.equal(fake.state.status, "disqualified");
  assert.equal(fake.state.notes, "no budget");
});

test("reai_update_lead saves an unsaved company before writing contact details to it", async () => {
  const fake = fakeLead(); // id null: a register company nobody has touched
  const { text } = await runLive("reai_update_lead", { orgNumber: ORG, email: "new@b.no" }, fake);
  // Without the save, PUT /contact answers 200 and stores nothing — the failure this guards.
  assert.notEqual(fake.state.id, null, "the lead must exist before contact details are written");
  assert.equal(fake.state.email, "new@b.no", "the email must actually land");
  const order = fake.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  assert.equal(order[0], "POST /api/leads", `expected the save first, got ${JSON.stringify(order)}`);
  assert.match(text, /this CREATED lead/);
  assert.match(text, /silently stores nothing on an unsaved company/);
});

test("reai_update_lead refuses to clear a status, and says why, before calling anything", async () => {
  const fake = fakeLead({ id: 700, status: "disqualified" });
  const { result, text } = await runLive("reai_update_lead", { orgNumber: ORG, status: null }, fake);
  assert.equal(result.isError, true);
  assert.equal(fake.calls.length, 0, "nothing should be sent for a request that cannot succeed");
  assert.match(text, /cannot be cleared/);
  assert.match(text, /Validation failed/);
  assert.match(text, /reai_delete_lead/);
  assert.equal(fake.state.status, "disqualified");
});

test("reai_update_lead refuses a call with nothing in it", async () => {
  const fake = fakeLead({ id: 700 });
  const { result, text } = await runLive("reai_update_lead", { orgNumber: ORG }, fake);
  assert.equal(result.isError, true);
  assert.equal(fake.calls.length, 0);
  assert.match(text, /reai_save_lead/);
});

test("reai_save_lead reads the id back and does not write over an existing lead", async () => {
  const fresh = fakeLead();
  const first = await runLive("reai_save_lead", { orgNumber: ORG }, fresh);
  assert.match(first.text, /is now a saved lead, id 53797/);

  const already = fakeLead({ id: 700, status: "active" });
  const second = await runLive("reai_save_lead", { orgNumber: ORG }, already);
  assert.match(second.text, /ALREADY a saved lead/);
  assert.equal(already.calls.filter((c) => c.method === "POST").length, 0, "nothing to write");
});

test("reai_save_lead does not claim success when the row still reads null", async () => {
  const stuck = fakeLead();
  // A POST that answers 200 and creates nothing is the shape PUT /contact actually has, so it is
  // not hypothetical for this domain.
  stuck.client.request = async (req) => {
    if (req.method === "GET") {
      return { data: { orgNumber: ORG, companyName: "X", lead: { id: null } }, status: 200 };
    }
    return { data: {}, status: 200 };
  };
  const { text } = await runLive("reai_save_lead", { orgNumber: ORG }, stuck);
  assert.match(text, /still reads id null/);
  assert.match(text, /Do not treat this company as tracked/);
});

test("reai_log_lead_contact records the event and warns that it cannot be taken back", async () => {
  const fake = fakeLead();
  const { text } = await runLive(
    "reai_log_lead_contact",
    { orgNumber: ORG, contactedOn: "2026-08-08", source: "phone", note: "left a message" },
    fake,
  );
  assert.match(text, /Logged phone contact/);
  assert.match(text, /as event 66150/);
  assert.match(text, /also created the lead/);
  assert.match(text, /cannot be removed on its own/);
  assert.equal(tool("reai_log_lead_contact").inputSchema.note.safeParse("x".repeat(181)).success, false);
});

test("reai_convert_lead saves first, converts by id, and reports the customer", async () => {
  const fake = fakeLead();
  const { text } = await runLive("reai_convert_lead", { orgNumber: ORG }, fake);
  const writes = fake.calls.filter((c) => c.method === "POST").map((c) => c.path);
  assert.deepEqual(writes, ["/api/leads", "/api/leads/53797/convert"], "id-only endpoint needs the save first");
  // Not a second reading of the same deepEqual: this one is about the path SHAPE, and it is the
  // property that survives if the ids or the call order ever change legitimately.
  assert.ok(
    writes.every((p) => !p.includes("/org/")),
    `convert has no /org/{orgNumber} form — it answers 404 — but got ${JSON.stringify(writes)}`,
  );
  assert.match(text, /is now customer 5983/);
  assert.match(text, /saved first/);
});

test("reai_convert_lead does not call convert again on an already-converted lead", async () => {
  const fake = fakeLead({ id: 700, status: "converted", convertedCustomerId: 4242, convertedAt: "2026-08-01" });
  const { text } = await runLive("reai_convert_lead", { orgNumber: ORG }, fake);
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0);
  assert.match(text, /already converted to customer 4242 on 2026-08-01/);
});

test("reai_convert_lead does not claim a customer the lead does not name", async () => {
  const fake = fakeLead({ id: 700 });
  // A 200 whose convertedCustomerId never appears: the convert response is the company record, so
  // there is nothing in it to mistake for proof.
  const original = fake.client.request;
  fake.client.request = async (req) =>
    req.method === "POST" && req.path.endsWith("/convert")
      ? { data: { orgNumber: ORG }, status: 200 }
      : original(req);
  const { text } = await runLive("reai_convert_lead", { orgNumber: ORG }, fake);
  assert.match(text, /NOT established that a customer was created/);
  assert.match(text, /reai_list_customers/);
});

test("reai_delete_lead says what is unrecoverable and what survives", async () => {
  const converted = fakeLead({ id: 700, notes: "long history", convertedCustomerId: 4242 });
  const { text } = await runLive("reai_delete_lead", { orgNumber: ORG }, converted);
  assert.match(text, /Lead 700 .* is gone, along with its notes and contact events/s);
  assert.match(text, /Customer 4242,.*still exists/s);
  assert.match(text, /lead\.id null/);

  const untouched = fakeLead();
  const skipped = await runLive("reai_delete_lead", { orgNumber: ORG }, untouched);
  assert.equal(untouched.calls.filter((c) => c.method === "DELETE").length, 0);
  assert.match(skipped.text, /nothing to delete/);
});

test("reai_delete_lead reports a DELETE that did not take", async () => {
  const stubborn = fakeLead({ id: 700 });
  stubborn.client.request = async (req) => ({
    data: req.method === "GET" ? { orgNumber: ORG, companyName: "X", lead: { id: 700 } } : {},
    status: 200,
  });
  const { text } = await runLive("reai_delete_lead", { orgNumber: ORG }, stubborn);
  assert.match(text, /still reads lead id 700/);
  assert.match(text, /was NOT removed/);
});

test("the lead quirks reach the endpoints they describe, and not the reads", () => {
  const ids = (m, p) => quirksFor(m, p).map((q) => q.id);
  assert.ok(ids("PATCH", "/api/leads/org/{orgNumber}").includes("lead-patch-cannot-clear-a-field-only-the-put-setters-can"));
  assert.ok(ids("PUT", "/api/leads/org/{orgNumber}/status").includes("lead-status-cannot-be-unset-once-set"));
  assert.ok(ids("PUT", "/api/leads/org/{orgNumber}/contact").includes("lead-contact-put-needs-both-fields-in-the-body"));
  assert.ok(ids("POST", "/api/leads/{id}/convert").includes("lead-convert-is-addressable-by-id-only"));
  for (const path of ["/api/leads/org/{orgNumber}/contact", "/api/leads/org/{orgNumber}/notes"]) {
    assert.ok(
      ids("PUT", path).includes("lead-rows-are-created-by-the-first-write-except-contact"),
      path,
    );
  }
  // The creation quirk is about writes. A GET cannot create a lead, so it must not appear on one.
  assert.ok(!ids("GET", "/api/leads").includes("lead-rows-are-created-by-the-first-write-except-contact"));
  assert.ok(!ids("GET", "/api/leads/org/{orgNumber}").includes("lead-patch-cannot-clear-a-field-only-the-put-setters-can"));
});

test("the null-clearing quirk names both halves, and the contact quirk says to send both fields", () => {
  const patch = quirksFor("PATCH", "/api/leads/org/{orgNumber}").find(
    (q) => q.id === "lead-patch-cannot-clear-a-field-only-the-put-setters-can",
  );
  assert.match(patch.note, /leave unchanged/);
  assert.match(patch.note, /PUT \.\.\.\/notes/);
  assert.match(patch.note, /reai_update_lead/);

  const contact = quirksFor("PUT", "/api/leads/org/{orgNumber}/contact").find(
    (q) => q.id === "lead-contact-put-needs-both-fields-in-the-body",
  );
  assert.match(contact.note, /Send email AND phone every time/);
  // Both observations, so nobody "simplifies" the guidance back to one of them.
  assert.match(contact.note, /no-op in 4 of 4 trials/);
  assert.match(contact.note, /full replacement/);
  assert.match(contact.note, /reai_update_lead/);

  const creation = quirksFor("PUT", "/api/leads/org/{orgNumber}/contact").find(
    (q) => q.id === "lead-rows-are-created-by-the-first-write-except-contact",
  );
  assert.match(creation.note, /stored nowhere/);
  assert.match(creation.note, /POST \/api\/leads first/);
});

test("reai_update_lead carries the contact field it is not changing, never sending one alone", async () => {
  const fake = fakeLead({ id: 700, email: "keep@b.no", phone: "+4740000000" });
  const { text } = await runLive("reai_update_lead", { orgNumber: ORG, phone: "41000000" }, fake);
  const contact = fake.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/contact"));
  assert.equal(contact.length, 1);
  // Both keys, with the untouched email carried over at its current value. The fake throws on a
  // single-key body, so a regression fails here even before the state assertions.
  assert.deepEqual(contact[0].body, { email: "keep@b.no", phone: "41000000" });
  assert.equal(fake.state.email, "keep@b.no", "the email must survive a phone-only request");
  assert.match(text, /email carried over unchanged/);
});

test("reai_update_lead carries a null contact field as null, not as absent", async () => {
  // The carried value comes from the lead, so an empty one has to be sent explicitly — dropping it
  // would put the tool back to a single-key body.
  const fake = fakeLead({ id: 700, email: null, phone: null });
  await runLive("reai_update_lead", { orgNumber: ORG, email: "first@b.no" }, fake);
  const contact = fake.calls.find((c) => c.path.endsWith("/contact"));
  assert.deepEqual(contact.body, { email: "first@b.no", phone: null });
});

test("reai_update_lead does not create a lead in order to empty it", async () => {
  // Clearing on a company with no lead state: the end state the caller wants is already the actual
  // one, and the alternative is a POST /api/leads that produces state in response to a request to
  // remove state.
  const fake = fakeLead();
  const { result, text } = await runLive("reai_update_lead", { orgNumber: ORG, notes: null, followUpAt: null }, fake);
  assert.notEqual(result.isError, true, "this is an answer, not a failure");
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, 0, "nothing should be written");
  assert.equal(fake.state.id, null, "no lead should have been created");
  assert.match(text, /already empty/);

  // But a SET on the same untouched company still creates it, which is the point of the tool.
  const setting = fakeLead();
  await runLive("reai_update_lead", { orgNumber: ORG, notes: null, status: "active" }, setting);
  assert.notEqual(setting.state.id, null, "a set alongside a clear must still create the lead");
  assert.equal(setting.state.status, "active");
});

test("a verified non-outcome is an error, not just prose", async () => {
  // Every one of these branches detects that the API did not do what it reported. Prose alone is
  // what an agent skims past, so the result carries isError too — following
  // reai_update_company_bank, and not fail(), because the body is the evidence for the claim.
  const silent = (state) => {
    const fake = fakeLead(state);
    fake.client.request = async (req) => ({
      data: req.method === "GET" ? { orgNumber: ORG, companyName: "X", lead: { ...state } } : {},
      status: 200,
    });
    return fake;
  };

  const saved = await runLive("reai_save_lead", { orgNumber: ORG }, silent({ id: null }));
  assert.equal(saved.result.isError, true, "a POST that saved nothing");

  const deleted = await runLive("reai_delete_lead", { orgNumber: ORG }, silent({ id: 700 }));
  assert.equal(deleted.result.isError, true, "a DELETE that removed nothing");

  const converted = await runLive("reai_convert_lead", { orgNumber: ORG }, silent({ id: 700 }));
  assert.equal(converted.result.isError, true, "a convert that produced no customer");

  // And the successful paths must NOT be errors, or the flag says nothing.
  const fine = await runLive("reai_save_lead", { orgNumber: ORG }, fakeLead());
  assert.notEqual(fine.result.isError, true);
});

test("reai_update_lead checks the end state it was asked for and reports what did not take", async () => {
  // The API answered 200 and stored nothing at least once in this domain, so the tool compares the
  // readback against the request instead of echoing the intent.
  const fake = fakeLead({ id: 700 });
  const original = fake.client.request;
  fake.client.request = async (req) => {
    // A PATCH that accepts the notes and quietly drops them: exactly the shape measured elsewhere.
    if (req.method === "PATCH") return { data: {}, status: 200 };
    return original(req);
  };
  const { result, text } = await runLive("reai_update_lead", { orgNumber: ORG, notes: "please keep" }, fake);
  assert.equal(result.isError, true);
  assert.match(text, /THE WRITE DID NOT FULLY TAKE/);
  assert.match(text, /notes: asked for "please keep", reads null/);

  // A phone is compared loosely, because ReAI normalises it — an exact comparison would report
  // every successful phone write as a failure.
  const normalising = fakeLead({ id: 700 });
  const inner = normalising.client.request;
  normalising.client.request = async (req) => {
    const res = await inner(req);
    if (req.method === "PUT" && req.path.endsWith("/contact")) normalising.state.phone = "+4740000000";
    return res;
  };
  const ok2 = await runLive("reai_update_lead", { orgNumber: ORG, phone: "40000000" }, normalising);
  assert.notEqual(ok2.result.isError, true, "normalisation is not a mismatch");
  assert.ok(!/DID NOT FULLY TAKE/.test(ok2.text));

  // But a phone that vanished IS one.
  const dropping = fakeLead({ id: 700 });
  const inner2 = dropping.client.request;
  dropping.client.request = async (req) => {
    const res = await inner2(req);
    if (req.method === "PUT" && req.path.endsWith("/contact")) dropping.state.phone = null;
    return res;
  };
  const bad = await runLive("reai_update_lead", { orgNumber: ORG, phone: "40000000" }, dropping);
  assert.equal(bad.result.isError, true);
  assert.match(bad.text, /phone: asked for "40000000", reads null/);
});

/**
 * Why reai_log_lead_contact stays `reversible`, deliberately.
 *
 * Review argued for `irreversible`, on the grounds that a contact event has no DELETE of its own and
 * the only remedy destroys the whole lead. The premise is right and the tool says so. The conclusion
 * does not follow, for three reasons:
 *
 *  1. `irreversible` in this codebase names a specific class — writes that touch the ledger, issue a
 *     legal document, move money, run payroll, file with the tax authority, or administer access. A
 *     CRM annotation is none of them, and diluting the label weakens the one signal an operator
 *     configures their deployment on.
 *  2. Unremovable RESIDUE is already normal under `reversible`. reai_delete_customer archives rather
 *     than deletes as soon as the customer has transactions, and an archived counterparty cannot be
 *     removed at all afterwards — the test tenant carries several, permanently. If unremovability
 *     alone earned escalation, most of the master-data tools would qualify.
 *  3. classifyRequest says `reversible` for POST /api/leads/{id}/contact-events, so escalating only
 *     the curated tool would hide the safe path while leaving the same call available through
 *     reai_request. That moves the ceiling without moving the risk.
 *
 * Pinned as a test so the decision cannot be reversed silently, in either direction: change the
 * reasoning here first, then the classification.
 */
test("logging a contact event is reversible-class, and the reason is the description's job", () => {
  const logTool = tool("reai_log_lead_contact");
  assert.equal(logTool.risk, "reversible");
  assert.equal(classifyRequest("POST", "/api/leads/1/contact-events"), "reversible");
  // The tool and the escape hatch must agree, which is the third argument above.
  assert.equal(logTool.risk, classifyRequest("POST", "/api/leads/1/contact-events"));
  // And the part that is actionable has to be stated where a caller reads it.
  assert.match(logTool.description, /no endpoint that removes a contact event/);
  assert.match(logTool.description, /reai_delete_lead/);
  assert.match(logTool.description, /every other event/);
});

test("a value the API rewrites is reported as rewritten, not as a failed write", async () => {
  // Review's finding, and it was mine to fix: comparing byte-for-byte turned three ordinary server
  // behaviours into "the write did not take". None of them is a failure — reai_create_customer
  // already documents this API title-casing a stored name, so rewriting is the norm here, not the
  // exception. Only "asked to clear it, still set" and "asked to set it, reads null" can be failures.
  for (const [label, sent, stored] of [
    ["a trimmed note", { notes: "Called them " }, { notes: "Called them" }],
    ["a lower-cased email", { email: "Zz@Example.INVALID" }, { email: "zz@example.invalid" }],
    ["a date returned as a timestamp", { followUpAt: "2026-12-01" }, { followUpAt: "2026-12-01T00:00:00" }],
    ["a normalised phone", { phone: "40000000" }, { phone: "+4740000000" }],
  ]) {
    const fake = fakeLead({ id: 700 });
    const inner = fake.client.request;
    fake.client.request = async (req) => {
      const res = await inner(req);
      if (req.method !== "GET") Object.assign(fake.state, stored);
      return res;
    };
    const { result, text } = await runLive("reai_update_lead", { orgNumber: ORG, ...sent }, fake);
    assert.notEqual(result.isError, true, `${label} must not be an error`);
    assert.ok(!/DID NOT FULLY TAKE/.test(text), label);
    assert.match(text, /Stored, but not exactly as sent/, label);
  }
});

test("reai_update_lead does not report success against a lead that still reads id null", async () => {
  // The tool's own headline hazard, inside the tool built to prevent it: a POST /api/leads that
  // answers 200 without creating the row. Every named field then reads back as asked -- because
  // nothing was stored anywhere -- so only checking the fields would have called this a success and
  // printed "CREATED lead null".
  const fake = fakeLead();
  fake.client.request = async (req) => ({
    data: req.method === "GET" ? { orgNumber: ORG, companyName: "X", lead: { id: null } } : {},
    status: 200,
  });
  const { result, text } = await runLive("reai_update_lead", { orgNumber: ORG, email: "x@y.no" }, fake);
  assert.equal(result.isError, true);
  assert.match(text, /still reads id null/);
  assert.match(text, /reai_save_lead/);
});

test("an empty note clears, because the endpoint documents empty as a clear", async () => {
  // UpdateLeadNotesReq: "Null or empty clears the notes". PATCH cannot clear at all, so routing ""
  // through it would store an empty note where the caller asked for none.
  const fake = fakeLead({ id: 700, notes: "something" });
  await runLive("reai_update_lead", { orgNumber: ORG, notes: "" }, fake);
  assert.equal(fake.state.notes, null, "an empty note must clear, not store an empty string");
  const patches = fake.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 0, "nothing was being set, so there is no PATCH to make");
  assert.ok(fake.calls.some((c) => c.path.endsWith("/notes")), "it goes to the clearing setter");
});

test("readLeadState carries every field when a response arrives flattened", async () => {
  // The fallback never fires against today's API. If it ever does, dropping email and phone would
  // make the contact carry-over send null for a field the caller never mentioned.
  const fake = fakeLead({ id: 700 });
  fake.client.request = async (req) => {
    fake.calls.push(req);
    if (req.method === "GET") {
      // No `lead` object: the shape the search rows use.
      return {
        data: { orgNumber: ORG, companyName: "X", id: 700, status: "active", email: "keep@b.no", phone: "+4740000000" },
        status: 200,
      };
    }
    return { data: {}, status: 200 };
  };
  await runLive("reai_update_lead", { orgNumber: ORG, notes: "hello" }, fake);
  const contact = fake.calls.find((c) => c.path.endsWith("/contact"));
  assert.equal(contact, undefined, "no contact field was mentioned, so no contact call");

  // And when one IS mentioned, the untouched neighbour comes from the flattened fields.
  const second = fakeLead({ id: 700 });
  second.client.request = async (req) => {
    second.calls.push(req);
    return req.method === "GET"
      ? { data: { orgNumber: ORG, companyName: "X", id: 700, email: "keep@b.no", phone: "+4740000000" }, status: 200 }
      : { data: {}, status: 200 };
  };
  await runLive("reai_update_lead", { orgNumber: ORG, email: "new@b.no" }, second);
  const call = second.calls.find((c) => c.path.endsWith("/contact"));
  assert.deepEqual(call.body, { email: "new@b.no", phone: "+4740000000" });
});
