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
  // These are QUERY parameters, which test/spec-bounds.test.mjs does not sweep — it walks write
  // bodies — so this class of mismatch was invisible to it and had to be caught by reading.
  const shape = tool("reai_search_leads").inputSchema;
  for (const [field, cap] of [["query", 200], ["legalFormCode", 500], ["industryCodePrefix", 500], ["city", 1000]]) {
    assert.equal(shape[field].safeParse("x".repeat(cap)).success, true, `${field} at ${cap}`);
    assert.equal(shape[field].safeParse("x".repeat(cap + 1)).success, false, `${field} over ${cap}`);
  }
});
