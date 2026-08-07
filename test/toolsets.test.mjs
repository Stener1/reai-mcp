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
// exist". Two tools take a vatCode and BOOK to the ledger with it — and a reconciliation
// rule does so repeatedly and unattended — while pointing at reai_list_vat_codes with no
// caveat at all. Documented, not surfaced where it bites.
test("tools that book with a vatCode warn that the code list is not tenant-specific", async () => {
  const { allTools } = await import("../dist/server.js");
  for (const name of ["reai_create_reconciliation_rule", "reai_book_bank_transactions"]) {
    const tool = allTools.find((t) => t.name === name);
    assert.ok(tool, `${name} not found`);
    const described = JSON.stringify(tool.inputSchema.vatCode?._def ?? {});
    const text = `${tool.description} ${described}`;
    assert.match(text, /not VAT-registered|THIS tenant|invents VAT/i, `${name} gives no caveat`);
  }
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
