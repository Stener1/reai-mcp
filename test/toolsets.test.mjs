import { test } from "node:test";
import assert from "node:assert/strict";
import { allTools, alwaysOnTools, selectTools, TOOL_GROUPS } from "../dist/server.js";
import { loadConfig, TOOLSETS } from "../dist/config.js";
import { classifyRequest } from "../dist/policy.js";
import { findOperation } from "../dist/reai/spec.js";

/**
 * The premise of this server is that 321 API operations cannot all be tools. As
 * the curated set grows the same pressure applies to it, so an operator can
 * narrow it — without ever losing reach, since discovery stays on.
 */

test("every curated tool belongs to exactly one group", () => {
  const grouped = Object.values(TOOL_GROUPS).flat();
  const names = grouped.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "a tool appears in two groups");
  assert.equal(allTools.length, alwaysOnTools.length + grouped.length);
});

test("group names match the documented toolset list", () => {
  assert.deepEqual(Object.keys(TOOL_GROUPS).sort(), [...TOOLSETS].sort());
});

test("no selection means everything", () => {
  assert.equal(selectTools([]).length, allTools.length);
});

test("selecting one group keeps it plus the always-on tools", () => {
  const only = selectTools(["bookkeeping"]);
  const names = new Set(only.map((t) => t.name));

  for (const t of alwaysOnTools) assert.ok(names.has(t.name), `${t.name} must always be present`);
  for (const t of TOOL_GROUPS.bookkeeping) assert.ok(names.has(t.name), `${t.name} missing`);
  for (const t of TOOL_GROUPS.sales) assert.ok(!names.has(t.name), `${t.name} should be excluded`);
  for (const t of TOOL_GROUPS.purchase) assert.ok(!names.has(t.name), `${t.name} should be excluded`);
});

test("orientation and the escape hatch are never groupable away", () => {
  const names = new Set(selectTools(["purchase"]).map((t) => t.name));
  for (const required of [
    "reai_whoami",
    "reai_use_tenant",
    "reai_search_endpoints",
    "reai_describe_endpoint",
    "reai_request",
  ]) {
    assert.ok(names.has(required), `${required} must survive any toolset selection`);
  }
});

test("selecting several groups unions them", () => {
  const two = selectTools(["sales", "purchase"]);
  assert.equal(
    two.length,
    alwaysOnTools.length + TOOL_GROUPS.sales.length + TOOL_GROUPS.purchase.length,
  );
});

test("REAI_TOOLSETS is parsed, normalized and validated", () => {
  assert.deepEqual(loadConfig({ REAI_USER_API_TOKEN: "t" }).toolsets, []);
  assert.deepEqual(
    loadConfig({ REAI_USER_API_TOKEN: "t", REAI_TOOLSETS: " Sales , PURCHASE " }).toolsets,
    ["sales", "purchase"],
  );
  assert.throws(
    () => loadConfig({ REAI_USER_API_TOKEN: "t", REAI_TOOLSETS: "sales,nope" }),
    /unknown group\(s\): nope/,
  );
});

test("tool names are unique and consistently prefixed", () => {
  const names = allTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  for (const n of names) assert.match(n, /^reai_[a-z0-9_]+$/, n);
});

test("every tool declares a risk the policy knows", () => {
  for (const t of allTools) {
    assert.ok(["read", "reversible", "irreversible"].includes(t.risk), `${t.name}: ${t.risk}`);
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.ok(t.title.length > 0, `${t.name} needs a title`);
  }
});

// --- The guard that matters most -------------------------------------------

test("no curated tool is more permissive than the escape hatch would be", () => {
  // The worst bug class in this codebase is a curated tool that quietly does
  // what reai_request refuses -- it would silently defeat REAI_WRITE_MODE. Each
  // tool declares the API paths it calls so this can be checked mechanically
  // rather than by eye, which is how the previous reviews had to do it.
  const rank = { read: 0, reversible: 1, irreversible: 2 };

  for (const tool of allTools) {
    if (!tool.apiPaths) continue;
    for (const [method, path] of tool.apiPaths) {
      // Substitute the template parameters, since classifyRequest sees concrete paths.
      const concrete = path.replace(/\{[^}]+\}/g, "1");
      const fromPolicy = classifyRequest(method, concrete);
      assert.ok(
        rank[tool.risk] >= rank[fromPolicy],
        `${tool.name} declares risk="${tool.risk}" but ${method} ${concrete} classifies as ` +
          `"${fromPolicy}" — the tool would be usable in a mode that forbids the same call ` +
          `through reai_request.`,
      );
    }
  }
});

test("every curated tool declares the API paths it calls", () => {
  // Not decoration: an undeclared tool silently opts out of the check above.
  const missing = allTools
    .filter((t) => !alwaysOnTools.includes(t) || t.name.startsWith("reai_whoami"))
    .filter((t) => !t.apiPaths)
    .map((t) => t.name);
  const exempt = new Set([
    // Discovery reads the bundled spec, or targets a path chosen at call time and
    // classified per-call inside the handler.
    "reai_search_endpoints",
    "reai_describe_endpoint",
    "reai_list_api_tags",
    "reai_api_notes",
    "reai_request",
    // Session-local state only; touches no API path of its own beyond /api/me.
    "reai_use_tenant",
  ]);
  const unexpected = missing.filter((n) => !exempt.has(n));
  assert.deepEqual(unexpected, [], `tools missing apiPaths: ${unexpected.join(", ")}`);
});

test("declared API paths exist in the OpenAPI spec", () => {
  // Catches a typo'd path, which would make the guard above check nothing.
  for (const tool of allTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      assert.ok(
        findOperation(method, path),
        `${tool.name} declares ${method} ${path}, which is not in the spec`,
      );
    }
  }
});

// Quirk vat-codes-tenant-specific warns that the unfiltered VAT-code list returns every
// code ReAI supports rather than the tenant's, so "booking one invents VAT that does not
// exist". Several tools take a vatCode and post to the ledger with it — and a
// reconciliation rule does so repeatedly and unattended — while pointing at
// reai_list_vat_codes.
//
// The first version of this test named two tools by hand and passed while
// reai_create_voucher, which accepts postings[].vatCode and is irreversible, had the
// identical gap. A test that lists its own subjects cannot enforce a rule; it walks the
// schemas now, nested fields included.
function vatCodeFields(schema, depth = 0, path = "") {
  if (!schema || depth > 6) return [];
  const def = schema._def ?? schema;
  const found = [];
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (shape) {
    for (const [key, value] of Object.entries(shape)) {
      const here = path ? `${path}.${key}` : key;
      if (/^vatcode$/i.test(key)) {
        found.push({ path: here, description: value._def?.description ?? value.description ?? "" });
      }
      found.push(...vatCodeFields(value, depth + 1, here));
    }
  }
  for (const key of ["innerType", "type", "schema", "element", "valueType"]) {
    if (def[key]) found.push(...vatCodeFields(def[key], depth + 1, path));
  }
  return found;
}

test("every ledger-booking tool that takes a vatCode carries the tenant-specific caveat", async () => {
  const { allTools } = await import("../dist/server.js");
  let checked = 0;
  for (const tool of allTools) {
    if (tool.risk !== "irreversible") continue;
    for (const [name, schema] of Object.entries(tool.inputSchema ?? {})) {
      const fields = /^vatcode$/i.test(name)
        ? [{ path: name, description: schema._def?.description ?? "" }, ...vatCodeFields(schema, 0, name)]
        : vatCodeFields(schema, 0, name);
      for (const field of fields) {
        checked += 1;
        assert.match(
          field.description,
          /not VAT-registered|THIS tenant|invents VAT/i,
          `${tool.name}.${field.path} takes a VAT code and books with it, but gives no caveat`,
        );
      }
    }
  }
  assert.ok(checked >= 3, `expected several booking tools with a vatCode, found ${checked}`);
});

// Issuing an invoice needs BOTH switches, and saying only "requires full" invites an
// operator to set full and wonder why the tool is still missing.
test("a transmitting tool names both switches it needs", async () => {
  const { allTools } = await import("../dist/server.js");
  for (const tool of allTools.filter((t) => t.transmits === true)) {
    assert.match(
      tool.description,
      /REAI_ALLOW_EXTERNAL_SEND/,
      `${tool.name} transmits but never mentions REAI_ALLOW_EXTERNAL_SEND`,
    );
  }
});

// The multi-tenant branch of reai_whoami had no guidance at all, because no token
// available during development reached more than one company — so the case this server
// exists to serve well was the one never exercised. The rules genuinely invert between
// token scopes: the tenant header goes from ignored to load-bearing.
test("reai_whoami explains the token scope it is actually looking at", async () => {
  const { allTools } = await import("../dist/server.js");
  const whoami = allTools.find((t) => t.name === "reai_whoami");
  const config = {
    baseUrl: "https://app.reai.no",
    writeMode: "reversible",
    timeoutMs: 5000,
    maxRetries: 0,
    verbose: false,
  };
  const ctxWith = (tenants) => ({
    client: { request: async () => ({ data: { email: "a@b.no", name: "A", tenants } }), deepLink: (_p, t) => `x/${t}` },
    config,
    session: {},
  });

  const single = (await whoami.handler({}, ctxWith([{ id: 2634, companyName: "One", currencyCode: "NOK" }])))
    .content[0].text;
  assert.match(single, /has been observed to\s+IGNORE the tenant header|observed to IGNORE/i);
  // Must NOT claim the token kind: a user-scoped token for a user with one company also
  // returns a one-element list, and /api/me has no field that tells them apart.
  assert.ok(!/TENANT-SCOPED/.test(single), `must not assert a token kind: ${single.slice(0, 200)}`);
  assert.match(single, /may be scoped to this one/i, "should still explain why one company appears");

  const many = (
    await whoami.handler(
      {},
      ctxWith([
        { id: 2634, companyName: "One", currencyCode: "NOK" },
        { id: 2783, companyName: "Two", currencyCode: "NOK" },
        { id: 9001, companyName: "Three", currencyCode: "EUR" },
      ]),
    )
  ).content[0].text;
  assert.match(many, /load-bearing/, "the header stops being ignored — say so");
  assert.ok(!/observed to IGNORE/i.test(many), "must not repeat the single-tenant caveat");
  assert.match(many, /do not share a currency \(NOK, EUR\)/);
  // Not every amount is in the company's currency — an invoice total is in the invoice's.
  assert.match(many, /read the currency on each result/i);

  const sameCurrency = (
    await whoami.handler(
      {},
      ctxWith([
        { id: 1, companyName: "A", currencyCode: "NOK" },
        { id: 2, companyName: "B", currencyCode: "NOK" },
      ]),
    )
  ).content[0].text;
  assert.ok(!/do not share a currency/.test(sameCurrency), "no warning when they agree");
});

// A grant bound at authorization time is a boundary on what may be ADDRESSED. /api/me
// returns every company the underlying ReAI token reaches, so reai_whoami handed the
// agent each client company's name, id, currency and deep link — while the README
// claimed the binding prevented exactly that. A boundary that leaks the thing it is
// meant to protect is not a boundary.
test("a bound connection discloses only the company it is bound to", async () => {
  const { allTools } = await import("../dist/server.js");
  const whoami = allTools.find((t) => t.name === "reai_whoami");
  const tenants = [
    { id: 2634, companyName: "Torstensen Digital", currencyCode: "NOK" },
    { id: 2783, companyName: "bedre standard", currencyCode: "NOK" },
    { id: 9001, companyName: "Client AS", currencyCode: "EUR" },
  ];
  const result = await whoami.handler(
    {},
    {
      client: { request: async () => ({ data: { email: "a@b.no", name: "A", tenants } }), deepLink: (_p, t) => `x/${t}` },
      config: {
        baseUrl: "https://app.reai.no",
        writeMode: "reversible",
        timeoutMs: 5000,
        maxRetries: 0,
        verbose: false,
        boundTenantId: 2783,
      },
      session: {},
    },
  );
  const [note, body] = result.content[0].text.split("\n\n");
  const parsed = JSON.parse(body);

  assert.deepEqual(parsed.tenants.map((t) => t.id), [2783], "only the bound company may be listed");
  const serialised = JSON.stringify(parsed);
  for (const leaked of ["Torstensen Digital", "Client AS", "2634", "9001"]) {
    assert.ok(!serialised.includes(leaked), `leaked ${leaked} on a bound connection`);
  }
  assert.match(note, /BOUND to tenant 2783/);
  // And it must not tell the agent to select a tenant, which is what binding forbids.
  assert.ok(!/load-bearing/.test(note), "selection guidance contradicts the binding");
  assert.match(note, /deliberately not listed/i, "say that others exist without naming them");
});
